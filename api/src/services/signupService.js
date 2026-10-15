import { uniqueCode } from '../utils/codes.js';
import { audit } from '../utils/audit.js';

/** Auto-issue a first-time signup coupon if an active config matches the user. */
export async function issueSignupCoupon(db, user) {
  const { rows } = await db.query(
    `SELECT * FROM signup_coupon_configs
      WHERE is_active AND (account_type IS NULL OR account_type = $1)
      ORDER BY account_type NULLS LAST, id DESC LIMIT 1`,
    [user.account_type],
  );
  const cfg = rows[0];
  if (!cfg) return null;

  const code = uniqueCode('WELCOME');
  const { rows: crow } = await db.query(
    `INSERT INTO coupons (code, coupon_type, offer_id, description, valid_until, global_usage_limit, per_user_limit,
                          assigned_user_id, first_purchase_only, metadata, created_by)
     VALUES ($1,'SIGNUP',$2,'Welcome coupon for new signup', now() + ($3 || ' days')::interval, 1, 1, $4, $5, $6, 'system')
     RETURNING *`,
    [code, cfg.offer_id, String(cfg.validity_days), user.id, cfg.first_purchase_only, JSON.stringify({ configId: cfg.id })],
  );
  await audit(db, { entityType: 'coupon', entityId: crow[0].id, action: 'CREATED', details: { code, type: 'SIGNUP', userId: user.id } });
  return crow[0];
}
