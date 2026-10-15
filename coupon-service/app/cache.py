"""Redis: cached code lookups, rate limits, PIN-failure counters, idempotency.
Redis only speeds things up / blocks abuse. If it is down we fail open and Postgres still decides."""
import json
import logging

import redis.asyncio as aioredis

from .config import settings

log = logging.getLogger("coupon.redis")
r = aioredis.from_url(settings.redis_url, decode_responses=True, socket_timeout=3)


async def get_json(key: str):
    try:
        v = await r.get(key)
        return json.loads(v) if v else None
    except Exception as e:  # noqa: BLE001
        log.warning("redis get failed: %s", e)
        return None


async def set_json(key: str, value, ttl: int) -> None:
    try:
        await r.set(key, json.dumps(value, default=str), ex=ttl)
    except Exception as e:  # noqa: BLE001
        log.warning("redis set failed: %s", e)


async def delete(*keys: str) -> None:
    try:
        if keys:
            await r.delete(*keys)
    except Exception as e:  # noqa: BLE001
        log.warning("redis delete failed: %s", e)


async def allow(key: str, limit: int, window_s: int) -> bool:
    """Fixed-window counter: True while under the limit."""
    try:
        n = await r.incr(key)
        if n == 1:
            await r.expire(key, window_s)
        return n <= limit
    except Exception as e:  # noqa: BLE001
        log.warning("redis rate-limit failed (fail open): %s", e)
        return True


async def bump(key: str, ttl: int) -> None:
    try:
        await r.incr(key)
        await r.expire(key, ttl)
    except Exception as e:  # noqa: BLE001
        log.warning("redis bump failed: %s", e)


async def allow_many(checks: list[tuple[str, int]], window_s: int) -> bool:
    """Several fixed-window counters in ONE round trip (pipeline). checks = [(key, limit), ...]."""
    if not checks:
        return True
    try:
        pipe = r.pipeline(transaction=False)
        for key, _ in checks:
            pipe.incr(key)
            pipe.expire(key, window_s, nx=True)   # set the TTL only on the first hit
        res = await pipe.execute()
        return all(res[i * 2] <= lim for i, (_, lim) in enumerate(checks))
    except Exception as e:  # noqa: BLE001
        log.warning("redis rate-limit failed (fail open): %s", e)
        return True
