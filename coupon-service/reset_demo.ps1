# Reset the local demo to a clean, seeded state.
#   .\reset_demo.ps1            -> OFFER_MODE=flexible (UI can create any offer/coupon combination)
#   .\reset_demo.ps1 strict     -> OFFER_MODE=strict   (shows the 1:1 mapping rejection)
param([ValidateSet("flexible", "strict")][string]$Mode = "flexible")

Set-Location (Split-Path $PSScriptRoot -Parent)          # repo root, where docker-compose.yml lives
$env:OFFER_MODE = $Mode

docker compose stop coupon-service | Out-Null
docker compose exec -T postgres psql -U semicon -d coupons -qc "DROP SCHEMA IF EXISTS coupon_svc CASCADE" 2>$null
docker compose exec -T redis redis-cli FLUSHALL | Out-Null
docker compose up -d --build coupon-service web | Out-Null
Start-Sleep -Seconds 8
docker compose exec -T coupon-service python -m scripts.seed
docker compose exec -T coupon-service python -m scripts.seed_history
Write-Host "`nReady (OFFER_MODE=$Mode). UI: http://localhost:5180   API docs: http://localhost:8000/docs"
