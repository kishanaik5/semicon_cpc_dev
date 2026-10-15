import { ZodError } from 'zod';
import { CouponError } from '../utils/errors.js';

export function errorHandler(err, req, res, _next) {
  if (err instanceof CouponError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
  }
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(err.status || 400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request body.' } });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with that value already exists.', detail: err.detail } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
