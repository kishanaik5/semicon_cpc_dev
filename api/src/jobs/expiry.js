import { config } from '../config.js';
import { expireCoupons } from '../services/couponService.js';

export function startExpiryJob() {
  const run = async () => {
    try {
      const n = await expireCoupons();
      if (n) console.log(`[expiry] marked ${n} coupon(s) EXPIRED`);
    } catch (err) {
      console.error('[expiry] failed', err.message);
    }
  };
  run();
  return setInterval(run, config.expiryJobIntervalMs);
}
