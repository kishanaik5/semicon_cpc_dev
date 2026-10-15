"""Demo seed: one campaign per coupon type (paired per strict mode) plus an expired one.
Run:  python -m scripts.seed      (safe to re-run; skips if already seeded)"""
import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app import service as svc
from app.db import SessionLocal, init_db


async def offer(s, name, bt, value, **kw):
    return (await s.execute(text(
        "INSERT INTO offers(name,benefit_type,value,max_discount,min_cart) VALUES (:n,:b,:v,:m,:c) RETURNING id"),
        {"n": name, "b": bt, "v": value, "m": kw.get("max_discount"), "c": kw.get("min_cart")})).scalar_one()


async def campaign(s, name, kind, offer_id, start, end, **kw):
    svc.check_offer_allowed(kind, (await s.execute(
        text("SELECT benefit_type FROM offers WHERE id=:i"), {"i": offer_id})).scalar())
    return (await s.execute(text(
        "INSERT INTO campaigns(name,kind,offer_id,referrer_offer_id,starts_at,ends_at,max_redemptions,"
        "max_per_user,first_purchase_only) VALUES (:n,:k,:o,:ro,:s,:e,:m,:p,:f) RETURNING id"),
        {"n": name, "k": kind, "o": offer_id, "ro": kw.get("referrer_offer_id"), "s": start, "e": end,
         "m": kw.get("max_redemptions"), "p": kw.get("max_per_user"), "f": kw.get("first_purchase_only", False)}
    )).scalar_one()


async def ui_data():
    """Customers + program settings the storefront UI needs (idempotent)."""
    async with SessionLocal() as s:
        if not (await s.execute(text("SELECT 1 FROM users LIMIT 1"))).first():
            await s.execute(text(
                "INSERT INTO users(id,name,email,account_type,referral_code) VALUES "
                "(1,'Asha Verma','asha.verma@example.com','INDIVIDUAL','ASHA8K2PQ'),"
                "(2,'Rahul Nair','rahul.nair@example.com','INDIVIDUAL','RAHU4M7XZ'),"
                "(3,'Priya Iyer','priya.iyer@acme.io','ORGANIZATION','PRIY9T3WD'),"
                "(101,'VIP Customer','vip101@example.com','INDIVIDUAL','VIPA2B3CD'),"
                "(102,'VIP Customer 2','vip102@example.com','INDIVIDUAL','VIPB4E5FG') ON CONFLICT DO NOTHING"))
            await s.execute(text("SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT max(id) FROM users),1000))"))
        for kind, meta in (("signup", '{"validity_days": 30}'),
                           ("referral", '{"validity_days": 30, "trigger": "FIRST_PURCHASE"}')):
            await s.execute(text("UPDATE campaigns SET meta = CAST(:m AS jsonb) WHERE kind=:k AND meta IS NULL"),
                            {"m": meta, "k": kind})
        await s.commit()


async def main():
    await init_db()
    t = datetime.now(timezone.utc)
    start, end = t - timedelta(days=1), t + timedelta(days=90)
    async with SessionLocal() as s:
        if (await s.execute(text("SELECT 1 FROM coupon_codes WHERE code='LAUNCH10'"))).first():
            await ui_data()
            print("Already seeded (UI customers/settings ensured).")
            return
        o_pct = await offer(s, "10% off", "percent", 10, max_discount=2000)
        o_flat = await offer(s, "500 off", "flat", 500)
        o_hours = await offer(s, "10 extra subscription hours", "sub_hours", 10)
        o_ai = await offer(s, "500 AI credits", "ai_credits", 500)
        o_ref = await offer(s, "Referral bonus (referee)", "custom", 1)
        o_ref2 = await offer(s, "Referral bonus (referrer)", "custom", 2)

        c = await campaign(s, "Launch promo", "fixed", o_pct, start, end, max_redemptions=5, max_per_user=1)
        await s.execute(text("INSERT INTO coupon_codes(campaign_id,code,max_uses) VALUES (:c,'LAUNCH10',NULL)"), {"c": c})

        c = await campaign(s, "Partner batch", "unique", o_flat, start, end)
        unique = await svc.insert_codes(s, c, 1, prefix="SL", max_uses=1)      # one code: the demo has exactly 5 coupons

        c = await campaign(s, "VIP reward", "user_pin", o_hours, start, end, max_per_user=1)
        [vip] = await svc.insert_codes(s, c, 1, prefix="VIP", user_id=102, pin_hash=svc.ph.hash("4321"))

        c_sign = await campaign(s, "Welcome", "signup", o_ai, start, end, max_per_user=1, first_purchase_only=True)
        c_ref = await campaign(s, "Refer a friend", "referral", o_ref, start, end, referrer_offer_id=o_ref2)

        await s.commit()
    await ui_data()
    async with SessionLocal() as s:   # one issued coupon each for the signup and referral types -> exactly 5 coupons
        await s.execute(text("SELECT 1"))
        [signup_code] = await svc.insert_codes(s, c_sign, 1, prefix="WELCOME", user_id=1)
        [ref_code] = await svc.insert_codes(s, c_ref, 1, prefix="REF", user_id=2)
        await s.commit()
    print("Seeded (exactly 5 coupons).")
    print("  LAUNCH10 (fixed, 10% off, global cap 5)")
    print(f"  VIP code for user 102, PIN 4321: {vip}")
    print(f"  Unique code (500 off, once): {unique[0]}")
    print(f"  Signup coupon for user 1: {signup_code}   Referral coupon for user 2: {ref_code}")


if __name__ == "__main__":
    asyncio.run(main())
