import { pool } from './db.js';
import { ACCOUNT_TYPES, DEFAULT_ACCOUNT_TYPE, LEGACY_ACCOUNT_TYPE_MAP } from './constants.js';

const TYPES_SQL = ACCOUNT_TYPES.map((t) => `'${t}'`).join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT '${DEFAULT_ACCOUNT_TYPE}' CHECK (account_type IN (${TYPES_SQL})),
  referral_code TEXT UNIQUE NOT NULL,
  referred_by BIGINT REFERENCES users(id),
  purchases_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  benefit_type TEXT NOT NULL CHECK (benefit_type IN ('PERCENT_DISCOUNT','FIXED_DISCOUNT','EXTRA_HOURS','AI_CREDITS','CUSTOM')),
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_discount NUMERIC(12,2),
  min_order_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_batches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  offer_id BIGINT NOT NULL REFERENCES offers(id),
  quantity INT NOT NULL,
  prefix TEXT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_programs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  referrer_offer_id BIGINT REFERENCES offers(id),
  referee_offer_id BIGINT REFERENCES offers(id),
  referrer_reward_trigger TEXT NOT NULL DEFAULT 'FIRST_PURCHASE' CHECK (referrer_reward_trigger IN ('SIGNUP','FIRST_PURCHASE')),
  coupon_validity_days INT NOT NULL DEFAULT 30,
  max_referrals_per_user INT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signup_coupon_configs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  offer_id BIGINT NOT NULL REFERENCES offers(id),
  validity_days INT NOT NULL DEFAULT 30,
  first_purchase_only BOOLEAN NOT NULL DEFAULT TRUE,
  account_type TEXT CHECK (account_type IS NULL OR account_type IN (${TYPES_SQL})),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  coupon_type TEXT NOT NULL CHECK (coupon_type IN ('FIXED','UNIQUE','USER_PIN','SIGNUP','REFERRAL')),
  offer_id BIGINT NOT NULL REFERENCES offers(id),
  description TEXT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  global_usage_limit INT,
  per_user_limit INT,
  usage_count INT NOT NULL DEFAULT 0,
  assigned_user_id BIGINT REFERENCES users(id),
  account_type TEXT CHECK (account_type IS NULL OR account_type IN (${TYPES_SQL})),
  pin_hash TEXT,
  pin_failed_attempts INT NOT NULL DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  first_purchase_only BOOLEAN NOT NULL DEFAULT FALSE,
  batch_id BIGINT REFERENCES coupon_batches(id),
  referral_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','EXHAUSTED','EXPIRED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupons_type ON coupons(coupon_type);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
CREATE INDEX IF NOT EXISTS idx_coupons_assigned_user ON coupons(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_coupons_batch ON coupons(batch_id);
CREATE INDEX IF NOT EXISTS idx_coupons_valid_until ON coupons(valid_until) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_ref TEXT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  description TEXT,
  subtotal NUMERIC(12,2) NOT NULL,
  has_existing_promotion BOOLEAN NOT NULL DEFAULT FALSE,
  coupon_id BIGINT REFERENCES coupons(id),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  benefits JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id BIGSERIAL PRIMARY KEY,
  coupon_id BIGINT NOT NULL REFERENCES coupons(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id),
  order_amount NUMERIC(12,2) NOT NULL,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  benefit JSONB NOT NULL DEFAULT '{}'::jsonb,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redemptions_coupon_user ON coupon_redemptions(coupon_id, user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_time ON coupon_redemptions(redeemed_at);

CREATE TABLE IF NOT EXISTS coupon_attempts (
  id BIGSERIAL PRIMARY KEY,
  code_attempted TEXT,
  user_id BIGINT,
  ip TEXT,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attempts_ip_time ON coupon_attempts(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_user_time ON coupon_attempts(user_id, created_at);

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  program_id BIGINT NOT NULL REFERENCES referral_programs(id),
  referrer_id BIGINT NOT NULL REFERENCES users(id),
  referee_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  referee_coupon_id BIGINT REFERENCES coupons(id),
  referrer_coupon_id BIGINT REFERENCES coupons(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONVERTED')),
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  actor TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
`;

/** Idempotent: rename legacy account types and refresh CHECK constraints. */
async function remapAccountTypes(client) {
  const cases = Object.entries(LEGACY_ACCOUNT_TYPE_MAP).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(' ');
  for (const [table, nullable] of [['users', false], ['coupons', true], ['signup_coupon_configs', true]]) {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_account_type_check`);
    await client.query(`UPDATE ${table} SET account_type = CASE account_type ${cases} ELSE account_type END
                         WHERE account_type IN (${Object.keys(LEGACY_ACCOUNT_TYPE_MAP).map((k) => `'${k}'`).join(',')})`);
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_account_type_check
                         CHECK (${nullable ? 'account_type IS NULL OR ' : ''}account_type IN (${TYPES_SQL}))`);
  }
  await client.query(`ALTER TABLE users ALTER COLUMN account_type SET DEFAULT '${DEFAULT_ACCOUNT_TYPE}'`);
}

export async function migrate() {
  const client = await pool.connect();
  try {
    // Advisory lock so multiple API replicas don't race on schema creation.
    await client.query('SELECT pg_advisory_lock(727272)');
    await client.query(SCHEMA);
    await remapAccountTypes(client);
    console.log('[db] schema ready');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)');
    client.release();
  }
}
