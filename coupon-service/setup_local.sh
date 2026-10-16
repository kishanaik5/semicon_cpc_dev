#!/usr/bin/env bash
# One-shot local deployment: Postgres + Redis in Docker, tables from db/schema.sql, demo data, admin account, API + UI.
# Works on macOS / Linux / Git Bash. Needs Docker running.
#
#   ./coupon-service/setup_local.sh                       # prompts for the admin password
#   ADMIN_USERNAME=admin ADMIN_PASSWORD='long-password' ./coupon-service/setup_local.sh   # non-interactive
#   OFFER_MODE=strict ./coupon-service/setup_local.sh     # strict 1:1 coupon-to-offer mapping (default: flexible)
#
# Re-running wipes the coupon data (schema coupon_svc) and rebuilds it from scratch.
set -euo pipefail

cd "$(dirname "$0")/.."                                   # repo root (docker-compose.yml lives here)
export OFFER_MODE="${OFFER_MODE:-flexible}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
psql_c() { docker compose exec -T postgres psql -U semicon -d coupons -v ON_ERROR_STOP=1 -q "$@"; }

step "Checking prerequisites"
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and retry." >&2; exit 1; }
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example (add GEMINI_API_KEY there to enable Ask AI)"; }
ok "Docker is running"

step "1/6  Starting PostgreSQL 16 and Redis 7"
docker compose stop coupon-service web >/dev/null 2>&1 || true
docker compose up -d postgres redis >/dev/null
until docker compose exec -T postgres pg_isready -U semicon -d coupons >/dev/null 2>&1; do sleep 1; done
ok "PostgreSQL ready   (localhost:5435, db 'coupons', user 'semicon')"
until [ "$(docker compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')" = "PONG" ]; do sleep 1; done
docker compose exec -T redis redis-cli FLUSHALL >/dev/null
ok "Redis ready        (localhost:6380, PING -> PONG)"

step "2/6  Creating the tables from coupon-service/db/schema.sql"
psql_c -c "SET client_min_messages = warning; DROP SCHEMA IF EXISTS coupon_svc CASCADE"
docker compose exec -T postgres psql -U semicon -d coupons -v ON_ERROR_STOP=1 -q < coupon-service/db/schema.sql
docker compose exec -T postgres psql -U semicon -d coupons -c "\dt coupon_svc.*"
ok "schema applied"

step "3/6  Building and starting the API and the UI"
docker compose up -d --build coupon-service web >/dev/null
for _ in $(seq 1 90); do curl -fsS http://localhost:8000/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://localhost:8000/health >/dev/null || { echo "API did not become healthy; run: docker compose logs coupon-service" >&2; exit 1; }
ok "API healthy: $(curl -fsS http://localhost:8000/health)"

step "4/6  Seeding the 5 demo coupons (one per type)"
docker compose exec -T coupon-service python -m scripts.seed

step "5/6  Generating 30 days of demo history for the dashboard"
docker compose exec -T coupon-service python -m scripts.seed_history

step "6/6  Creating the PF Admin account '$ADMIN_USERNAME'"
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  docker compose exec -T -e ADMIN_PASSWORD="$ADMIN_PASSWORD" coupon-service python -m scripts.create_admin --username "$ADMIN_USERNAME"
else
  docker compose exec coupon-service python -m scripts.create_admin --username "$ADMIN_USERNAME"
fi

step "Row counts"
psql_c -c "SELECT 'offers' AS table_name, count(*) FROM coupon_svc.offers
 UNION ALL SELECT 'campaigns', count(*) FROM coupon_svc.campaigns
 UNION ALL SELECT 'coupon_codes', count(*) FROM coupon_svc.coupon_codes
 UNION ALL SELECT 'users', count(*) FROM coupon_svc.users
 UNION ALL SELECT 'orders', count(*) FROM coupon_svc.orders
 UNION ALL SELECT 'redemptions', count(*) FROM coupon_svc.redemptions
 UNION ALL SELECT 'referrals', count(*) FROM coupon_svc.referrals
 UNION ALL SELECT 'coupon_events', count(*) FROM coupon_svc.coupon_events"

cat <<EOF

Done (OFFER_MODE=$OFFER_MODE).
  Storefront:   http://localhost:5180/checkout
  PF Admin:     http://localhost:5180/admin      (user: $ADMIN_USERNAME)
  API docs:     http://localhost:8000/docs
  Benchmark:    docker compose exec -T coupon-service python -m scripts.benchmark
EOF
