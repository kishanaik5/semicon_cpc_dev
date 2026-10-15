import bcrypt from 'bcryptjs';
import { pool, withTransaction } from './db.js';
import { referralCode } from './utils/codes.js';
import { audit } from './utils/audit.js';
import { issueSignupCoupon } from './services/signupService.js';
import { handleReferralSignup } from './services/referralService.js';

export async function seedIfEmpty() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM offers`);
  if (rows[0].n > 0) return;
  console.log('[seed] seeding demo data...');

  await withTransaction(async (c) => {
    const offer = async (name, benefit_type, value, extra = {}) => {
      const { rows } = await c.query(
        `INSERT INTO offers (name, description, benefit_type, value, max_discount, min_order_amount, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, extra.description ?? null, benefit_type, value, extra.max_discount ?? null, extra.min_order_amount ?? 0, JSON.stringify(extra.config ?? {})],
      );
      return rows[0];
    };
    const o10 = await offer('10% off lab subscription', 'PERCENT_DISCOUNT', 10, { max_discount: 2000, description: 'Standard promo discount' });
    const o500 = await offer('₹500 off', 'FIXED_DISCOUNT', 500, { min_order_amount: 1500 });
    const o20 = await offer('20% individual plan discount', 'PERCENT_DISCOUNT', 20, { max_discount: 1500 });
    const oHrs = await offer('+10 extra lab hours', 'EXTRA_HOURS', 10);
    const oAi = await offer('500 AI credits', 'AI_CREDITS', 500);
    const oCorp = await offer('Organization onboarding: 15% off', 'PERCENT_DISCOUNT', 15, { max_discount: 25000, min_order_amount: 10000 });

    // Signup + referral configuration
    await c.query(
      `INSERT INTO signup_coupon_configs (name, offer_id, validity_days, first_purchase_only, account_type)
       VALUES ('Welcome 10% (all users)', $1, 30, TRUE, NULL)`, [o10.id]);
    await c.query(
      `INSERT INTO referral_programs (name, referrer_offer_id, referee_offer_id, referrer_reward_trigger, coupon_validity_days)
       VALUES ('Refer a friend', $1, $2, 'FIRST_PURCHASE', 60)`, [oAi.id, o500.id]);

    // Users (signup coupons auto-issued)
    const mkUser = async (email, name, account_type, referrer) => {
      const { rows } = await c.query(
        `INSERT INTO users (email, name, account_type, referral_code, referred_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [email, name, account_type, referralCode(name), referrer?.id ?? null]);
      const u = rows[0];
      await audit(c, { entityType: 'user', entityId: u.id, action: 'REGISTERED', actor: 'seed', details: { email } });
      await issueSignupCoupon(c, u);
      if (referrer) await handleReferralSignup(c, { referrer, referee: u });
      return u;
    };
    const asha = await mkUser('asha.verma@example.com', 'Asha Verma', 'INDIVIDUAL');
    const rahul = await mkUser('rahul.nair@example.com', 'Rahul Nair', 'INDIVIDUAL');
    const priya = await mkUser('priya.iyer@acme.io', 'Priya Iyer', 'ORGANIZATION');
    await mkUser('dev.sharma@example.com', 'Dev Sharma', 'INDIVIDUAL', asha); // referred by Asha

    // Fixed coupons
    await c.query(
      `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_until, global_usage_limit, per_user_limit, created_by)
       VALUES ('SEMICON10', 'FIXED', $1, 'Launch promo - 10% off', now() + interval '90 days', 1000, 1, 'seed'),
              ('PERSONAL20', 'FIXED', $2, 'Individual plan discount', now() + interval '180 days', NULL, 2, 'seed'),
              ('FLASH500', 'FIXED', $3, 'Flash sale - first 3 users only', now() + interval '7 days', 3, 1, 'seed'),
              ('EXPIRED2025', 'FIXED', $1, 'Old campaign', now() - interval '1 day', NULL, 1, 'seed')`,
      [o10.id, o20.id, o500.id]);
    await c.query(`UPDATE coupons SET account_type='INDIVIDUAL' WHERE code='PERSONAL20'`);

    // User-specific PIN coupon for Priya (PIN 123456)
    const pinHash = await bcrypt.hash('123456', 10);
    await c.query(
      `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_until, global_usage_limit, per_user_limit, assigned_user_id, pin_hash, created_by)
       VALUES ('VIP-PRIYA-2026', 'USER_PIN', $1, 'Organization onboarding offer (PIN protected)', now() + interval '60 days', 1, 1, $2, $3, 'seed')`,
      [oCorp.id, priya.id, pinHash]);

    // Unique batch
    const { rows: brow } = await c.query(
      `INSERT INTO coupon_batches (name, offer_id, quantity, prefix, valid_until, created_by)
       VALUES ('Campus drive - Oct 2026', $1, 5, 'CAMPUS', now() + interval '30 days', 'seed') RETURNING id`, [oHrs.id]);
    const codes = ['CAMPUS-A7K2-M9PQ3R', 'CAMPUS-B3HN-X4TW8Z', 'CAMPUS-C9QD-L2VY5K', 'CAMPUS-D4MF-R7GH2N', 'CAMPUS-E8TP-W3JX6B'];
    await c.query(
      `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_until, global_usage_limit, per_user_limit, batch_id, created_by)
       SELECT unnest($1::text[]), 'UNIQUE', $2, 'Campus drive - Oct 2026', now() + interval '30 days', 1, 1, $3, 'seed'`,
      [codes, oHrs.id, brow[0].id]);

    await audit(c, { entityType: 'system', entityId: null, action: 'SEEDED', actor: 'seed', details: { users: 4, offers: 6 } });
    void rahul;
  });
  console.log('[seed] done');
}
