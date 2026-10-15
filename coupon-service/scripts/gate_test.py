"""Phase-1 gate: 100 parallel reserves on a campaign capped at 10 must give exactly 10 redemptions.
Run with the API up:  python -m scripts.gate_test [http://localhost:8000]"""
import asyncio
import sys
import time
from collections import Counter

import httpx

from app.config import settings

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
ADMIN = {"X-Admin-Key": settings.admin_api_key}


async def main():
    tag = str(int(time.time()))
    async with httpx.AsyncClient(base_url=BASE, timeout=300, limits=httpx.Limits(max_connections=100)) as c:
        offers = (await c.get("/admin/offers", headers=ADMIN)).json()
        pct = next(o for o in offers if o["benefit_type"] == "percent")
        r = await c.post("/admin/campaigns", headers=ADMIN, json={
            "name": f"gate-{tag}", "kind": "fixed", "offer_id": pct["id"], "code": f"GATE{tag}",
            "starts_at": "2020-01-01T00:00:00Z", "ends_at": "2099-01-01T00:00:00Z",
            "max_redemptions": 10, "max_per_user": 1})
        r.raise_for_status()
        code = r.json()["code"]

        async def hit(i):
            r = await c.post("/coupons/reserve", json={
                "code": code, "user_id": 10_000 + i, "order_id": f"gate-{tag}-{i}", "subtotal": 1000},
                headers={"X-Forwarded-For": f"10.9.{i // 250}.{i % 250 + 1}"})
            return r.status_code, r.json().get("reason")

        res = await asyncio.gather(*(hit(i) for i in range(100)))
    print(Counter(res))
    ok = sum(1 for s, _ in res if s == 200)
    print(f"reserved: {ok} (expected 10)  ->  {'PASS' if ok == 10 else 'FAIL'}")


asyncio.run(main())
