# SemiconLabs Coupon Service (FastAPI + PostgreSQL + Redis)

One service issues, validates and redeems all five coupon types.
**PostgreSQL decides** whether a redemption is allowed; **Redis only speeds things up and blocks abuse** (if Redis is down, requests still work).

## Run
```bash
cd coupon-service
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -r requirements.txt
python -m scripts.seed                               # demo campaigns + codes (prints them)
uvicorn app.main:app --port 8000                     # Swagger: http://localhost:8000/docs
python -m scripts.demo                               # walks the demo script
python -m scripts.gate_test                          # 100 parallel reserves on a cap of 10 -> exactly 10
python -m scripts.simulate_traffic                   # fill the dashboard
```
Config comes from the repo-root `.env`: `NEON_DB_URL` (or `DATABASE_URL`), `REDIS_URL`, `ADMIN_API_KEY`, `OFFER_MODE` (strict|flexible).
Tables live in their own schema `coupon_svc`, so they never collide with the Node app's tables.

## How it works (explain this in the demo)
| Step | Endpoint | What happens |
|---|---|---|
| Apply | `POST /coupons/validate` | rate-limit (Redis) → cached code lookup (Redis, 60 s) → rules → discount preview. Writes nothing. |
| Pay | `POST /coupons/reserve` | PIN check (argon2, locks after 5) → one DB transaction: advisory lock per (campaign,user), per-user count, **conditional UPDATE** on the global cap and code uses, insert redemption (15-min TTL). |
| Paid | `POST /coupons/confirm` | reserved → confirmed, order marked paid (this is what makes "first purchase" rules work). |
| Failed | `POST /coupons/release` | reserved → released, counters given back. A background worker does the same after 15 minutes. |
| Events | `POST /internal/events/signup`, `/referral-qualified` | issue signup coupon / both referral rewards (referee rewarded once: UNIQUE(referee_id)). |

### Why it can't over-redeem
* Global cap: `UPDATE campaigns SET redeemed_count = redeemed_count + 1 WHERE redeemed_count < max_redemptions` — one atomic statement, so 100 parallel requests on cap 10 give exactly 10.
* One coupon per order: unique partial index `one_coupon_per_order ON redemptions(order_id) WHERE status <> 'released'`.
* Unique code used once: same conditional UPDATE on `coupon_codes.used_count < max_uses`.

### Security
* Unique codes: 10 chars from an alphabet without 0/O/1/I/L/U, generated with `secrets`.
* PINs: argon2 hashes, lockout after 5 failures (`pin_attempts` + Redis counter).
* Brute force: 10 applies / 10 min per user and 30 per IP (Redis); unknown codes get a generic message.
* Webhook/internal endpoints need `X-Service-Key`; admin endpoints need `X-Admin-Key`; every change goes to `coupon_events`.

### Strict vs flexible (`OFFER_MODE`)
Strict pairs fixed→percent, unique→flat, user_pin→sub_hours, signup→ai_credits, referral→custom. It is checked only when an admin creates a campaign (`POST /admin/campaigns` → 422 with an explanation). Flexible allows any combination.

## Analytics
`GET /admin/analytics/metrics` (numbers only, no PII) and `GET /admin/analytics/insights` (adds a rule-based summary, anomalies and recommended actions). `analytics.summarize()` is the single place to plug in an LLM once the client approves a provider.

## Demo script
1. `LAUNCH10`: five users succeed, the sixth gets EXHAUSTED  2. `OLDPROMO` → EXPIRED  3. unique `SL-…` code twice → second rejected
4. VIP code: wrong PIN ×5 → locked  5. signup event → coupon issued, rejected after a paid order  6. referral event → both rewarded
7. second coupon on the same order → ONE_PER_ORDER  8. signup campaign with a % offer → rejected in strict, accepted with `OFFER_MODE=flexible`  9. insights endpoint

## Known limits
* Latency is dominated by network distance to the cloud DB/Redis (≈1.4 s per validate from India to a US Neon instance). The <200 ms target needs the API co-located with its DB and Redis (same region); the code itself is ~3 round trips per validate.
* TLS to the managed DB skips certificate verification (free-tier convenience); use the provider CA cert in production.

## Using the React UI (`web/`)
`app/compat.py` serves the `/api/*` routes the existing UI calls (users, checkout, offers, coupons, programs, audit, analytics) on top of the same engine, so no coupon rules are duplicated there.
```bash
docker compose up -d --build coupon-service web      # UI: http://localhost:5180  (nginx proxies /api -> coupon-service:8000)
# or locally: uvicorn app.main:app --port 8000, then `npm run dev` in web/ (Vite proxies /api -> :8000)
```
Admin key: `ADMIN_API_KEY` from `.env`; open `http://localhost:5180/admin?adminKey=<key>` once.
`OFFER_MODE` defaults to `flexible` in docker-compose (so the UI can create any combination); set `strict` to show the 1:1 mapping rejection.
The original Node `api/` is no longer used by the UI (its container can stay stopped).

UI vocabulary → engine: FIXED/UNIQUE/USER_PIN/SIGNUP/REFERRAL = `fixed/unique/user_pin/signup/referral` campaigns;
PERCENT_DISCOUNT/FIXED_DISCOUNT/EXTRA_HOURS/AI_CREDITS/CUSTOM = `percent/flat/sub_hours/ai_credits/custom`;
"Pay" = reserve + confirm (payment is simulated); a referee's first paid order converts the referral and pays the referrer.

## Local-first run (default in docker-compose)
`docker compose up -d --build coupon-service web` starts Postgres 16 + Redis 7 + the service + the UI, all on localhost.
First time only: `docker compose exec coupon-service python -m scripts.seed`.
Measured locally: validate ≈ 5-15 ms. To use Neon/Upstash instead, set `COUPON_DATABASE_URL` / `COUPON_REDIS_URL` in `.env` (expect ~1 s per call from far-away regions).

## PF Admin sign-in (session based)
* Accounts live in the `admin_users` table (argon2 password hash, never plain text). Create / reset one:
  `docker compose exec coupon-service python -m scripts.create_admin --username <name>` (prompts for the password).
* `POST /api/admin/login` checks the hash and sets a random token in an **HttpOnly, SameSite=Strict** cookie; only `sha256(token)` is stored server-side (`admin_sessions`).
* Sessions expire after **15 min of inactivity** (`ADMIN_IDLE_MINUTES`) or **8 h** total (`ADMIN_SESSION_HOURS`); every admin call slides the idle window. The UI also locks itself on the same timer and asks for the password again.
* Login is rate limited (5 per username / 10 per IP per 15 min) and every login / failure is written to the audit log.
* The shared `x-admin-key` no longer opens `/api/admin/*`. It remains only for machine callers of the PDF-style `/admin/*` endpoints (scripts, Swagger).

## Demo history (dashboard data)
`docker compose exec coupon-service python -m scripts.seed_history` pushes ~170 realistic attempts and orders through the running service (validations, rejections, rate-limit and PIN-lockout signals, referral conversions) and spreads them over the last 30 days. Re-run to add another batch. A reset (`reset_demo.ps1`) clears it, so run this afterwards.

## Ask AI (Gemini, admin only)
PF Admin -> Analytics has an **AI summary** button and an **Ask a question** box. It calls `POST /api/admin/ai/ask`, which sends Gemini only aggregated numbers (totals, per-campaign counts, rejection reasons, abuse counters; no emails, no individual codes or PINs).
Setup: create a free key at https://aistudio.google.com/apikey, then put `GEMINI_API_KEY=...` in the repo `.env` and run `docker compose up -d coupon-service`. `GEMINI_MODEL` defaults to `gemini-2.5-flash`.
The key stays on the server (sent in a request header). Limits: 12 questions/min per admin, 1000-character questions; every question is written to the audit log.

## Reset / start fresh
* macOS / Linux / Git Bash: `./coupon-service/reset_demo.sh [flexible|strict]` (if needed: `chmod +x coupon-service/reset_demo.sh` once)
* Windows PowerShell: `.\coupon-service\reset_demo.ps1 [flexible|strict]`
Both drop the coupon schema, flush Redis, rebuild, and re-seed the 5 coupons plus 30 days of history. The admin account is removed too, so recreate it:
`docker compose exec coupon-service python -m scripts.create_admin --username <name>`
