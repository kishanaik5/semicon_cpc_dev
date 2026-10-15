import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { fail, CouponError } from '../utils/errors.js';
import { normalizeCode } from '../utils/codes.js';
import { audit } from '../utils/audit.js';
import { computeBenefit, describeOffer } from './benefit.js';
import { onFirstPurchase } from './referralService.js';

/* ------------------------------------------------------------------ */
/* Brute-force protection                                              */
/* ------------------------------------------------------------------ */

export async function assertNotRateLimited(db, { ip, userId }) {
  const win = `${config.attemptWindowMinutes} minutes`;
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE ip = $1)                              AS ip_fails,
       COUNT(*) FILTER (WHERE user_id = $2 AND $2 IS NOT NULL)      AS user_fails
     FROM coupon_attempts
     WHERE outcome <> 'SUCCESS'
       AND created_at > now() - $3::interval
       AND (ip = $1 OR user_id = $2)`,
    [ip, userId ?? null, win],
  );
  const r = rows[0];
  if (Number(r.ip_fails) >= config.maxFailedAttemptsPerIp) throw fail('RATE_LIMITED', 429);
  if (Number(r.user_fails) >= config.maxFailedAttemptsPerUser) throw fail('RATE_LIMITED', 429);
}

export async function recordAttempt(db, { code, userId, ip, outcome }) {
  await db.query(
    `INSERT INTO coupon_attempts (code_attempted, user_id, ip, outcome) VALUES ($1, $2, $3, $4)`,
    [code?.slice(0, 64) ?? null, userId ?? null, ip, outcome],
  );
}

/* ------------------------------------------------------------------ */
/* Core eligibility check (shared by validate & redeem)                */
/* ------------------------------------------------------------------ */

/**
 * Loads the coupon (optionally locking it) and runs every rule.
 * Returns { coupon, offer, user, pricing } or throws CouponError.
 */
export async function evaluateCoupon(db, { code, userId, subtotal, pin, hasExistingPromotion, lock = false }) {
  const normalized = normalizeCode(code);
  if (!normalized) throw fail('INVALID_CODE', 404);

  const { rows: crow } = await db.query(
    `SELECT c.*, o.name AS offer_name, o.benefit_type, o.value, o.max_discount,
            o.min_order_amount, o.config AS offer_config, o.is_active AS offer_active
       FROM coupons c JOIN offers o ON o.id = c.offer_id
      WHERE c.code = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [normalized],
  );
  const coupon = crow[0];
  if (!coupon) throw fail('INVALID_CODE', 404);

  const { rows: urow } = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = urow[0];
  if (!user) throw fail('USER_NOT_FOUND', 404);

  // Restriction: cannot combine with existing offers/promotions
  if (hasExistingPromotion) throw fail('PROMOTION_CONFLICT', 409);

  const now = new Date();
  if (coupon.status === 'DISABLED') throw fail('COUPON_DISABLED');
  if (coupon.status === 'EXHAUSTED') throw fail('COUPON_EXHAUSTED');
  if (coupon.status === 'EXPIRED') throw fail('COUPON_EXPIRED');
  if (!coupon.offer_active) throw fail('OFFER_INACTIVE');
  if (coupon.valid_from && new Date(coupon.valid_from) > now) throw fail('COUPON_NOT_STARTED');
  if (coupon.valid_until && new Date(coupon.valid_until) <= now) throw fail('COUPON_EXPIRED');
  if (coupon.global_usage_limit != null && coupon.usage_count >= coupon.global_usage_limit) {
    throw fail('COUPON_EXHAUSTED');
  }

  // User binding (USER_PIN / SIGNUP / REFERRAL coupons are assigned to one user)
  if (coupon.assigned_user_id != null && Number(coupon.assigned_user_id) !== Number(user.id)) {
    throw fail('NOT_ELIGIBLE', 403);
  }
  if (coupon.account_type && coupon.account_type !== user.account_type) throw fail('ACCOUNT_TYPE_MISMATCH', 403);

  // Per-user limit
  if (coupon.per_user_limit != null) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.id, user.id],
    );
    if (rows[0].n >= coupon.per_user_limit) throw fail('ALREADY_USED');
  }

  // First purchase restriction
  if (coupon.first_purchase_only && user.purchases_count > 0) throw fail('FIRST_PURCHASE_ONLY');

  // Minimum order
  const minOrder = Number(coupon.min_order_amount) || 0;
  if (Number(subtotal) < minOrder) throw fail('MIN_ORDER_NOT_MET', 400, { minOrderAmount: minOrder });

  // PIN validation
  if (coupon.pin_hash) {
    if (coupon.pin_locked_until && new Date(coupon.pin_locked_until) > now) {
      throw fail('PIN_LOCKED', 423, { lockedUntil: coupon.pin_locked_until });
    }
    if (!pin) throw fail('PIN_REQUIRED', 401);
    const ok = await bcrypt.compare(String(pin), coupon.pin_hash);
    if (!ok) {
      const attempts = coupon.pin_failed_attempts + 1;
      const lock = attempts >= config.maxPinAttempts;
      await db.query(
        `UPDATE coupons SET pin_failed_attempts = $2,
                pin_locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE pin_locked_until END,
                updated_at = now()
          WHERE id = $1`,
        [coupon.id, lock ? 0 : attempts, lock, String(config.pinLockMinutes)],
      );
      if (lock) {
        await audit(db, { entityType: 'coupon', entityId: coupon.id, action: 'PIN_LOCKED', actor: `user:${user.id}` });
        throw fail('PIN_LOCKED', 423);
      }
      throw fail('PIN_INVALID', 401, { attemptsRemaining: config.maxPinAttempts - attempts });
    }
  }

  const offer = {
    id: coupon.offer_id, name: coupon.offer_name, benefit_type: coupon.benefit_type,
    value: coupon.value, max_discount: coupon.max_discount, min_order_amount: coupon.min_order_amount,
    config: coupon.offer_config,
  };
  const pricing = computeBenefit(offer, subtotal);
  return { coupon, offer, user, pricing };
}

function publicCoupon(coupon, offer, pricing) {
  return {
    code: coupon.code,
    type: coupon.coupon_type,
    description: coupon.description,
    offer: { id: offer.id, name: offer.name, benefitType: offer.benefit_type, summary: describeOffer(offer) },
    validUntil: coupon.valid_until,
    discountAmount: pricing.discountAmount,
    total: pricing.total,
    benefit: pricing.benefit,
  };
}

/* ------------------------------------------------------------------ */
/* Validate (no side effects except attempt logging / PIN counters)    */
/* ------------------------------------------------------------------ */

export async function validateCoupon({ code, userId, subtotal, pin, hasExistingPromotion, ip }) {
  await assertNotRateLimited(pool, { ip, userId });
  try {
    const { coupon, offer, pricing } = await evaluateCoupon(pool, { code, userId, subtotal, pin, hasExistingPromotion });
    await recordAttempt(pool, { code, userId, ip, outcome: 'SUCCESS' });
    // Reset PIN counter on successful validation
    if (coupon.pin_hash && coupon.pin_failed_attempts > 0) {
      await pool.query(`UPDATE coupons SET pin_failed_attempts = 0 WHERE id = $1`, [coupon.id]);
    }
    return { valid: true, message: `Coupon applied: ${describeOffer(offer)}`, coupon: publicCoupon(coupon, offer, pricing) };
  } catch (err) {
    if (err instanceof CouponError) {
      // PIN_REQUIRED is a prompt, not a failed guess - don't count it toward rate limiting.
      if (err.code !== 'PIN_REQUIRED' && err.code !== 'USER_NOT_FOUND') {
        await recordAttempt(pool, { code, userId, ip, outcome: err.code });
      }
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Checkout / Redeem (atomic)                                          */
/* ------------------------------------------------------------------ */

export async function checkout({ userId, subtotal, description, couponCode, pin, hasExistingPromotion, ip }) {
  if (couponCode) await assertNotRateLimited(pool, { ip, userId });

  try {
    return await withTransaction(async (client) => {
      const { rows: urow } = await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const user = urow[0];
      if (!user) throw fail('USER_NOT_FOUND', 404);

      let coupon = null, offer = null, pricing = { discountAmount: 0, total: Number(subtotal), benefit: {} };
      if (couponCode) {
        const r = await evaluateCoupon(client, { code: couponCode, userId, subtotal, pin, hasExistingPromotion, lock: true });
        coupon = r.coupon; offer = r.offer; pricing = r.pricing;
      }

      const orderRef = `SL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const { rows: orow } = await client.query(
        `INSERT INTO orders (order_ref, user_id, description, subtotal, has_existing_promotion, coupon_id, discount_amount, total, benefits)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orderRef, userId, description || null, subtotal, !!hasExistingPromotion, coupon?.id ?? null,
         pricing.discountAmount, pricing.total, JSON.stringify(pricing.benefit || {})],
      );
      const order = orow[0];

      if (coupon) {
        // UNIQUE(order_id) guarantees one coupon per transaction at the DB level.
        await client.query(
          `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, order_amount, discount_amount, benefit)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [coupon.id, userId, order.id, subtotal, pricing.discountAmount, JSON.stringify(pricing.benefit)],
        );
        const { rows: upd } = await client.query(
          `UPDATE coupons
              SET usage_count = usage_count + 1,
                  pin_failed_attempts = 0,
                  status = CASE WHEN global_usage_limit IS NOT NULL AND usage_count + 1 >= global_usage_limit
                                THEN 'EXHAUSTED' ELSE status END,
                  updated_at = now()
            WHERE id = $1 RETURNING usage_count, status`,
          [coupon.id],
        );
        await audit(client, {
          entityType: 'coupon', entityId: coupon.id, action: 'REDEEMED', actor: `user:${userId}`,
          details: { code: coupon.code, orderRef, subtotal, discount: pricing.discountAmount, benefit: pricing.benefit },
        });
        if (upd[0].status === 'EXHAUSTED') {
          await audit(client, { entityType: 'coupon', entityId: coupon.id, action: 'EXHAUSTED', details: { code: coupon.code } });
        }
      }

      const isFirstPurchase = user.purchases_count === 0;
      await client.query(`UPDATE users SET purchases_count = purchases_count + 1 WHERE id = $1`, [userId]);
      if (isFirstPurchase) await onFirstPurchase(client, user);

      await audit(client, {
        entityType: 'order', entityId: order.id, action: 'CREATED', actor: `user:${userId}`,
        details: { orderRef, subtotal, total: pricing.total, couponCode: coupon?.code ?? null },
      });

      if (coupon) await recordAttempt(client, { code: couponCode, userId, ip, outcome: 'SUCCESS' });

      return {
        order: {
          id: order.id, orderRef, subtotal: Number(subtotal), discountAmount: pricing.discountAmount,
          total: pricing.total, benefits: pricing.benefit, couponCode: coupon?.code ?? null,
        },
        coupon: coupon ? publicCoupon(coupon, offer, pricing) : null,
        message: coupon ? `Order placed. ${describeOffer(offer)} applied.` : 'Order placed.',
      };
    });
  } catch (err) {
    if (err instanceof CouponError && couponCode && err.code !== 'PIN_REQUIRED' && err.code !== 'USER_NOT_FOUND') {
      await recordAttempt(pool, { code: couponCode, userId, ip, outcome: err.code });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Expiry sweep                                                        */
/* ------------------------------------------------------------------ */

export async function expireCoupons() {
  const { rows } = await pool.query(
    `UPDATE coupons SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'ACTIVE' AND valid_until IS NOT NULL AND valid_until <= now()
      RETURNING id, code`,
  );
  for (const c of rows) {
    await audit(pool, { entityType: 'coupon', entityId: c.id, action: 'EXPIRED', details: { code: c.code } });
  }
  return rows.length;
}
