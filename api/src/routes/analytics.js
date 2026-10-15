import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware/errorHandler.js';
import { generateTraffic } from '../services/trafficSimulator.js';

const router = Router();

router.get('/overview', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const [totals, byType, daily, topCoupons, referral, outcomes, financial, timing, security] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM coupons) AS coupons_total,
        (SELECT COUNT(*)::int FROM coupons WHERE status='ACTIVE') AS coupons_active,
        (SELECT COUNT(*)::int FROM coupon_redemptions) AS redemptions_total,
        (SELECT COUNT(*)::int FROM coupon_redemptions WHERE redeemed_at > now() - ($1 || ' days')::interval) AS redemptions_period,
        (SELECT COALESCE(SUM(discount_amount),0)::numeric(12,2) FROM coupon_redemptions) AS discount_total,
        (SELECT COUNT(*)::int FROM orders) AS orders_total,
        (SELECT COUNT(*)::int FROM orders WHERE coupon_id IS NOT NULL) AS orders_with_coupon,
        (SELECT COUNT(*)::int FROM users) AS users_total,
        (SELECT COUNT(*)::int FROM coupon_attempts WHERE outcome <> 'SUCCESS' AND created_at > now() - ($1 || ' days')::interval) AS failed_attempts_period
    `, [String(days)]),
    pool.query(`
      SELECT coupon_type,
             COUNT(*)::int AS issued,
             COUNT(*) FILTER (WHERE usage_count > 0)::int AS redeemed_coupons,
             COALESCE(SUM(usage_count),0)::int AS redemptions,
             COUNT(*) FILTER (WHERE status='EXPIRED')::int AS expired,
             COUNT(*) FILTER (WHERE status='EXHAUSTED')::int AS exhausted
        FROM coupons GROUP BY coupon_type ORDER BY coupon_type`),
    pool.query(`
      SELECT d::date AS day,
             COALESCE(r.n,0)::int AS redemptions,
             COALESCE(r.discount,0)::numeric(12,2) AS discount
        FROM generate_series(now()::date - ($1::int - 1), now()::date, '1 day') d
        LEFT JOIN (SELECT redeemed_at::date AS day, COUNT(*) n, SUM(discount_amount) discount
                     FROM coupon_redemptions WHERE redeemed_at > now()::date - $1::int GROUP BY 1) r ON r.day = d::date
       ORDER BY day`, [days]),
    pool.query(`
      SELECT c.code, c.coupon_type, c.usage_count, c.global_usage_limit, c.status, o.name AS offer_name,
             COALESCE(SUM(r.discount_amount),0)::numeric(12,2) AS discount_total
        FROM coupons c JOIN offers o ON o.id = c.offer_id
        LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
       WHERE c.usage_count > 0
       GROUP BY c.id, o.name ORDER BY c.usage_count DESC LIMIT 10`),
    pool.query(`
      SELECT COUNT(*)::int AS referrals,
             COUNT(*) FILTER (WHERE status='CONVERTED')::int AS converted,
             COUNT(DISTINCT referrer_id)::int AS active_referrers,
             (SELECT COUNT(*)::int FROM coupons WHERE coupon_type='REFERRAL' AND usage_count > 0) AS referral_coupons_redeemed,
             (SELECT COUNT(*)::int FROM coupons WHERE coupon_type='REFERRAL') AS referral_coupons_issued,
             (SELECT COUNT(*)::int FROM users WHERE referred_by IS NOT NULL) AS referred_users,
             (SELECT COUNT(*)::int FROM users) AS all_users
        FROM referrals`),
    pool.query(`
      SELECT outcome, COUNT(*)::int AS n FROM coupon_attempts
       WHERE created_at > now() - ($1 || ' days')::interval GROUP BY outcome ORDER BY n DESC`, [String(days)]),
    pool.query(`
      SELECT
        COALESCE(SUM(subtotal), 0)::numeric(12,2) AS revenue_total,
        COALESCE(SUM(subtotal) FILTER (WHERE coupon_id IS NOT NULL), 0)::numeric(12,2) AS revenue_with_coupon,
        COALESCE(AVG(subtotal) FILTER (WHERE coupon_id IS NOT NULL), 0)::numeric(12,2) AS aov_with_coupon,
        COALESCE(AVG(subtotal) FILTER (WHERE coupon_id IS NULL), 0)::numeric(12,2) AS aov_without_coupon
      FROM orders
    `),
    pool.query(`
      SELECT
        COALESCE(AVG(EXTRACT(EPOCH FROM (r.redeemed_at - c.created_at)) / 3600), 0)::numeric(10,1) AS avg_hours_to_redeem
      FROM coupon_redemptions r
      JOIN coupons c ON c.id = r.coupon_id
      WHERE r.redeemed_at > now() - ($1 || ' days')::interval
    `, [String(days)]),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM coupons WHERE pin_locked_until IS NOT NULL AND pin_locked_until > now()) AS active_pin_lockouts,
        (SELECT COUNT(*)::int FROM coupon_attempts WHERE outcome = 'PIN_LOCKED' AND created_at > now() - ($1 || ' days')::interval) AS pin_lockout_events,
        (SELECT COUNT(*)::int FROM coupon_attempts WHERE outcome = 'RATE_LIMITED' AND created_at > now() - ($1 || ' days')::interval) AS rate_limited_events,
        (SELECT COUNT(DISTINCT ip)::int FROM coupon_attempts WHERE outcome <> 'SUCCESS' AND created_at > now() - ($1 || ' days')::interval) AS flagged_ips,
        (SELECT COUNT(*)::int FROM coupon_attempts WHERE created_at > now() - ($1 || ' days')::interval) AS total_attempts
    `, [String(days)]),
  ]);

  const t = totals.rows[0];
  const fin = financial.rows[0];
  const sec = security.rows[0];
  const time = timing.rows[0];

  const totalAttempts = sec.total_attempts || 0;
  const redemptionsPeriod = Number(t.redemptions_period || 0);
  const applySuccessRate = totalAttempts > 0
    ? Number(((redemptionsPeriod / totalAttempts) * 100).toFixed(1))
    : redemptionsPeriod > 0 ? 100 : 0;

  const revCoupon = Number(fin.revenue_with_coupon || 0);
  const discountTotal = Number(t.discount_total || 0);
  const discountRoi = revCoupon > 0 ? Number(((revCoupon - discountTotal) / (discountTotal || 1)).toFixed(1)) : 0;

  res.json({
    days,
    totals: {
      ...t,
      redemption_rate: t.coupons_total ? Number(((byType.rows.reduce((a, r) => a + r.redeemed_coupons, 0) / t.coupons_total) * 100).toFixed(1)) : 0,
      coupon_order_share: t.orders_total ? Number(((t.orders_with_coupon / t.orders_total) * 100).toFixed(1)) : 0,
      apply_success_rate: Math.min(100, applySuccessRate),
      revenue_with_coupon: revCoupon,
      aov_with_coupon: Number(fin.aov_with_coupon || 0),
      aov_without_coupon: Number(fin.aov_without_coupon || 0),
      discount_roi: discountRoi,
      avg_hours_to_redeem: Number(time.avg_hours_to_redeem || 0),
      security: {
        active_pin_lockouts: sec.active_pin_lockouts,
        pin_lockout_events: sec.pin_lockout_events,
        rate_limited_events: sec.rate_limited_events,
        flagged_ips: sec.flagged_ips,
      },
    },
    byType: byType.rows.map((r) => ({ ...r, redemption_rate: r.issued ? Number(((r.redeemed_coupons / r.issued) * 100).toFixed(1)) : 0 })),
    daily: daily.rows,
    topCoupons: topCoupons.rows,
    referral: {
      ...referral.rows[0],
      conversion_rate: referral.rows[0].referrals ? Number(((referral.rows[0].converted / referral.rows[0].referrals) * 100).toFixed(1)) : 0,
    },
    outcomes: outcomes.rows,
  });
}));

router.get('/top-referrers', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.name, COUNT(r.id)::int AS referrals,
           COUNT(r.id) FILTER (WHERE r.status='CONVERTED')::int AS converted
      FROM users u JOIN referrals r ON r.referrer_id = u.id
     GROUP BY u.id ORDER BY referrals DESC, converted DESC LIMIT 10`);
  res.json(rows);
}));

/**
 * AI Growth & Anomaly Insights Endpoint
 * Synthesizes business telemetry, flags anomalies, and generates high-impact action recommendations.
 */
router.get('/insights', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);

  const [attemptsRes, couponsRes, ordersRes, referralsRes] = await Promise.all([
    pool.query(`
      SELECT outcome, count(*)::int as n
      FROM coupon_attempts
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY outcome ORDER BY n DESC
    `, [String(days)]),
    pool.query(`
      SELECT c.code, c.coupon_type, c.usage_count, c.global_usage_limit, c.valid_until, c.status, o.name AS offer_name
      FROM coupons c JOIN offers o ON o.id = c.offer_id
      ORDER BY c.usage_count DESC
    `),
    pool.query(`
      SELECT
        COUNT(*)::int as total_orders,
        COUNT(*) FILTER (WHERE coupon_id IS NOT NULL)::int as promo_orders,
        COALESCE(SUM(subtotal) FILTER (WHERE coupon_id IS NOT NULL), 0)::numeric(12,2) as promo_revenue,
        COALESCE(SUM(discount_amount), 0)::numeric(12,2) as total_discount
      FROM orders
    `),
    pool.query(`
      SELECT count(*)::int as total, count(*) FILTER (WHERE status='CONVERTED')::int as converted
      FROM referrals
    `),
  ]);

  const attempts = attemptsRes.rows;
  const coupons = couponsRes.rows;
  const orders = ordersRes.rows[0];
  const ref = referralsRes.rows[0];

  const totalAttempts = attempts.reduce((a, b) => a + b.n, 0);
  const invalidAttempts = attempts.find((a) => a.outcome === 'INVALID_CODE')?.n || 0;
  const rateLimitAttempts = attempts.find((a) => a.outcome === 'RATE_LIMITED')?.n || 0;
  const pinLockedAttempts = attempts.find((a) => a.outcome === 'PIN_LOCKED')?.n || 0;

  const anomalies = [];
  const recommendations = [];

  // Anomaly 1: Brute force / code guessing
  if (totalAttempts > 10 && (invalidAttempts / totalAttempts) > 0.35) {
    anomalies.push({
      severity: 'warning',
      title: 'High Code Guessing Velocity',
      description: `${invalidAttempts} invalid coupon attempts (${Math.round((invalidAttempts / totalAttempts) * 100)}% of total attempts). Suspicious automated scraping or guesswork detected.`,
    });
    recommendations.push('Tighten IP rate-limit thresholds or temporarily restrict anonymous cart validation.');
  }

  // Anomaly 2: Near-exhausted high-impact coupons
  const nearExhausted = coupons.filter(
    (c) => c.global_usage_limit && (c.usage_count / c.global_usage_limit) >= 0.8 && c.status === 'ACTIVE'
  );
  if (nearExhausted.length > 0) {
    anomalies.push({
      severity: 'info',
      title: 'Campaigns Approaching Capacity',
      description: `${nearExhausted.map((c) => c.code).join(', ')} reached ≥80% of global usage limits.`,
    });
    recommendations.push(`Expand quota for ${nearExhausted[0].code} to avoid checkout drop-offs.`);
  }

  // Anomaly 3: Expiring soon
  const soon = new Date(Date.now() + 7 * 86400000);
  const expiringSoon = coupons.filter(
    (c) => c.status === 'ACTIVE' && c.valid_until && new Date(c.valid_until) <= soon
  );
  if (expiringSoon.length > 0) {
    anomalies.push({
      severity: 'info',
      title: 'Campaigns Expiring Soon',
      description: `${expiringSoon.length} active coupons expire within 7 days (including ${expiringSoon[0].code}).`,
    });
  }

  // Referral health
  const refConvRate = ref.total > 0 ? (ref.converted / ref.total) * 100 : 0;
  if (ref.total > 0 && refConvRate < 25) {
    recommendations.push('Referral conversion is below benchmark (25%). Consider sweetening the referee welcome reward.');
  } else {
    recommendations.push('Referral program is driving healthy acquisition. Promote member referral links in post-checkout emails.');
  }

  if (recommendations.length < 3) {
    recommendations.push('Introduce category-specific minimum order values on percentage offers to maximize subscription revenue.');
  }

  const promoRev = Number(orders.promo_revenue || 0);
  const disc = Number(orders.total_discount || 0);
  const netLift = promoRev - disc;

  res.json({
    summary: {
      headline: promoRev > 0
        ? `Coupons generated ₹${promoRev.toLocaleString('en-IN')} in gross revenue with an effective discount rate of ${((disc / (promoRev || 1)) * 100).toFixed(1)}%.`
        : 'Coupon system is initialized and ready for customer redemptions.',
      netRevenueLift: netLift,
      healthScore: anomalies.some((a) => a.severity === 'critical') ? 'Needs Attention' : anomalies.length > 0 ? 'Good' : 'Excellent',
      anomaliesCount: anomalies.length,
    },
    anomalies,
    recommendations: recommendations.slice(0, 3),
    insights: [
      { metric: 'Top Performing Code', value: coupons[0]?.code || 'N/A', detail: `${coupons[0]?.usage_count || 0} redemptions` },
      { metric: 'Abuse Signal Index', value: `${rateLimitAttempts + pinLockedAttempts} events`, detail: `${rateLimitAttempts} rate-limited, ${pinLockedAttempts} locked PINs` },
      { metric: 'Referral Conversion', value: `${refConvRate.toFixed(1)}%`, detail: `${ref.converted} conversions from ${ref.total} referrals` },
    ],
  });
}));

/**
 * Traffic Simulator trigger (Admin action or CLI)
 */
router.post('/simulate', wrap(async (req, res) => {
  const result = await generateTraffic(pool);
  res.json({ ok: true, message: 'Simulated traffic generated successfully', result });
}));

export default router;

