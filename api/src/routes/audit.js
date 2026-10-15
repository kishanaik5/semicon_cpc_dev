import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const { entity_type, action, q, limit = 100, offset = 0 } = req.query;
  const where = []; const params = [];
  if (entity_type) { params.push(entity_type); where.push(`entity_type = $${params.length}`); }
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(details::text ILIKE $${params.length} OR entity_id ILIKE $${params.length})`); }
  params.push(Math.min(Number(limit), 500)); params.push(Number(offset));
  const { rows } = await pool.query(
    `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params,
  );
  res.json(rows);
}));

router.get('/attempts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.email FROM coupon_attempts a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`,
  );
  res.json(rows);
}));

export default router;
