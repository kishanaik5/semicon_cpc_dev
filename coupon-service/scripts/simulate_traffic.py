"""Generate a few hundred randomized apply attempts so the dashboard has something to show.
Run with the API up:  python -m scripts.simulate_traffic [http://localhost:8000]
Note: each user is limited to 10 applies / 10 min, so the simulator spreads traffic over many users."""
import asyncio
import random
import sys
import time

import httpx

from app.config import settings

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
SVC = {"X-Service-Key": settings.internal_api_key}
GUESSES = ["SUPER50", "FREE100", "HACK2026", "TESTCODE", "SL-AAAAAAAAAA", "VIP-XXXXXXXX"]


async def main():
    tag = str(int(time.time()))
    stats = {"validate_ok": 0, "validate_rej": 0, "paid": 0, "failed": 0}
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        for i in range(300):
            user = 5000 + i // 3
            code = random.choices(["LAUNCH10", "OLDPROMO", None], weights=[5, 2, 3])[0] or random.choice(GUESSES)
            ip = f"10.0.{random.randint(0, 3)}.{random.randint(1, 250)}"
            h = {"X-Forwarded-For": ip}
            r = await c.post("/coupons/validate", headers=h,
                             json={"code": code, "user_id": user, "subtotal": random.choice([999, 1999, 4999])})
            stats["validate_ok" if r.status_code == 200 else "validate_rej"] += 1
            if r.status_code == 200 and random.random() < 0.7:
                oid = f"sim-{tag}-{i}"
                rr = await c.post("/coupons/reserve", headers=h, json={
                    "code": code, "user_id": user, "order_id": oid, "subtotal": 1999})
                if rr.status_code == 200:
                    paid = random.random() < 0.8
                    await c.post("/coupons/confirm" if paid else "/coupons/release", headers=SVC,
                                 json={"order_id": oid})
                    stats["paid" if paid else "failed"] += 1
    print(stats)


asyncio.run(main())
