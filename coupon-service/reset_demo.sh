#!/usr/bin/env bash
# Reset the local demo to a clean, seeded state (macOS / Linux / Git Bash).
#   ./coupon-service/reset_demo.sh              -> OFFER_MODE=flexible (UI can create any offer/coupon combination)
#   ./coupon-service/reset_demo.sh strict       -> OFFER_MODE=strict   (shows the 1:1 mapping rejection)
# Note: this deletes the admin account too; recreate it with scripts.create_admin (see the last line).
set -euo pipefail

MODE="${1:-flexible}"
case "$MODE" in flexible|strict) ;; *) echo "usage: $0 [flexible|strict]" >&2; exit 1 ;; esac

cd "$(dirname "$0")/.."            # repo root, where docker-compose.yml lives
export OFFER_MODE="$MODE"

echo "==> stopping the service and clearing data"
docker compose stop coupon-service >/dev/null 2>&1 || true
docker compose up -d postgres redis >/dev/null
until docker compose exec -T postgres pg_isready -U semicon -d coupons >/dev/null 2>&1; do sleep 1; done
docker compose exec -T postgres psql -U semicon -d coupons -qc "DROP SCHEMA IF EXISTS coupon_svc CASCADE" 2>/dev/null
docker compose exec -T redis redis-cli FLUSHALL >/dev/null

echo "==> rebuilding and starting (OFFER_MODE=$MODE)"
docker compose up -d --build coupon-service web >/dev/null

echo "==> waiting for the API"
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> seeding"
docker compose exec -T coupon-service python -m scripts.seed
docker compose exec -T coupon-service python -m scripts.seed_history

cat <<EOF

Ready (OFFER_MODE=$MODE).
  UI:       http://localhost:5180
  API docs: http://localhost:8000/docs

Create your admin account (prompts for a password, min 10 characters):
  docker compose exec coupon-service python -m scripts.create_admin --username <name>
EOF
