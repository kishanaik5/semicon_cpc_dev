"""Performance + correctness benchmark for the coupon service. Prints a Markdown report on stdout.

Run it inside the container (so it can reach Redis/Postgres directly and uses the real config):

    docker compose exec -T coupon-service python -m scripts.benchmark > coupon-service/PERFORMANCE_REPORT.md

It creates its own throw-away campaigns and orders, and deletes everything it created when it finishes,
so the demo data and dashboard are untouched. Progress goes to stderr.
"""
import asyncio
import multiprocessing as mp
import os
import platform
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import httpx
from sqlalchemy import text

from app import cache
from app import service as svc
from app.config import settings
from app.db import SessionLocal, engine

BASE = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
ADMIN = {"X-Admin-Key": settings.admin_api_key}
SVC = {"X-Service-Key": settings.internal_api_key}
TARGET_P95_MS = 200
TAG = str(int(time.time()))
USER0 = int(TAG) * 1000                       # unique user ids for this run


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def ip_for(i: int) -> str:                    # a distinct client IP per request keeps the per-IP limiter out of the way
    return f"10.{(i >> 16) & 255}.{(i >> 8) & 255}.{i & 255}"


def pct(sorted_ms: list[float], p: float) -> float:
    return sorted_ms[min(len(sorted_ms) - 1, int(len(sorted_ms) * p))]


class Result:
    def __init__(self, name, n, conc, lat, errors, seconds, gated=True):
        self.name, self.n, self.conc, self.errors, self.gated = name, n, conc, errors, gated
        lat = sorted(lat)
        self.p50, self.p95, self.p99, self.max = pct(lat, .50), pct(lat, .95), pct(lat, .99), lat[-1]
        self.mean = statistics.fmean(lat)
        self.rps = n / seconds if seconds else 0

    def row(self) -> str:
        if not self.gated:
            verdict = "info (target is for validation)" if self.errors == 0 else "FAIL (errors)"
        else:
            verdict = "PASS" if self.p95 < TARGET_P95_MS and self.errors == 0 else "FAIL"
        return (f"| {self.name} | {self.n} | {self.conc} | {self.rps:,.0f} | {self.p50:.1f} | {self.p95:.1f} | "
                f"{self.p99:.1f} | {self.max:.1f} | {self.errors} | {verdict} |")


async def run(name, n, conc, one, warm=20, gated=True) -> Result:
    """Fire n requests with `conc` in flight. one(i) -> (ok, latency_ms)."""
    log(f"  {name}: {n} requests @ concurrency {conc} ...")
    for i in range(warm):
        await one(-1 - i)
    sem, lat, errors = asyncio.Semaphore(conc), [], 0

    async def task(i):
        nonlocal errors
        async with sem:
            ok, ms = await one(i)
        lat.append(ms)
        errors += 0 if ok else 1

    t0 = time.perf_counter()
    await asyncio.gather(*(task(i) for i in range(n)))
    return Result(name, n, conc, lat, errors, time.perf_counter() - t0, gated)


def _load_worker(args):
    """Runs in its own process: one asyncio loop with its own HTTP client. Returns [(ok, ms), ...]."""
    base, kind, code, tag, user0, start, count, conc = args

    async def go():
        sem, out = asyncio.Semaphore(conc), []
        limits = httpx.Limits(max_connections=conc + 4, max_keepalive_connections=conc + 4)
        async with httpx.AsyncClient(base_url=base, timeout=60, limits=limits) as c:
            codes = code.split(",")

            async def one(i):
                code_i = codes[i % len(codes)]               # several codes = load spread over several campaigns
                h = {"X-Forwarded-For": ip_for(i & 0xFFFFFF)}
                if kind == "validate":
                    req = ("/coupons/validate", h, {"code": code_i, "user_id": user0 + i, "subtotal": 1999})
                elif kind == "reserve":
                    req = ("/coupons/reserve", h, {"code": code_i, "user_id": user0 + 500_000 + i,
                                                   "order_id": f"bench-{tag}-{i}", "subtotal": 4999})
                else:
                    req = ("/coupons/confirm", {"X-Service-Key": settings.internal_api_key}, {"order_id": f"bench-{tag}-{i}"})
                async with sem:
                    t = time.perf_counter()
                    r = await c.post(req[0], headers=req[1], json=req[2])
                    out.append((r.status_code == 200, (time.perf_counter() - t) * 1000))
            await asyncio.gather(*(one(i) for i in range(start, start + count)))
        return out

    return asyncio.run(go())


async def run_parallel(name, kind, code, n, conc, procs=4, offset=0, gated=True) -> "Result":
    """Same as run(), but the load comes from several client processes so the client is never the bottleneck."""
    log(f"  {name}: {n} requests @ concurrency {conc} from {procs} client processes ...")
    per, cper = n // procs, max(1, conc // procs)
    jobs = [(BASE, kind, code, TAG, USER0, offset + k * per, per, cper) for k in range(procs)]
    loop = asyncio.get_running_loop()
    with ProcessPoolExecutor(procs, mp_context=mp.get_context("spawn")) as pool:
        t0 = time.perf_counter()
        parts = await asyncio.gather(*(loop.run_in_executor(pool, _load_worker, j) for j in jobs))
        seconds = time.perf_counter() - t0
    flat = [x for p in parts for x in p]
    return Result(name, len(flat), cper * procs, [ms for _, ms in flat], sum(1 for ok, _ in flat if not ok), seconds, gated)


async def timed(c: httpx.AsyncClient, method: str, url: str, expect: int = 200, **kw):
    t = time.perf_counter()
    r = await c.request(method, url, **kw)
    return r.status_code == expect, (time.perf_counter() - t) * 1000, r


async def main():
    log(f"benchmark against {BASE}")
    created_campaigns: list[int] = []
    async with SessionLocal() as s:
        event_mark = (await s.execute(text("SELECT COALESCE(max(id),0) FROM coupon_events"))).scalar_one()

    limits = httpx.Limits(max_connections=200, max_keepalive_connections=100)
    async with httpx.AsyncClient(base_url=BASE, timeout=60, limits=limits) as c:
        pct_offer = next(o for o in (await c.get("/admin/offers", headers=ADMIN)).json() if o["benefit_type"] == "percent")

        async def campaign(code: str, cap=None, per_user=1) -> int:
            r = await c.post("/admin/campaigns", headers=ADMIN, json={
                "name": f"bench-{TAG}-{code}", "kind": "fixed", "offer_id": pct_offer["id"], "code": code,
                "starts_at": "2020-01-01T00:00:00Z", "ends_at": "2099-01-01T00:00:00Z",
                "max_redemptions": cap, "max_per_user": per_user})
            r.raise_for_status()
            created_campaigns.append(r.json()["id"])
            return r.json()["id"]

        code = f"BENCH{TAG}"
        await campaign(code)
        results: list[Result] = []

        # ---- 1-2. validate with the code definition cached in Redis ----
        async def validate(i):
            ok, ms, _ = await timed(c, "POST", "/coupons/validate", headers={"X-Forwarded-For": ip_for(i & 0xFFFFFF)},
                                    json={"code": code, "user_id": USER0 + i, "subtotal": 1999})
            return ok, ms

        log("1. validate (cache hit)")
        results.append(await run("validate, Redis cache hit (one request at a time)", 300, 1, validate))
        results.append(await run_parallel("validate, Redis cache hit (under load)", "validate", code, 6000, 48))

        # ---- 3. validate with the cache emptied before every request ----
        async def validate_cold(i):
            await cache.delete(svc.def_key(code))
            return await validate(i + 100_000)

        log("2. validate (cache miss)")
        results.append(await run("validate, cache miss (DB lookup)", 300, 1, validate_cold))

        # ---- 4-5. the full redemption lifecycle ----
        log("3. reserve + confirm")
        results.append(await run_parallel("reserve, ONE hot campaign (worst case)", "reserve", code, 1200, 48, gated=False))
        results.append(await run_parallel("confirm (payment webhook)", "confirm", code, 1200, 48, gated=False))
        spread = []
        for k in range(8):
            spread.append(f"SPREAD{k}{TAG}")
            await campaign(spread[-1])
        results.append(await run_parallel("reserve, load spread over 8 campaigns", "reserve", ",".join(spread), 1200, 48,
                                          offset=50_000, gated=False))

        # ---- correctness under concurrency ----
        log("4. correctness checks")
        checks: list[tuple[str, bool, str]] = []

        gate_code = f"GATE{TAG}"
        await campaign(gate_code, cap=10)

        async def gate(i):
            r = await c.post("/coupons/reserve", headers={"X-Forwarded-For": ip_for(300_000 + i)},
                             json={"code": gate_code, "user_id": USER0 + 900_000 + i, "order_id": f"bench-{TAG}-g{i}",
                                   "subtotal": 1000})
            return r.status_code
        t0 = time.perf_counter()
        codes = await asyncio.gather(*(gate(i) for i in range(100)))
        gate_ms = (time.perf_counter() - t0) * 1000
        won = codes.count(200)
        checks.append(("100 parallel reserves on a campaign capped at 10", won == 10,
                       f"{won} redeemed, {codes.count(400)} rejected as EXHAUSTED, finished in {gate_ms:.0f} ms"))

        # same order retried -> same answer; a second coupon on the same order -> rejected
        body = {"code": code, "user_id": USER0 + 700_000, "order_id": f"bench-{TAG}-idem", "subtotal": 2000}
        a = await c.post("/coupons/reserve", json=body, headers={"X-Forwarded-For": ip_for(400_001)})
        b = await c.post("/coupons/reserve", json=body, headers={"X-Forwarded-For": ip_for(400_002)})
        checks.append(("retrying the same reserve is idempotent", a.status_code == b.status_code == 200
                       and a.json().get("redemption_id") == b.json().get("redemption_id"), "same redemption id returned"))
        other_code = f"OTHER{TAG}"
        await campaign(other_code)                                  # a second, uncapped coupon
        second = await c.post("/coupons/reserve", headers={"X-Forwarded-For": ip_for(400_003)},
                              json={**body, "code": other_code})
        checks.append(("a second coupon on the same order is rejected", second.status_code == 409,
                       f"HTTP {second.status_code} {second.json().get('reason')}"))

        # brute force: one user hammering the validate endpoint
        statuses = []
        for k in range(14):
            r = await c.post("/coupons/validate", headers={"X-Forwarded-For": ip_for(500_000 + k)},
                             json={"code": "GUESS" + str(k), "user_id": USER0 + 800_000, "subtotal": 1000})
            statuses.append(r.status_code)
        checks.append(("rate limit: 10 attempts / 10 min per user", statuses[:10].count(429) == 0 and statuses[10:].count(429) == 4,
                       f"attempts 1-10 answered normally, 11-14 -> HTTP 429 ({statuses.count(429)} blocked)"))

        # ---- environment: raw round-trip times to the data stores ----
        async def avg_ms(fn, n=100):
            t = time.perf_counter()
            for _ in range(n):
                await fn()
            return (time.perf_counter() - t) / n * 1000
        async with engine.connect() as conn:
            pg_ms = await avg_ms(lambda: conn.execute(text("SELECT 1")))
            pg_version = (await conn.execute(text("SHOW server_version"))).scalar()
        redis_ms = await avg_ms(cache.r.ping)
        redis_version = (await cache.r.info("server")).get("redis_version", "?")

    # ---- clean up everything this run created ----
    async with SessionLocal() as s:
        ids = created_campaigns
        await s.execute(text("DELETE FROM redemptions WHERE campaign_id = ANY(:ids)"), {"ids": ids})
        await s.execute(text("DELETE FROM orders WHERE id LIKE :p"), {"p": f"bench-{TAG}-%"})
        await s.execute(text("DELETE FROM coupon_events WHERE id > :m AND (campaign_id = ANY(:ids) OR user_id >= :u)"),
                        {"m": event_mark, "ids": ids, "u": USER0})
        await s.execute(text("DELETE FROM coupon_codes WHERE campaign_id = ANY(:ids)"), {"ids": ids})
        await s.execute(text("DELETE FROM campaigns WHERE id = ANY(:ids)"), {"ids": ids})
        await s.commit()
    log("cleaned up benchmark data")

    # ---- report ----
    print("# Performance report\n")
    print(f"_Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}. Target from the spec: coupon validation under "
          f"{TARGET_P95_MS} ms._\n")
    print("## Environment\n")
    print(f"- Machine: {platform.system()} container, {os.cpu_count()} CPU cores visible, Python {platform.python_version()}")
    print("- API: FastAPI on uvicorn, **%s worker process(es)**; PostgreSQL %s and Redis %s in local Docker containers" %
          (os.environ.get("WEB_CONCURRENCY", "1"), pg_version.split()[0], redis_version))
    print(f"- Raw round trip from the API container: PostgreSQL `SELECT 1` **{pg_ms:.2f} ms**, Redis `PING` **{redis_ms:.2f} ms**")
    print("- Latencies are measured by the client (full HTTP round trip on localhost, including JSON encode/decode)\n")
    print("## Latency and throughput\n")
    print("| Scenario | Requests | Concurrency | Req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Verdict |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for r in results:
        print(r.row())
    print("\n## Correctness under load\n")
    print("| Check | Result | Detail |")
    print("|---|---|---|")
    for name, ok, detail in checks:
        print(f"| {name} | {'PASS' if ok else 'FAIL'} | {detail} |")
    print("\n## Reading the numbers\n")
    print("- **Cache hit** is the normal checkout path: rate-limit counters + the cached coupon definition in Redis, then one "
          "database query for the per-user rules.")
    print("- **Cache miss** adds the join that loads code, campaign and offer from PostgreSQL (the definition is cached for 60 s).")
    print("- **reserve** is the expensive step on purpose: a transaction with an advisory lock, a conditional UPDATE on the global "
          "cap and on the code, and the redemption insert; this is what guarantees no coupon is redeemed beyond its limits.")
    print("- The spec's 200 ms target applies to **validation**, so only validation rows carry a PASS/FAIL verdict (p95 < 200 ms, no errors). "
          "Reserve and confirm are reported for information.")
    print("- **Hot campaign**: every redemption of the same coupon must update one counter row so that the global cap can never be exceeded; "
          "those updates are serialized by PostgreSQL. That is the price of the strict guarantee, and it is why the single-campaign row is the "
          "slowest. When load is spread over several campaigns (the realistic case) throughput scales with it. For a single flash-sale coupon "
          "the design's optional Redis counter pre-gate (`cap:{campaign_id}`) or sharded counters would lift the ceiling.")
    print("- Throughput scales with more uvicorn workers (`--workers N`) since the service is stateless; Redis and PostgreSQL hold all state.")
    failed = [r for r in results if (r.gated and r.p95 >= TARGET_P95_MS) or r.errors] + [1 for _, ok, _ in checks if not ok]
    log("ALL PASS" if not failed else "SOME CHECKS FAILED")


if __name__ == "__main__":
    asyncio.run(main())
