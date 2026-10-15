# SemiconLabs Coupon System

Issue, validate and manage promotional coupons for SemiconLabs lab subscriptions. Accounts are either **Individual** or **Organization** (rename in `api/src/constants.js` and `web/src/constants.js`; the migration remaps old values on startup).
Stack: **PostgreSQL 16 · Node 20 / Express · React 18 / Vite · Docker Compose**.

## Run

```bash
cd semiconlabs-coupon-system
docker compose up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Web UI (checkout + PF Admin) | http://localhost:5180 | nginx serves React, proxies `/api` to the API |
| API | http://localhost:4100/api | health: `/api/health` |
| PostgreSQL | `localhost:5434` | user `semicon` / pass `semicon` / db `semicon_coupons` |

Admin key (dev default): `semicon-admin-dev-key` — change via `ADMIN_API_KEY` in `.env` (see `.env.example`).
Sign in on the PF Admin pages, or open `http://localhost:5180/admin?adminKey=semicon-admin-dev-key` once (the key is stored in the browser and stripped from the URL).
The UI follows your system theme; toggle light/dark in the sidebar or force it with `?theme=light` / `?theme=dark`.
Demo data is seeded on first boot (`SEED_DEMO_DATA=false` to disable).

### Demo accounts & codes
| What | Value |
|---|---|
| Users | asha.verma@example.com (1), rahul.nair@example.com (2), priya.iyer@acme.io (3, organization), dev.sharma@example.com (4, referred by Asha) |
| `SEMICON10` | 10% off (max ₹2000), 1000 global uses, 1 per user |
| `PERSONAL20` | 20% off, individual accounts only, 2 uses per user |
| `FLASH500` | ₹500 off, min order ₹1500, only 3 global uses |
| `EXPIRED2025` | expired — rejected |
| `VIP-PRIYA-2026` | Priya only, PIN **123456**, 15% organization onboarding offer |
| `CAMPUS-…` ×5 | one-time unique codes (+10 lab hours) |
| `WELCOME-…` | auto-issued signup coupons (first purchase only) |
| `REF-…` | auto-issued referral coupons |

## Coupon types
| Type | How it's created | Rules |
|---|---|---|
| `FIXED` | Admin → Coupons → Fixed code | static code, validity window, global and/or per-user limit, optional account-type (Individual / Organization) / first-purchase restriction |
| `UNIQUE` | Admin → Coupons → One-time unique (batch, up to 10k) | system-generated, each code redeemable once, CSV export |
| `USER_PIN` | Admin → Coupons → User + PIN | bound to a user, bcrypt-hashed PIN, 1 use, locks after 5 wrong PINs |
| `SIGNUP` | automatic on `POST /api/users/register` | configurable offer/validity, first purchase only, per account type (Individual / Organization) |
| `REFERRAL` | automatic when a signup uses a referral code | separate referrer/referee offers; referrer reward on signup or on referee's first purchase |

## Offers
A coupon points at an **offer**: `PERCENT_DISCOUNT` (with cap), `FIXED_DISCOUNT`, `EXTRA_HOURS`, `AI_CREDITS`, or `CUSTOM` (JSON config). Offers carry a minimum order amount.

## Validation & redemption rules
Every check returns a specific error code the UI maps to a message:
`INVALID_CODE` · `COUPON_DISABLED` · `COUPON_NOT_STARTED` · `COUPON_EXPIRED` · `COUPON_EXHAUSTED` · `ALREADY_USED` · `NOT_ELIGIBLE` · `ACCOUNT_TYPE_MISMATCH` · `FIRST_PURCHASE_ONLY` · `MIN_ORDER_NOT_MET` · `PROMOTION_CONFLICT` · `PIN_REQUIRED` · `PIN_INVALID` · `PIN_LOCKED` · `OFFER_INACTIVE` · `RATE_LIMITED`

* **Single coupon per transaction** — `coupon_redemptions.order_id` is `UNIQUE`; checkout accepts one code.
* **No stacking with promotions** — `has_existing_promotion=true` on the cart rejects any coupon (`PROMOTION_CONFLICT`).
* **Cannot exceed limits** — redemption runs in one transaction with `SELECT … FOR UPDATE` on the coupon row; verified with 8 parallel checkouts on a limit-3 coupon → exactly 3 succeed.
* **Expiry** — rejected at validation time, and a background job marks `EXPIRED` every 60s with an audit entry.

## Security
* Admin endpoints require `x-admin-key` (constant-time compare).
* Brute force: express-rate-limit (30 req/min/IP on coupon endpoints) **plus** DB-backed counters — 15 failed attempts per IP or 10 per user in 15 min → `RATE_LIMITED`.
* PINs stored as bcrypt hashes, shown once at creation; 5 wrong PINs lock the coupon 15 min (admin can unlock).
* Codes use a 32-char unambiguous alphabet (10 random chars ≈ 2^50 space).

## Analytics (PF Admin → Analytics)
Redemption rate overall and by type, daily redemptions / discount value, top coupons, validation-outcome breakdown (spot guessing), referral funnel (referrals → conversions, coupons issued/redeemed, top referrers).

## Auditability
`audit_logs` records coupon/offer/program creation, redemption, exhaustion, expiry, enable/disable, PIN lock/unlock, user registration, referral conversion. `coupon_attempts` records every validation attempt with IP and outcome.

## API summary
```
POST /api/users/register            {email,name,account_type,referral_code?}
GET  /api/users, /api/users/:id/coupons, /api/users/:id/orders
POST /api/checkout/validate         {user_id,subtotal,coupon_code,pin?,has_existing_promotion?}   # preview, <200ms
POST /api/checkout                  {user_id,subtotal,coupon_code?,pin?,description?}              # atomic redeem

# admin (header x-admin-key)
GET/POST/PUT  /api/admin/offers
GET           /api/admin/coupons?type=&status=&q=&batch_id=
POST          /api/admin/coupons/fixed | /unique-batch | /user-pin
PATCH         /api/admin/coupons/:id/status {status: ACTIVE|DISABLED}
POST          /api/admin/coupons/:id/unlock-pin
GET           /api/admin/coupons/batches, /batches/:id/codes?format=csv, /:id/redemptions
GET/POST/PATCH /api/admin/programs/signup, /api/admin/programs/referral, GET /referral/activity
GET           /api/admin/analytics/overview?days=30, /top-referrers
GET           /api/admin/audit, /api/admin/audit/attempts
```

## Local dev without Docker
```bash
docker compose up -d db
cd api && npm install && npm run dev            # :4100
cd web && npm install && npm run dev            # :5180 (proxies /api → :4100)
```

## Performance notes
Validation is 3–4 indexed queries on a single connection (≈3–6 ms locally). For promotion peaks, run several `api` replicas behind nginx (stateless; the only cross-request state lives in Postgres), and raise `max` on the pool.
