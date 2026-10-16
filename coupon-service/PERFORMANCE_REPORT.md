# Performance report

_Generated 2026-10-16 06:39 UTC. Target from the spec: coupon validation under 200 ms._

## Environment

- Machine: Linux container, 24 CPU cores visible, Python 3.12.15
- API: FastAPI on uvicorn, **4 worker process(es)**; PostgreSQL 16.15 and Redis 7.4.11 in local Docker containers
- Raw round trip from the API container: PostgreSQL `SELECT 1` **0.14 ms**, Redis `PING` **0.07 ms**
- Latencies are measured by the client (full HTTP round trip on localhost, including JSON encode/decode)

## Latency and throughput

| Scenario | Requests | Concurrency | Req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| validate, Redis cache hit (one request at a time) | 300 | 1 | 491 | 2.0 | 2.5 | 2.8 | 3.0 | 0 | PASS |
| validate, Redis cache hit (under load) | 6000 | 48 | 1,938 | 18.6 | 42.5 | 61.7 | 100.6 | 0 | PASS |
| validate, cache miss (DB lookup) | 300 | 1 | 325 | 2.8 | 3.5 | 5.4 | 5.9 | 0 | PASS |
| reserve, ONE hot campaign (worst case) | 1200 | 48 | 370 | 79.4 | 304.2 | 513.4 | 811.8 | 0 | info (target is for validation) |
| confirm (payment webhook) | 1200 | 48 | 1,191 | 23.2 | 45.7 | 66.5 | 90.9 | 0 | info (target is for validation) |
| reserve, load spread over 8 campaigns | 1200 | 48 | 758 | 46.0 | 86.0 | 111.3 | 126.4 | 0 | info (target is for validation) |

## Correctness under load

| Check | Result | Detail |
|---|---|---|
| 100 parallel reserves on a campaign capped at 10 | PASS | 10 redeemed, 90 rejected as EXHAUSTED, finished in 189 ms |
| retrying the same reserve is idempotent | PASS | same redemption id returned |
| a second coupon on the same order is rejected | PASS | HTTP 409 ONE_PER_ORDER |
| rate limit: 10 attempts / 10 min per user | PASS | attempts 1-10 answered normally, 11-14 -> HTTP 429 (4 blocked) |

## Reading the numbers

- **Cache hit** is the normal checkout path: rate-limit counters + the cached coupon definition in Redis, then one database query for the per-user rules.
- **Cache miss** adds the join that loads code, campaign and offer from PostgreSQL (the definition is cached for 60 s).
- **reserve** is the expensive step on purpose: a transaction with an advisory lock, a conditional UPDATE on the global cap and on the code, and the redemption insert; this is what guarantees no coupon is redeemed beyond its limits.
- The spec's 200 ms target applies to **validation**, so only validation rows carry a PASS/FAIL verdict (p95 < 200 ms, no errors). Reserve and confirm are reported for information.
- **Hot campaign**: every redemption of the same coupon must update one counter row so that the global cap can never be exceeded; those updates are serialized by PostgreSQL. That is the price of the strict guarantee, and it is why the single-campaign row is the slowest. When load is spread over several campaigns (the realistic case) throughput scales with it. For a single flash-sale coupon the design's optional Redis counter pre-gate (`cap:{campaign_id}`) or sharded counters would lift the ceiling.
- Throughput scales with more uvicorn workers (`--workers N`) since the service is stateless; Redis and PostgreSQL hold all state.
