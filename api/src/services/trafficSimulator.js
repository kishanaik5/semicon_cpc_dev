import { pool, withTransaction } from '../db.js';
import { checkout, validateCoupon } from './couponService.js';
import { recordAttempt } from './couponService.js';

export async function generateTraffic(db = pool) {
  const { rows: users } = await db.query('SELECT * FROM users ORDER BY id LIMIT 5');
  if (users.length === 0) return { error: 'No users found to simulate traffic' };

  const results = {
    ordersPlaced: 0,
    attemptsLogged: 0,
    simulatedVolume: 0,
  };

  const sampleIps = ['103.21.244.12', '185.191.171.8', '45.134.140.22', '14.139.128.4', '152.58.16.89'];

  // 1. Simulate a series of valid coupon checkouts
  const scenarios = [
    { user: users[0], code: 'SEMICON10', subtotal: 1999, plan: 'Lab Access · Monthly' },
    { user: users[1] || users[0], code: 'PERSONAL20', subtotal: 14999, plan: 'Lab Access · Annual' },
    { user: users[2] || users[0], code: 'FLASH500', subtotal: 4999, plan: 'Custom Hardware Bundle' },
    { user: users[0], code: null, subtotal: 1999, plan: 'Lab Access · Monthly (Standard)' }, // Non-coupon order for AOV comparison
  ];

  for (const s of scenarios) {
    try {
      await checkout({
        userId: s.user.id,
        subtotal: s.subtotal,
        description: s.plan,
        couponCode: s.code,
        ip: sampleIps[Math.floor(Math.random() * sampleIps.length)],
      });
      results.ordersPlaced++;
      results.simulatedVolume += s.subtotal;
    } catch (err) {
      // Ignore if already used or limit hit in demo
    }
  }

  // 2. Simulate realistic coupon validation attempts (valid + invalid guesses + expired)
  const attempts = [
    { code: 'SEMICON10', outcome: 'SUCCESS', ip: sampleIps[0], user: users[0] },
    { code: 'PERSONAL20', outcome: 'SUCCESS', ip: sampleIps[1], user: users[1] || users[0] },
    { code: 'EXPIRED2025', outcome: 'COUPON_EXPIRED', ip: sampleIps[2], user: users[0] },
    { code: 'FLASH500', outcome: 'MIN_ORDER_NOT_MET', ip: sampleIps[3], user: users[0] },
    { code: 'SUPER50', outcome: 'INVALID_CODE', ip: sampleIps[1], user: null },
    { code: 'HACK2026', outcome: 'INVALID_CODE', ip: sampleIps[1], user: null },
    { code: 'TESTCODE', outcome: 'INVALID_CODE', ip: sampleIps[1], user: null },
    { code: 'FREE100', outcome: 'INVALID_CODE', ip: sampleIps[2], user: null },
    { code: 'VIP-PRIYA-2026', outcome: 'PIN_INVALID', ip: sampleIps[4], user: users[2] || users[0] },
  ];

  for (const a of attempts) {
    try {
      await recordAttempt(db, {
        code: a.code,
        userId: a.user?.id || null,
        ip: a.ip,
        outcome: a.outcome,
      });
      results.attemptsLogged++;
    } catch {
      // ignore
    }
  }

  return results;
}
