import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';
import { audit } from '../utils/audit.js';
import { describeOffer } from '../services/benefit.js';

const router = Router();

const OfferSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  benefit_type: z.enum(['PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'EXTRA_HOURS', 'AI_CREDITS', 'CUSTOM']),
  value: z.coerce.number().min(0).default(0),
  max_discount: z.coerce.number().min(0).optional().nullable(),
  min_order_amount: z.coerce.number().min(0).default(0),
  config: z.record(z.any()).optional().default({}),
  is_active: z.boolean().optional().default(true),
});

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, (SELECT COUNT(*)::int FROM coupons c WHERE c.offer_id = o.id) AS coupon_count
       FROM offers o ORDER BY o.id DESC`,
  );
  res.json(rows.map((o) => ({ ...o, summary: describeOffer(o) })));
}));

router.post('/', wrap(async (req, res) => {
  const d = OfferSchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO offers (name, description, benefit_type, value, max_discount, min_order_amount, config, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [d.name, d.description ?? null, d.benefit_type, d.value, d.max_discount ?? null, d.min_order_amount, JSON.stringify(d.config), d.is_active],
  );
  await audit(pool, { entityType: 'offer', entityId: rows[0].id, action: 'CREATED', actor: 'admin', details: d });
  res.status(201).json({ ...rows[0], summary: describeOffer(rows[0]) });
}));

router.put('/:id', wrap(async (req, res) => {
  const d = OfferSchema.partial().parse(req.body);
  const { rows: cur } = await pool.query(`SELECT * FROM offers WHERE id = $1`, [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Offer not found' } });
  const m = { ...cur[0], ...d };
  const { rows } = await pool.query(
    `UPDATE offers SET name=$2, description=$3, benefit_type=$4, value=$5, max_discount=$6, min_order_amount=$7,
            config=$8, is_active=$9, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, m.name, m.description ?? null, m.benefit_type, m.value, m.max_discount ?? null, m.min_order_amount,
     JSON.stringify(m.config ?? {}), m.is_active],
  );
  await audit(pool, { entityType: 'offer', entityId: req.params.id, action: 'UPDATED', actor: 'admin', details: d });
  res.json({ ...rows[0], summary: describeOffer(rows[0]) });
}));

export default router;
