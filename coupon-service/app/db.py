import ssl
from urllib.parse import urlsplit

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .config import settings

SCHEMA = "coupon_svc"  # own schema, so we never touch the other app's tables in the same DB

_args: dict = {"server_settings": {"search_path": SCHEMA}}
_host = urlsplit(settings.database_url).hostname or ""
if _host not in ("localhost", "127.0.0.1", "postgres") and not _host.endswith(".railway.internal"):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False          # managed free-tier DB (Aiven); use its CA cert in production
    ctx.verify_mode = ssl.CERT_NONE
    _args["ssl"] = ctx

engine = create_async_engine(
    settings.database_url, pool_size=settings.db_pool_size, max_overflow=settings.db_pool_overflow, pool_recycle=240, pool_timeout=60, connect_args=_args
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    from .models import Base

    async with engine.begin() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(727001)"))   # several workers start at once: one sets up the schema
        await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        await conn.run_sync(Base.metadata.create_all)
        for stmt in _ADD_COLUMNS:      # create_all never alters existing tables
            await conn.execute(text(stmt))


_ADD_COLUMNS = [
    "ALTER TABLE offers ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true",
    "ALTER TABLE offers ADD COLUMN IF NOT EXISTS description text",
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meta jsonb",
    "ALTER TABLE coupon_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal numeric(12,2)",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount numeric(12,2)",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS description text",
    "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS converted_at timestamptz",
]
