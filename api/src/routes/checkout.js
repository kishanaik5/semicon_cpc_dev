import { Router } from 'express';
import { z } from 'zod';
import { wrap } from '../middleware/errorHandler.js';
import { validateCoupon, checkout } from '../services/couponService.js';

const router = Router();

const Base = {
  user_id: z.coerce.number().int(),
  subtotal: z.coerce.number().min(0),
  coupon_code: z.string().min(1).max(64).optional().nullable(),
  pin: z.string().max(8).optional().nullable(),
  has_existing_promotion: z.boolean().optional().default(false),
  description: z.string().max(200).optional().nullable(),
};

const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();

/** Preview a coupon against the cart. No redemption. */
router.post('/validate', wrap(async (req, res) => {
  const d = z.object({ ...Base, coupon_code: z.string().min(1).max(64) }).parse(req.body);
  const t0 = process.hrtime.bigint();
  const result = await validateCoupon({
    code: d.coupon_code, userId: d.user_id, subtotal: d.subtotal, pin: d.pin,
    hasExistingPromotion: d.has_existing_promotion, ip: clientIp(req),
  });
  res.setHeader('Server-Timing', `validate;dur=${Number(process.hrtime.bigint() - t0) / 1e6}`);
  res.json(result);
}));

/** Place the order and redeem the coupon atomically. */
router.post('/', wrap(async (req, res) => {
  const d = z.object(Base).parse(req.body);
  const result = await checkout({
    userId: d.user_id, subtotal: d.subtotal, description: d.description, couponCode: d.coupon_code || null,
    pin: d.pin, hasExistingPromotion: d.has_existing_promotion, ip: clientIp(req),
  });
  res.status(201).json(result);
}));

export default router;
