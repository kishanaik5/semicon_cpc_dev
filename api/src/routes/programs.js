import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES } from '../constants.js';
import { pool } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';
import { audit } from '../utils/audit.js';

const router = Router();

/* ---------- Referral programs ---------- */
const ReferralSchema = z.object({
  name: z.string().min(1),
  referrer_offer_id: z.coerce.number().int().optional().nullable(),
  referee_offer_id: z.coerce.number().int().optional().nullable(),
  referrer_reward_trigger: z.enum(['SIGNUP', 'FIRST_PURCHASE']).default('FIRST_PURCHASE'),
  coupon_validity_days: z.coerce.number().int().positive().default(30),
  max_referrals_per_user: z.coerce.number().int().positive().optional().nullable(),
  is_active: z.boolean().default(true),
});

router.get('/referral', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, o1.name AS referrer_offer_name, o2.name AS referee_offer_name,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.program_id = p.id) AS referrals,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.program_id = p.id AND r.status = 'CONVERTED') AS conversions
       FROM referral_programs p
       LEFT JOIN offers o1 ON o1.id = p.referrer_offer_id
       LEFT JOIN offers o2 ON o2.id = p.referee_offer_id
      ORDER BY p.id DESC`,
  );
  res.json(rows);
}));

router.post('/referral', wrap(async (req, res) => {
  const d = ReferralSchema.parse(req.body);
  if (d.is_active) await pool.query(`UPDATE referral_programs SET is_active = FALSE WHERE is_active`);
  const { rows } = await pool.query(
    `INSERT INTO referral_programs (name, referrer_offer_id, referee_offer_id, referrer_reward_trigger, coupon_validity_days, max_referrals_per_user, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.name, d.referrer_offer_id ?? null, d.referee_offer_id ?? null, d.referrer_reward_trigger, d.coupon_validity_days, d.max_referrals_per_user ?? null, d.is_active],
  );
  await audit(pool, { entityType: 'referral_program', entityId: rows[0].id, action: 'CREATED', actor: 'admin', details: d });
  res.status(201).json(rows[0]);
}));

router.patch('/referral/:id', wrap(async (req, res) => {
  const d = ReferralSchema.partial().parse(req.body);
  if (d.is_active === true) await pool.query(`UPDATE referral_programs SET is_active = FALSE WHERE is_active AND id <> $1`, [req.params.id]);
  const { rows: cur } = await pool.query(`SELECT * FROM referral_programs WHERE id = $1`, [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Program not found' } });
  const m = { ...cur[0], ...d };
  const { rows } = await pool.query(
    `UPDATE referral_programs SET name=$2, referrer_offer_id=$3, referee_offer_id=$4, referrer_reward_trigger=$5,
            coupon_validity_days=$6, max_referrals_per_user=$7, is_active=$8, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, m.name, m.referrer_offer_id ?? null, m.referee_offer_id ?? null, m.referrer_reward_trigger,
     m.coupon_validity_days, m.max_referrals_per_user ?? null, m.is_active],
  );
  await audit(pool, { entityType: 'referral_program', entityId: req.params.id, action: 'UPDATED', actor: 'admin', details: d });
  res.json(rows[0]);
}));

router.get('/referral/activity', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.created_at, r.converted_at,
            u1.email AS referrer_email, u2.email AS referee_email,
            c1.code AS referrer_coupon, c1.status AS referrer_coupon_status,
            c2.code AS referee_coupon, c2.status AS referee_coupon_status
       FROM referrals r
       JOIN users u1 ON u1.id = r.referrer_id JOIN users u2 ON u2.id = r.referee_id
       LEFT JOIN coupons c1 ON c1.id = r.referrer_coupon_id
       LEFT JOIN coupons c2 ON c2.id = r.referee_coupon_id
      ORDER BY r.id DESC LIMIT 200`,
  );
  res.json(rows);
}));

/* ---------- Signup coupon configs ---------- */
const SignupSchema = z.object({
  name: z.string().min(1),
  offer_id: z.coerce.number().int(),
  validity_days: z.coerce.number().int().positive().default(30),
  first_purchase_only: z.boolean().default(true),
  account_type: z.enum(ACCOUNT_TYPES).optional().nullable(),
  is_active: z.boolean().default(true),
});

router.get('/signup', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, o.name AS offer_name,
            (SELECT COUNT(*)::int FROM coupons c WHERE c.coupon_type='SIGNUP' AND (c.metadata->>'configId')::bigint = s.id) AS issued,
            (SELECT COUNT(*)::int FROM coupons c WHERE c.coupon_type='SIGNUP' AND (c.metadata->>'configId')::bigint = s.id AND c.usage_count > 0) AS redeemed
       FROM signup_coupon_configs s JOIN offers o ON o.id = s.offer_id ORDER BY s.id DESC`,
  );
  res.json(rows);
}));

router.post('/signup', wrap(async (req, res) => {
  const d = SignupSchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO signup_coupon_configs (name, offer_id, validity_days, first_purchase_only, account_type, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.name, d.offer_id, d.validity_days, d.first_purchase_only, d.account_type ?? null, d.is_active],
  );
  await audit(pool, { entityType: 'signup_config', entityId: rows[0].id, action: 'CREATED', actor: 'admin', details: d });
  res.status(201).json(rows[0]);
}));

router.patch('/signup/:id', wrap(async (req, res) => {
  const d = SignupSchema.partial().parse(req.body);
  const { rows: cur } = await pool.query(`SELECT * FROM signup_coupon_configs WHERE id = $1`, [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Config not found' } });
  const m = { ...cur[0], ...d };
  const { rows } = await pool.query(
    `UPDATE signup_coupon_configs SET name=$2, offer_id=$3, validity_days=$4, first_purchase_only=$5, account_type=$6, is_active=$7, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [req.params.id, m.name, m.offer_id, m.validity_days, m.first_purchase_only, m.account_type ?? null, m.is_active],
  );
  await audit(pool, { entityType: 'signup_config', entityId: req.params.id, action: 'UPDATED', actor: 'admin', details: d });
  res.json(rows[0]);
}));

export default router;
