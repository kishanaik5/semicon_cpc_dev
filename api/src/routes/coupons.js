import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES } from '../constants.js';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';
import { audit } from '../utils/audit.js';
import { normalizeCode, uniqueCode, randomPin } from '../utils/codes.js';
import { describeOffer } from '../services/benefit.js';

const router = Router();

const dateOpt = z.union([z.string().datetime({ offset: true }), z.string().min(1), z.null()]).optional()
  .transform((v) => (v ? new Date(v) : null));

const Common = {
  offer_id: z.coerce.number().int(),
  description: z.string().optional().nullable(),
  valid_from: dateOpt,
  valid_until: dateOpt,
  account_type: z.enum(ACCOUNT_TYPES).optional().nullable(),
};

/* ---------- List / search ---------- */
router.get('/', wrap(async (req, res) => {
  const { type, status, q, user_id, batch_id, limit = 100, offset = 0 } = req.query;
  const where = []; const params = [];
  if (type) { params.push(type); where.push(`c.coupon_type = $${params.length}`); }
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  if (user_id) { params.push(user_id); where.push(`c.assigned_user_id = $${params.length}`); }
  if (batch_id) { params.push(batch_id); where.push(`c.batch_id = $${params.length}`); }
  if (q) { params.push(`%${normalizeCode(q)}%`); where.push(`c.code LIKE $${params.length}`); }
  params.push(Math.min(Number(limit), 500)); params.push(Number(offset));
  const { rows } = await pool.query(
    `SELECT c.id, c.code, c.coupon_type, c.description, c.valid_from, c.valid_until, c.global_usage_limit,
            c.per_user_limit, c.usage_count, c.assigned_user_id, c.account_type, c.first_purchase_only, c.batch_id,
            c.status, c.created_at, (c.pin_hash IS NOT NULL) AS has_pin, c.pin_locked_until,
            o.name AS offer_name, o.benefit_type, o.value, o.max_discount, u.email AS assigned_user_email,
            (SELECT COUNT(*)::int FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions
       FROM coupons c JOIN offers o ON o.id = c.offer_id LEFT JOIN users u ON u.id = c.assigned_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM coupons c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params.slice(0, -2),
  );
  res.json({ total: cnt[0].total, items: rows.map((r) => ({ ...r, offer_summary: describeOffer(r) })) });
}));

router.get('/batches', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, o.name AS offer_name,
            (SELECT COUNT(*)::int FROM coupons c WHERE c.batch_id = b.id AND c.usage_count > 0) AS redeemed
       FROM coupon_batches b JOIN offers o ON o.id = b.offer_id ORDER BY b.id DESC`,
  );
  res.json(rows);
}));

router.get('/batches/:id/codes', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT code, status, usage_count FROM coupons WHERE batch_id = $1 ORDER BY id`, [req.params.id],
  );
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${req.params.id}.csv"`);
    return res.send('code,status,usage_count\n' + rows.map((r) => `${r.code},${r.status},${r.usage_count}`).join('\n'));
  }
  res.json(rows);
}));

/* ---------- 1. Fixed coupon code ---------- */
router.post('/fixed', wrap(async (req, res) => {
  const d = z.object({
    ...Common,
    code: z.string().min(3).max(40),
    global_usage_limit: z.coerce.number().int().positive().optional().nullable(),
    per_user_limit: z.coerce.number().int().positive().optional().nullable(),
    first_purchase_only: z.boolean().optional().default(false),
  }).parse(req.body);
  const code = normalizeCode(d.code);
  const { rows } = await pool.query(
    `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_from, valid_until, global_usage_limit,
                          per_user_limit, account_type, first_purchase_only, created_by)
     VALUES ($1,'FIXED',$2,$3,COALESCE($4, now()),$5,$6,$7,$8,$9,'admin') RETURNING *`,
    [code, d.offer_id, d.description ?? null, d.valid_from, d.valid_until, d.global_usage_limit ?? null,
     d.per_user_limit ?? 1, d.account_type ?? null, d.first_purchase_only],
  );
  await audit(pool, { entityType: 'coupon', entityId: rows[0].id, action: 'CREATED', actor: 'admin', details: { code, type: 'FIXED', ...d } });
  res.status(201).json(rows[0]);
}));

/* ---------- 2. One-time unique codes (batch) ---------- */
router.post('/unique-batch', wrap(async (req, res) => {
  const d = z.object({
    ...Common,
    name: z.string().min(1),
    quantity: z.coerce.number().int().min(1).max(10000),
    prefix: z.string().max(8).optional().nullable(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: brow } = await client.query(
      `INSERT INTO coupon_batches (name, offer_id, quantity, prefix, valid_from, valid_until, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6,'admin') RETURNING *`,
      [d.name, d.offer_id, d.quantity, d.prefix ?? null, d.valid_from, d.valid_until],
    );
    const batch = brow[0];
    const codes = new Set();
    while (codes.size < d.quantity) codes.add(uniqueCode(d.prefix ?? ''));
    const arr = [...codes];
    // Bulk insert via unnest
    await client.query(
      `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_from, valid_until, global_usage_limit,
                            per_user_limit, account_type, batch_id, created_by)
       SELECT unnest($1::text[]), 'UNIQUE', $2, $3, $4, $5, 1, 1, $6, $7, 'admin'`,
      [arr, d.offer_id, d.description ?? d.name, batch.valid_from, d.valid_until, d.account_type ?? null, batch.id],
    );
    await audit(client, { entityType: 'coupon_batch', entityId: batch.id, action: 'CREATED', actor: 'admin', details: { name: d.name, quantity: d.quantity } });
    return { batch, codes: arr };
  });
  res.status(201).json(result);
}));

/* ---------- 3. User-specific one-time coupon with PIN ---------- */
router.post('/user-pin', wrap(async (req, res) => {
  const d = z.object({
    ...Common,
    user_id: z.coerce.number().int(),
    pin: z.string().regex(/^\d{4,8}$/).optional(),
    first_purchase_only: z.boolean().optional().default(false),
  }).parse(req.body);
  const { rows: urow } = await pool.query(`SELECT id, email FROM users WHERE id = $1`, [d.user_id]);
  if (!urow[0]) return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });

  const pin = d.pin || randomPin(6);
  const pinHash = await bcrypt.hash(pin, 10);
  const code = uniqueCode('VIP');
  const { rows } = await pool.query(
    `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_from, valid_until, global_usage_limit,
                          per_user_limit, assigned_user_id, pin_hash, first_purchase_only, created_by)
     VALUES ($1,'USER_PIN',$2,$3,COALESCE($4, now()),$5,1,1,$6,$7,$8,'admin') RETURNING id, code, valid_until`,
    [code, d.offer_id, d.description ?? 'Personal coupon', d.valid_from, d.valid_until, d.user_id, pinHash, d.first_purchase_only],
  );
  await audit(pool, { entityType: 'coupon', entityId: rows[0].id, action: 'CREATED', actor: 'admin', details: { code, type: 'USER_PIN', userId: d.user_id } });
  // PIN is returned exactly once; only the hash is stored.
  res.status(201).json({ ...rows[0], user: urow[0], pin });
}));

/* ---------- Status management ---------- */
router.patch('/:id/status', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).parse(req.body);
  const { rows } = await pool.query(
    `UPDATE coupons SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, code, status`, [req.params.id, status],
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
  await audit(pool, { entityType: 'coupon', entityId: rows[0].id, action: status === 'DISABLED' ? 'DISABLED' : 'ENABLED', actor: 'admin', details: { code: rows[0].code } });
  res.json(rows[0]);
}));

router.post('/:id/unlock-pin', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE coupons SET pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING id, code`,
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
  await audit(pool, { entityType: 'coupon', entityId: rows[0].id, action: 'PIN_UNLOCKED', actor: 'admin' });
  res.json(rows[0]);
}));

router.get('/:id/redemptions', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.email, o.order_ref FROM coupon_redemptions r
       JOIN users u ON u.id = r.user_id JOIN orders o ON o.id = r.order_id
      WHERE r.coupon_id = $1 ORDER BY r.redeemed_at DESC`, [req.params.id],
  );
  res.json(rows);
}));

export default router;
