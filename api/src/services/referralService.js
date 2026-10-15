import { uniqueCode } from '../utils/codes.js';
import { audit } from '../utils/audit.js';

async function activeProgram(db) {
  const { rows } = await db.query(
    `SELECT * FROM referral_programs WHERE is_active ORDER BY id DESC LIMIT 1`,
  );
  return rows[0] || null;
}

async function issueReferralCoupon(db, { program, offerId, userId, referralId, role }) {
  if (!offerId) return null;
  const code = uniqueCode('REF');
  const { rows } = await db.query(
    `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_until, global_usage_limit, per_user_limit,
                          assigned_user_id, referral_id, metadata, created_by)
     VALUES ($1,'REFERRAL',$2,$3, now() + ($4 || ' days')::interval, 1, 1, $5, $6, $7, 'system')
     RETURNING *`,
    [code, offerId, role === 'REFEREE' ? 'Welcome reward for joining via referral' : 'Thank-you reward for referring a friend',
     String(program.coupon_validity_days), userId, referralId, JSON.stringify({ role, programId: program.id })],
  );
  await audit(db, {
    entityType: 'coupon', entityId: rows[0].id, action: 'CREATED',
    details: { code, type: 'REFERRAL', role, userId, referralId },
  });
  return rows[0];
}

/**
 * Called during registration when a referral code was supplied.
 * Creates the referral record, issues the referee coupon immediately and the
 * referrer coupon either now (SIGNUP trigger) or later (FIRST_PURCHASE trigger).
 */
export async function handleReferralSignup(db, { referrer, referee }) {
  const program = await activeProgram(db);
  if (!program) return { skipped: 'NO_ACTIVE_PROGRAM' };

  if (program.max_referrals_per_user != null) {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id = $1`, [referrer.id]);
    if (rows[0].n >= program.max_referrals_per_user) return { skipped: 'REFERRER_LIMIT_REACHED' };
  }

  const { rows: rrow } = await db.query(
    `INSERT INTO referrals (program_id, referrer_id, referee_id) VALUES ($1,$2,$3) RETURNING *`,
    [program.id, referrer.id, referee.id],
  );
  const referral = rrow[0];

  const refereeCoupon = await issueReferralCoupon(db, {
    program, offerId: program.referee_offer_id, userId: referee.id, referralId: referral.id, role: 'REFEREE',
  });
  let referrerCoupon = null;
  if (program.referrer_reward_trigger === 'SIGNUP') {
    referrerCoupon = await issueReferralCoupon(db, {
      program, offerId: program.referrer_offer_id, userId: referrer.id, referralId: referral.id, role: 'REFERRER',
    });
  }
  await db.query(
    `UPDATE referrals SET referee_coupon_id = $2, referrer_coupon_id = $3 WHERE id = $1`,
    [referral.id, refereeCoupon?.id ?? null, referrerCoupon?.id ?? null],
  );
  await audit(db, {
    entityType: 'referral', entityId: referral.id, action: 'CREATED',
    details: { referrerId: referrer.id, refereeId: referee.id, programId: program.id },
  });
  return { referral, refereeCoupon, referrerCoupon };
}

/** Called inside the checkout transaction on a user's first purchase. */
export async function onFirstPurchase(db, user) {
  const { rows } = await db.query(
    `SELECT r.*, p.referrer_reward_trigger, p.referrer_offer_id, p.coupon_validity_days, p.id AS pid
       FROM referrals r JOIN referral_programs p ON p.id = r.program_id
      WHERE r.referee_id = $1 AND r.status = 'PENDING' FOR UPDATE OF r`,
    [user.id],
  );
  const referral = rows[0];
  if (!referral) return;

  let referrerCoupon = null;
  if (referral.referrer_reward_trigger === 'FIRST_PURCHASE' && !referral.referrer_coupon_id) {
    referrerCoupon = await issueReferralCoupon(db, {
      program: { id: referral.pid, coupon_validity_days: referral.coupon_validity_days },
      offerId: referral.referrer_offer_id, userId: referral.referrer_id, referralId: referral.id, role: 'REFERRER',
    });
  }
  await db.query(
    `UPDATE referrals SET status = 'CONVERTED', converted_at = now(),
            referrer_coupon_id = COALESCE($2, referrer_coupon_id) WHERE id = $1`,
    [referral.id, referrerCoupon?.id ?? null],
  );
  await audit(db, { entityType: 'referral', entityId: referral.id, action: 'CONVERTED', details: { refereeId: user.id } });
}
