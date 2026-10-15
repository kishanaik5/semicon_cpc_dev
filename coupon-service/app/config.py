"""Settings. Reads .env from coupon-service/ or the repo root (ENV_FILE overrides)."""
import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_HERE = Path(__file__).resolve().parents[1]
_ENV_FILES = (_HERE / ".env", _HERE.parent / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=os.getenv("ENV_FILE") or _ENV_FILES, extra="ignore"
    )

    database_url: str = ""
    neon_db_url: str = ""                 # preferred when set (own free Postgres for this service)
    redis_url: str
    offer_mode: str = "strict"            # strict | flexible
    reservation_ttl_min: int = 15
    admin_api_key: str = "semicon-admin-dev-key"
    internal_api_key: str = "semicon-internal-dev-key"
    pin_max_attempts: int = 5
    rate_limit_max: int = 10              # apply attempts ...
    rate_limit_window_s: int = 600        # ... per 10 minutes, per user and per IP
    cache_ttl_s: int = 60
    worker_interval_s: int = 30
    code_style: str = "words"            # words (demo: SL-MANGO-TIGER-42) | random (SL-K7M2-PQ4X)
    code_length: int = 8                  # random characters in generated codes (the PDF suggests 10-12)
    gemini_api_key: str = ""              # free-tier key from aistudio.google.com (blank = AI button disabled)
    gemini_model: str = "gemini-2.5-flash"
    admin_username: str = ""              # optional bootstrap: creates this admin on first start if it does not exist
    admin_password: str = ""
    seed_on_start: bool = False           # seed the 5 demo coupons when the DB is empty
    seed_history_on_start: bool = False   # ...and the 30-day dashboard history
    admin_idle_minutes: int = 15          # sign out after this much inactivity
    admin_session_hours: int = 8          # hard cap on a session's lifetime

    @field_validator("database_url", "neon_db_url")
    @classmethod
    def _db(cls, v: str) -> str:
        if not v:
            return v
        p = urlsplit(v.strip())
        # asyncpg's prepared-statement cache needs the DIRECT endpoint, not Neon's -pooler one
        return urlunsplit(("postgresql+asyncpg", p.netloc.replace("-pooler", ""), p.path, "", ""))

    @field_validator("redis_url")
    @classmethod
    def _redis(cls, v: str) -> str:
        m = re.search(r"rediss?://\S+", v)           # tolerate a pasted redis-cli command line
        url = m.group(0) if m else v.strip()
        host = urlsplit(url).hostname or ""
        if url.startswith("redis://") and host.endswith("upstash.io"):
            url = "rediss://" + url[len("redis://"):]  # Upstash is TLS-only; Railway/local Redis are not
        return url


settings = Settings()
if settings.neon_db_url:
    settings.database_url = settings.neon_db_url
