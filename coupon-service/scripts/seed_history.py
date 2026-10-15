"""Fill the dashboard with ~30 days of realistic demo history (without creating extra coupons).

Real activity goes through the running service (so every counter, audit event and rule is genuine),
then the rows are backdated across the last 30 days. Runs inside the container:

    docker compose exec coupon-service python -m scripts.seed_history

Safe to re-run: it adds another batch each time.
"""
import asyncio
import random
import sys

import httpx
from sqlalchemy import text

from app import service as svc
from app.db import SessionLocal, init_db

BASE = "http://localhost:8000"
PLANS = [("Lab Access · Monthly", 1999), ("Lab Access · Annual", 14999),
         ("Team Lab · 10 seats", 49999), ("Enterprise Lab", 149999)]
NAMES = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Ishita", "Vikram", "Ananya", "Arjun", "Sneha", "Karan", "Neha",
         "Aditya", "Pooja", "Siddharth", "Riya", "Manav", "Tara", "Yash", "Kavya", "Dev", "Nisha", "Rahul", "Zoya"]
GUESSES = ["SUPER50", "FREE100", "HACK2026", "TESTCODE", "WINTER99", "ADMIN", "COUPON", "SAVE90", "DIWALI50", "PROMO"]


async def make_users(c: httpx.AsyncClient, n: int) -> list[int]:
    ids = []
    for i in range(n):
        name = f"{random.choice(NAMES)} {random.choice(['Sharma', 'Rao', 'Nair', 'Gupta', 'Iyer', 'Das', 'Khan', 'Mehta'])}"
        r = await c.post("/api/users/register", json={
            "name": name, "email": f"{name.split()[0].lower()}.{random.randint(1000, 9999)}@example.com",
            "account_type": random.choice(["INDIVIDUAL"] * 3 + ["ORGANIZATION"])})
        if r.status_code == 201:
            ids.append(r.json()["user"]["id"])
    return ids


async def main(base: str | None = None):
    await init_db()
    async with SessionLocal() as s:
        mark = (await s.execute(text("SELECT COALESCE(max(id),0) FROM coupon_events"))).scalar_one()
        omark = (await s.execute(text("SELECT count(*) FROM orders"))).scalar_one()
    codes = ["LAUNCH10"]                      # the only public multi-use coupon; the demo keeps exactly 5 coupons
    async with SessionLocal() as s:           # no signup/referral coupons issued while we create customers
        await s.execute(text("UPDATE campaigns SET status='paused' WHERE kind IN ('signup','referral') AND status='active'"))
        await s.commit()
    stats = {"orders": 0, "coupon_orders": 0, "rejected": 0}

    async with httpx.AsyncClient(base_url=base or BASE, timeout=60) as c:
        users = await make_users(c, 28)
        async with SessionLocal() as s:                      # referrers/referees: some converted, some pending
            pass
        refs = [(await c.get("/api/users")).json()]
        referrer_codes = [u["referral_code"] for u in refs[0] if u["id"] in (1, 2, 3)]
        ref_users = []
        for i in range(8):
            r = await c.post("/api/users/register", json={
                "name": f"Referred {random.choice(NAMES)}", "email": f"ref{random.randint(10000, 99999)}@example.com",
                "account_type": "INDIVIDUAL", "referral_code": random.choice(referrer_codes)})
            if r.status_code == 201:
                ref_users.append(r.json()["user"]["id"])

        everyone = users + ref_users
        for step in range(170):
            u = random.choice(everyone)
            ip = f"103.{random.randint(20, 90)}.{random.randint(0, 250)}.{random.randint(1, 250)}"
            h = {"X-Forwarded-For": ip}
            plan_name, price = random.choices(PLANS, weights=[6, 3, 2, 1])[0]
            roll = random.random()
            code = random.choice(codes) if roll < 0.62 else random.choice(GUESSES) if roll < 0.82 else None
            if code is None:                                  # plain order, no coupon
                r = await c.post("/api/checkout", headers=h, json={"user_id": u, "subtotal": price, "description": plan_name})
                if r.status_code == 200:
                    stats["orders"] += 1
                continue
            v = await c.post("/api/checkout/validate", headers=h, json={"user_id": u, "subtotal": price, "coupon_code": code})
            if v.status_code != 200:
                stats["rejected"] += 1
                continue
            r = await c.post("/api/checkout", headers=h, json={
                "user_id": u, "subtotal": price, "description": plan_name, "coupon_code": code})
            if r.status_code == 200:
                stats["orders"] += 1
                stats["coupon_orders"] += 1

        # abuse signals: hammer with guesses from one user/IP (rate limit) and lock one PIN coupon
        for _ in range(14):
            await c.post("/api/checkout/validate", headers={"X-Forwarded-For": "45.134.140.22"},
                         json={"user_id": everyone[0], "subtotal": 1999, "coupon_code": random.choice(GUESSES)})
        async with SessionLocal() as s:
            vip = (await s.execute(text("SELECT code FROM coupon_codes WHERE assigned_user_id=101 AND pin_hash IS NOT NULL LIMIT 1"))).scalar()
        if vip:
            for _ in range(5):
                await c.post("/api/checkout/validate", headers={"X-Forwarded-For": "152.58.16.89"},
                             json={"user_id": 101, "subtotal": 1999, "coupon_code": vip, "pin": "0000"})

        # converted referrals: referees buy for the first time
        for u in ref_users[:5]:
            await c.post("/api/checkout", json={"user_id": u, "subtotal": 14999, "description": "Lab Access · Annual"})

    # spread everything created by this run over the last 30 days (orders first, then their redemptions/events)
    async with SessionLocal() as s:
        await s.execute(text("""
            UPDATE orders SET created_at = now() - (random() * 29 * interval '1 day')
            WHERE id IN (SELECT id FROM orders ORDER BY created_at DESC LIMIT GREATEST((SELECT count(*) FROM orders) - :o, 0))"""),
            {"o": omark})
        await s.execute(text("""
            UPDATE redemptions r SET created_at = o.created_at, confirmed_at = o.created_at + interval '2 minutes',
                   reserved_until = o.created_at + interval '15 minutes'
            FROM orders o WHERE o.id = r.order_id AND r.created_at > now() - interval '1 day'"""))
        await s.execute(text("""
            UPDATE coupon_events e SET created_at = o.created_at + interval '1 minute'
            FROM orders o WHERE e.id > :m AND e.payload->>'order_id' = o.id"""), {"m": mark})
        await s.execute(text("""
            UPDATE coupon_events SET created_at = now() - (random() * 29 * interval '1 day')
            WHERE id > :m AND (payload->>'order_id' IS NULL)"""), {"m": mark})
        await s.execute(text("""
            UPDATE referrals SET created_at = now() - (random() * 20 * interval '1 day'),
                   converted_at = CASE WHEN converted_at IS NOT NULL THEN now() - (random() * 10 * interval '1 day') END
            WHERE created_at > now() - interval '1 day'"""))
        await s.execute(text("UPDATE campaigns SET status='active' WHERE kind IN ('signup','referral') AND status='paused'"))
        # history used LAUNCH10's cap of 5; leave 5 more so the live "6th user is rejected" demo still works
        await s.execute(text("UPDATE campaigns SET max_redemptions = redeemed_count + 5 WHERE id = "
                             "(SELECT campaign_id FROM coupon_codes WHERE code='LAUNCH10')"))
        await s.commit()
    print("history seeded:", stats)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
