import crypto from 'node:crypto';
import { config } from '../config.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || !safeEqual(key, config.adminApiKey)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin API key required.' } });
  }
  req.actor = 'admin';
  next();
}
