# SemiconLabs Coupon System

Issue, validate and redeem promotional coupons for SemiconLabs lab subscriptions.

**Stack:** FastAPI (Python 3.12) · PostgreSQL 16 · Redis 7 · React 18 / Vite · Docker Compose · optional Gemini (Ask AI)

## What it does
Five coupon types, five offer types, strict one-coupon-per-order rules, a reserve / confirm / release lifecycle,
PIN lockout, rate limiting, a full audit log, an analytics dashboard and an admin-only AI assistant.

| Coupon type | How it works |
|---|---|
| Fixed code | shared code with validity window and global / per-user limits |
| One-time unique | system-generated codes, each redeemable once |
| User + PIN | bound to one customer, argon2-hashed PIN, locks after 5 wrong attempts |
| First signup | issued automatically on registration, first purchase only |
| Referral | rewards for referrer and referee (on signup or on the referee's first purchase) |

Offer types: percentage discount, fixed amount, extra subscription hours, AI credits, custom benefit.
`OFFER_MODE=strict` pairs each coupon type with one offer type; `flexible` allows any combination.

## Run locally
```bash
cp .env.example .env              # optional: add GEMINI_API_KEY for the Ask AI button
docker compose up -d --build
docker compose exec coupon-service python -m scripts.seed            # the 5 demo coupons
docker compose exec coupon-service python -m scripts.seed_history    # 30 days of dashboard data
docker compose exec coupon-service python -m scripts.create_admin --username <name>   # prompts for a password
```

| What | URL |
|---|---|
| Storefront + PF Admin | http://localhost:5180 (admin at `/admin`) |
| API docs (Swagger) | http://localhost:8000/docs |
| Health | http://localhost:8000/health |

Reset to a clean demo at any time: `./coupon-service/reset_demo.sh` (macOS / Linux / Git Bash) or `.\coupon-service\reset_demo.ps1` (PowerShell).

## One command (macOS / Linux / Git Bash)
`./coupon-service/setup_local.sh` creates the tables, seeds the demo data and starts everything. Benchmark: `docker compose exec -T coupon-service python -m scripts.benchmark`. Video run sheet: [coupon-service/DEMO_SCRIPT.md](coupon-service/DEMO_SCRIPT.md).

## Deploy
One Docker image serves the API and the UI. Step-by-step Railway guide: [RAILWAY.md](RAILWAY.md).

## More detail
* Architecture, rules, security, endpoints, demo script: [coupon-service/README.md](coupon-service/README.md)
* Requirement spec and technical design: see the project PDFs supplied with the task.

## Layout
```
coupon-service/   FastAPI service (rules, Redis, admin, analytics, AI) + seed / demo / reset scripts
web/              React UI (storefront checkout + PF Admin)
Dockerfile        single-image build (UI + API) for Railway
docker-compose.yml  local stack: Postgres, Redis, coupon-service, web
```
