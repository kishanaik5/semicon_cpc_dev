import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES, DEFAULT_ACCOUNT_TYPE } from '../constants.js';
import { pool, withTransaction } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';
import { audit } from '../utils/audit.js';
import { referralCode } from '../utils/codes.js';
import { issueSignupCoupon } from '../services/signupService.js';
import { handleReferralSignup } from '../services/referralService.js';
import { describeOffer } from '../services/benefit.js';
import { CouponError } from '../utils/errors.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.*, ru.email AS referred_by_email,
            (SELECT COUNT(*)::int FROM coupons c WHERE c.assigned_user_id = u.id AND c.status='ACTIVE') AS active_coupons,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.referrer_id = u.id) AS referrals_made
       FROM users u LEFT JOIN users ru ON ru.id = u.referred_by ORDER BY u.id DESC LIMIT 500`,
  );
  res.json(rows);
}));

/** Register a new user: auto-issues signup coupon and handles referral code. */
router.post('/register', wrap(async (req, res) => {
  const d = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    account_type: z.enum(ACCOUNT_TYPES).default(DEFAULT_ACCOUNT_TYPE),
    referral_code: z.string().optional().nullable(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    let referrer = null;
    if (d.referral_code) {
      const { rows } = await client.query(`SELECT * FROM users WHERE referral_code = $1`, [d.referral_code.trim().toUpperCase()]);
      referrer = rows[0];
      if (!referrer) throw new CouponError('INVALID_REFERRAL_CODE', 'Referral code not recognised.', 400);
    }
    const { rows: urow } = await client.query(
      `INSERT INTO users (email, name, account_type, referral_code, referred_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.email.toLowerCase(), d.name, d.account_type, referralCode(d.name), referrer?.id ?? null],
    );
    const user = urow[0];
    await audit(client, { entityType: 'user', entityId: user.id, action: 'REGISTERED', details: { email: user.email, referredBy: referrer?.id ?? null } });

    const signupCoupon = await issueSignupCoupon(client, user);
    let referral = null;
    if (referrer) referral = await handleReferralSignup(client, { referrer, referee: user });
    return { user, signupCoupon, referral };
  });

  res.status(201).json({
    user: result.user,
    signupCoupon: result.signupCoupon ? { code: result.signupCoupon.code, validUntil: result.signupCoupon.valid_until } : null,
    referral: result.referral?.referral
      ? { refereeCoupon: result.referral.refereeCoupon?.code ?? null, referrerCouponIssued: !!result.referral.referrerCoupon }
      : result.referral?.skipped ? { skipped: result.referral.skipped } : null,
  });
}));

/** Coupons available to a user (their wallet). */
router.get('/:id/coupons', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.code, c.coupon_type, c.description, c.valid_until, c.status, c.usage_count, c.first_purchase_only,
            (c.pin_hash IS NOT NULL) AS requires_pin, o.name AS offer_name, o.benefit_type, o.value, o.max_discount
       FROM coupons c JOIN offers o ON o.id = c.offer_id
      WHERE c.assigned_user_id = $1 ORDER BY c.status = 'ACTIVE' DESC, c.id DESC`,
    [req.params.id],
  );
  res.json(rows.map((r) => ({ ...r, offer_summary: describeOffer(r) })));
}));

router.get('/:id/orders', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.code AS coupon_code FROM orders o LEFT JOIN coupons c ON c.id = o.coupon_id
      WHERE o.user_id = $1 ORDER BY o.id DESC LIMIT 50`, [req.params.id],
  );
  res.json(rows);
}));

export default router;
