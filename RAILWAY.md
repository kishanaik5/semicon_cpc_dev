# Deploy on Railway

One Railway **project** with three services: the app (this repo, one Docker image that serves the API and the UI),
a Railway **PostgreSQL**, and a Railway **Redis**. Keeping all three in the same project and region gives
millisecond latency between them (the 200 ms target needs this).

## 0. Before you start
- Code is on GitHub (`kishanaik5/semi_con_cpc_dev`, branch `main`) and includes the root `Dockerfile` and `railway.json`.
- Rotate any credential that was ever pasted into chat or `.env` (Aiven, Neon, Upstash, Gemini). You will not need Aiven/Neon/Upstash on Railway.
- Generate three secrets (any password manager, or `openssl rand -hex 32`): `ADMIN_API_KEY`, `INTERNAL_API_KEY`, and an admin password.

## 1. Create the project and databases
1. railway.com -> **New Project** -> **Deploy PostgreSQL**. Name the service `Postgres`.
2. In the same project: **+ New** -> **Database** -> **Add Redis**. Name it `Redis`.
3. Pick the same region for both (Settings -> Region), ideally the one closest to your users.

## 2. Add the app
1. **+ New** -> **GitHub Repo** -> choose `semi_con_cpc_dev` (authorize Railway on GitHub if asked).
2. Railway detects the root `Dockerfile` (and `railway.json`: Dockerfile builder, health check `/health`). No build settings needed.
3. Open the app service -> **Variables** -> **Raw Editor** and paste (replace the `<...>` values):

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
ADMIN_API_KEY=<random 32+ chars>
INTERNAL_API_KEY=<random 32+ chars>
OFFER_MODE=flexible
GEMINI_API_KEY=<your Gemini key>
GEMINI_MODEL=gemini-2.5-flash

# first deploy only (see step 4)
ADMIN_USERNAME=<your admin name>
ADMIN_PASSWORD=<min 10 chars>
SEED_ON_START=true
SEED_HISTORY_ON_START=true
```

- `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}` are Railway reference variables: they resolve to the **private network** URLs (`*.railway.internal`), which are fast and free of egress. The service name inside `${{ }}` must match your service names exactly.
- Do **not** set `NEON_DB_URL` (it overrides `DATABASE_URL`).
- `PORT` is injected by Railway; the image already listens on it.

## 3. Expose it
App service -> **Settings** -> **Networking** -> **Generate Domain**. You get `https://<name>.up.railway.app`.
HTTPS is terminated by Railway; the admin cookie is marked `Secure` automatically.

## 4. First boot
Deploy runs: build (about 2-3 min: React build + Python deps) -> health check `/health` -> live.
On the first start the app creates the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, seeds the 5 demo coupons (only because the DB is empty) and, a few seconds later, the 30-day dashboard history.

Then open `https://<name>.up.railway.app/admin`, sign in, and **go back to Variables and delete `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `SEED_ON_START`, `SEED_HISTORY_ON_START`**. They are only needed once, and the account lives in the database now.

Checks:
- `/health` -> `{"ok":true,...,"redis":true}`
- `/docs` -> API docs
- `/checkout` -> storefront; `/admin` -> PF Admin (Analytics -> **AI summary** uses Gemini)

## 5. Day-two operations
| Need | How |
|---|---|
| Redeploy | push to `main` (auto-deploys) or **Deploy** -> Redeploy |
| Reset demo data | Postgres service -> **Data** -> run `DROP SCHEMA coupon_svc CASCADE;`, then set `SEED_ON_START=true` + `SEED_HISTORY_ON_START=true` and redeploy (re-create the admin via `ADMIN_USERNAME` / `ADMIN_PASSWORD`) |
| New / reset admin password | set `ADMIN_USERNAME` + `ADMIN_PASSWORD`, redeploy. Existing accounts are not overwritten, so for a reset delete the row first: `DELETE FROM coupon_svc.admin_users WHERE username='<name>';` |
| Logs | app service -> **Deployments** -> View logs |
| Strict 1:1 offer mapping demo | `OFFER_MODE=strict`, redeploy |
| Payment/auth webhooks (other services) | call `/coupons/confirm`, `/coupons/release`, `/internal/events/*` with header `X-Service-Key: <INTERNAL_API_KEY>` |

## Troubleshooting
- **Health check fails / crash loop**: open the deploy logs. Usual causes: `DATABASE_URL` or `REDIS_URL` reference typo (service name mismatch), or `NEON_DB_URL` still set.
- **`Name or service not known: ...railway.internal`**: the app and database are not in the same project/environment; recreate the reference variable.
- **Redis error with TLS**: Railway Redis is plain `redis://` on the private network. Do not rewrite it to `rediss://` (the app only upgrades Upstash URLs).
- **Cannot sign in after deploy**: remember the admin is created only if `ADMIN_USERNAME` does not exist yet and both variables were set at boot.
- **AI says the model is not available**: set `GEMINI_MODEL` to a model your key lists (default `gemini-2.5-flash`).
- **Slow first request**: the free/trial plan may sleep or be rate limited; Hobby plan keeps the service running.

## Cost note
Three small services on the Hobby plan (about 5 USD/month credit included) are typically enough for a demo. Postgres and Redis are billed by usage; stop the project when you are not demoing if you are on a trial.
