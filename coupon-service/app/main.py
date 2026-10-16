import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from . import api, admin, cache, compat
from . import service as svc
from .config import settings
from .db import SessionLocal, engine, init_db

log = logging.getLogger("coupon")


async def expiry_worker():
    """Background worker: release reservations whose 15-minute TTL has passed."""
    while True:
        try:
            n = await svc.release_expired()
            if n:
                log.info("released %d expired reservations", n)
        except Exception as e:  # noqa: BLE001
            log.warning("expiry worker error: %s", e)
        await asyncio.sleep(settings.worker_interval_s)


async def bootstrap_admin():
    """First deploy: create the admin from ADMIN_USERNAME / ADMIN_PASSWORD if it does not exist yet.
    Remove those variables afterwards; an existing account is never overwritten here."""
    if not (settings.admin_username and settings.admin_password):
        return
    async with SessionLocal() as s:
        exists = (await s.execute(text("SELECT 1 FROM admin_users WHERE username=:u"),
                                  {"u": settings.admin_username.strip().lower()})).first()
        if not exists:
            await s.execute(text("INSERT INTO admin_users(username,password_hash) VALUES (:u,:h) ON CONFLICT (username) DO NOTHING"),
                            {"u": settings.admin_username.strip().lower(), "h": svc.ph.hash(settings.admin_password)})
            await s.commit()
            log.info("bootstrap admin '%s' created", settings.admin_username)


async def seed_on_start():
    """Seed demo data once, when the database is empty (opt-in via SEED_ON_START)."""
    try:
        async with engine.connect() as lock:                     # with several workers only one may seed
            if not (await lock.execute(text("SELECT pg_try_advisory_lock(727002)"))).scalar():
                return
            await _seed_if_empty()
    except Exception as e:  # noqa: BLE001
        log.warning("seed on start failed: %s", e)


async def _seed_if_empty():
    async with SessionLocal() as s:
        empty = not (await s.execute(text("SELECT 1 FROM campaigns LIMIT 1"))).first()
    if not empty:
        return
    from scripts import seed
    await seed.main()
    if settings.seed_history_on_start:
        from scripts import seed_history
        port = os.environ.get("PORT", "8000")
        for _ in range(30):                      # history goes through the HTTP API, so wait for it
            try:
                await cache.r.ping()
                import httpx
                async with httpx.AsyncClient() as c:
                    if (await c.get(f"http://127.0.0.1:{port}/health")).status_code == 200:
                        break
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(1)
        await seed_history.main(f"http://127.0.0.1:{port}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await bootstrap_admin()
    if settings.internal_api_key == "semicon-internal-dev-key" or settings.admin_api_key == "semicon-admin-dev-key":
        log.warning("default ADMIN_API_KEY / INTERNAL_API_KEY in use: set real secrets before exposing this service")
    tasks = [asyncio.create_task(expiry_worker())]
    if settings.seed_on_start:
        tasks.append(asyncio.create_task(seed_on_start()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="SemiconLabs Coupon Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(api.router)
app.include_router(admin.router)
app.include_router(compat.router)


@app.exception_handler(svc.Reject)
async def reject_handler(request: Request, e: svc.Reject):
    if request.url.path.startswith("/api/"):      # the React UI reads {error: {code, message, ...}}
        extra = {"attemptsRemaining": e.extra.get("attempts_left")} if "attempts_left" in e.extra else {}
        return JSONResponse(status_code=e.status, content={"error": {"code": e.reason, "message": e.message, **extra}})
    return JSONResponse(status_code=e.status, content={"ok": False, "reason": e.reason, "message": e.message, **e.extra})


@app.get("/health", tags=["ops"])
async def health():
    redis_ok = True
    try:
        await cache.r.ping()
    except Exception:  # noqa: BLE001
        redis_ok = False
    return {"ok": True, "offer_mode": settings.offer_mode, "redis": redis_ok}


# ---- the built React UI (present in the single-image deploy; absent in local dev) ----
_STATIC = Path(__file__).resolve().parents[1] / "static"
if (_STATIC / "index.html").exists():
    if (_STATIC / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=_STATIC / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("api/", "admin/", "coupons/", "internal/")):
            return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "Not found."}})
        f = (_STATIC / path).resolve()
        if path and f.is_file() and _STATIC in f.parents:
            return FileResponse(f)
        return FileResponse(_STATIC / "index.html")      # client-side routes (/admin, /checkout, ...)
