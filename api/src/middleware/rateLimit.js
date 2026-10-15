import rateLimit from 'express-rate-limit';

const handler = (req, res) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } });

// Tight limiter for coupon guessing surfaces (validate / checkout)
export const couponLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// General limiter for the rest of the API
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
