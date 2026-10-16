"""Coupon rules and the redemption lifecycle: validate -> reserve -> confirm / release.

PostgreSQL alone decides whether a redemption is allowed. Redis only caches the code
lookup and blocks abuse before a request reaches the database."""
import json
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from . import cache
from .config import settings
from .db import SessionLocal

ph = PasswordHasher()

# ---------------------------------------------------------------- errors / messages
MESSAGES = {
    "INVALID_CODE": "This coupon code is not valid.",
    "EXPIRED": "This coupon has expired.",
    "NOT_STARTED": "This coupon is not active yet.",
    "ALREADY_USED": "You have already used this coupon.",
    "EXHAUSTED": "This coupon is no longer available (usage limit reached).",
    "NOT_ELIGIBLE": "You are not eligible for this coupon.",
    "NOT_COMBINABLE": "Coupons cannot be combined with other promotions.",
    "ONE_PER_ORDER": "Only one coupon can be applied to an order.",
    "MIN_CART_NOT_MET": "Your cart does not meet the minimum amount for this coupon.",
    "PIN_REQUIRED": "A PIN is required for this coupon.",
    "PIN_INVALID": "The PIN is incorrect.",
    "PIN_LOCKED": "This coupon is locked after too many wrong PIN attempts.",
    "RATE_LIMITED": "Too many attempts. Please try again later.",
    "RESERVATION_EXPIRED": "The reservation has expired; apply the coupon again.",
    "NOT_FOUND": "Reservation not found.",
}


class Reject(Exception):
    def __init__(self, reason: str, message: str | None = None, status: int = 400, **extra):
        self.reason, self.message, self.status, self.extra = reason, message or MESSAGES[reason], status, extra


def now() -> datetime:
    return datetime.now(timezone.utc)


def norm(code: str) -> str:
    return code.strip().upper()


# Crockford-style alphabet without 0 O 1 I L U: nothing that can be misread
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"


WORDS = ("MANGO TIGER PANDA MAPLE RIVER CLOUD ROBIN COCOA LEMON OLIVE PEARL SUNNY FROST EMBER CORAL "
         "BASIL FALCON OTTER ZEBRA KOALA BISON COBRA EAGLE HAWK LION WOLF FOX BEAR DEER SWAN CRANE "
         "APPLE PEACH BERRY GRAPE MELON PLUM CHERRY HONEY SUGAR MINT SAGE PEPPER GINGER LOTUS ORCHID "
         "ROCKET COMET ORBIT LASER PIXEL CHIP BYTE CIRCUIT SIGNAL BEACON ANCHOR HARBOR MEADOW FOREST "
         "CANYON DESERT GLACIER ISLAND LAGOON SUMMIT VALLEY BREEZE STORM THUNDER SPARK BLAZE").split()


def gen_code(prefix: str = "SL", length: int | None = None) -> str:
    """Demo-friendly, easy to say and type:  SL-MANGO-TIGER-42  (two words + two digits).
    CODE_STYLE=random gives PREFIX-K7M2-PQ4X instead (8 chars from a 30-symbol alphabet, no look-alikes)."""
    if settings.code_style == "words":
        w1, w2 = secrets.choice(WORDS), secrets.choice(WORDS)
        return f"{prefix}-{w1}-{w2}-{secrets.randbelow(90) + 10}"
    n = length or settings.code_length
    body = "".join(secrets.choice(ALPHABET) for _ in range(n))
    return f"{prefix}-" + "-".join(body[i:i + 4] for i in range(0, n, 4))


# ---------------------------------------------------------------- strict / flexible offer mapping
STRICT_MAPPING = {
    "fixed": {"percent"},
    "unique": {"flat"},
    "user_pin": {"sub_hours"},
    "signup": {"ai_credits"},
    "referral": {"custom"},
}


def check_offer_allowed(kind: str, benefit_type: str) -> None:
    if settings.offer_mode == "flexible":
        return
    if benefit_type not in STRICT_MAPPING[kind]:
        raise ValueError(
            f"In strict mode, {kind} coupons only accept {sorted(STRICT_MAPPING[kind])} offers "
            f"(got '{benefit_type}'). Set OFFER_MODE=flexible to allow any combination."
        )


# ---------------------------------------------------------------- audit log
async def log_event(event_type, *, campaign_id=None, code_id=None, user_id=None, reason=None, payload=None, session=None):
    sql = text(
        "INSERT INTO coupon_events(event_type,campaign_id,coupon_code_id,user_id,reason,payload) "
        "VALUES (:t,:c,:k,:u,:r,CAST(:p AS jsonb))"
    )
    args = dict(t=event_type, c=campaign_id, k=code_id, u=user_id, r=reason,
                p=json.dumps(payload, default=str) if payload is not None else None)
    if session is not None:
        await session.execute(sql, args)
    else:
        async with SessionLocal() as s:
            await s.execute(sql, args)
            await s.commit()


# ---------------------------------------------------------------- code lookup (Redis -> Postgres)
_DEF_SQL = text("""
SELECT c.id AS code_id, c.code, c.status AS code_status, c.assigned_user_id, c.max_uses, c.used_count, c.expires_at,
       k.meta AS campaign_meta, o.is_active AS offer_active,
       k.id AS campaign_id, k.kind, k.starts_at, k.ends_at, k.max_redemptions, k.redeemed_count,
       k.max_per_user, k.first_purchase_only, k.status AS campaign_status,
       o.id AS offer_id, o.name AS offer_name, o.benefit_type, o.value, o.max_discount, o.min_cart, o.meta
FROM coupon_codes c
JOIN campaigns k ON k.id = c.campaign_id
JOIN offers o ON o.id = COALESCE(c.offer_id, k.offer_id)
WHERE c.code = :code
""")


def def_key(code: str) -> str:
    return f"coupon:def:{code}"


async def get_definition(code: str) -> dict | None:
    d = await cache.get_json(def_key(code))
    if d:
        return d
    async with SessionLocal() as s:
        row = (await s.execute(_DEF_SQL, {"code": code})).mappings().first()
    if not row:
        return None
    d = json.loads(json.dumps(dict(row), default=str))
    await cache.set_json(def_key(code), d, settings.cache_ttl_s)
    return d


def _dt(v: str) -> datetime:
    return datetime.fromisoformat(v)


# ---------------------------------------------------------------- rules
def check_static(d: dict, user_id: int, subtotal: Decimal, has_promotion: bool) -> None:
    """Checks that need no database: they run against the (cached) definition."""
    if d["code_status"] == "revoked":
        raise Reject("INVALID_CODE")
    if d["code_status"] == "locked":
        raise Reject("PIN_LOCKED", status=423)
    if d["campaign_status"] != "active":
        raise Reject("INVALID_CODE")
    if not d.get("offer_active", True):
        raise Reject("NOT_ELIGIBLE", "This offer is no longer active.")
    t = now()
    if d.get("expires_at") and t > _dt(d["expires_at"]):
        raise Reject("EXPIRED")
    if t < _dt(d["starts_at"]):
        raise Reject("NOT_STARTED")
    if t > _dt(d["ends_at"]):
        raise Reject("EXPIRED")
    if d["assigned_user_id"] is not None and int(d["assigned_user_id"]) != user_id:
        raise Reject("NOT_ELIGIBLE")
    if d["max_uses"] is not None and d["used_count"] >= d["max_uses"]:
        raise Reject("ALREADY_USED")
    if d["max_redemptions"] is not None and d["redeemed_count"] >= d["max_redemptions"]:
        raise Reject("EXHAUSTED")
    if has_promotion:
        raise Reject("NOT_COMBINABLE")
    if d["min_cart"] is not None and subtotal < Decimal(str(d["min_cart"])):
        raise Reject("MIN_CART_NOT_MET", f"Minimum cart value for this coupon is {d['min_cart']}.")


async def check_user_rules(s, d: dict, user_id: int) -> None:
    """Per-user limit and first-purchase rule: need the database (one round trip)."""
    row = (await s.execute(text(
        "SELECT (SELECT count(*) FROM redemptions WHERE campaign_id=:c AND user_id=:u AND status<>'released') AS used, "
        "EXISTS(SELECT 1 FROM orders WHERE user_id=:u AND status='paid') AS has_paid, "
        "(SELECT account_type FROM users WHERE id=:u) AS account_type"),
        {"c": d["campaign_id"], "u": user_id})).mappings().one()
    if d["max_per_user"] and row["used"] >= d["max_per_user"]:
        raise Reject("ALREADY_USED")
    want = (d.get("campaign_meta") or {}).get("account_type")
    if want and row["account_type"] and row["account_type"] != want:
        raise Reject("NOT_ELIGIBLE", f"This coupon is only for {want.lower()} accounts.")
    if d["first_purchase_only"] and row["has_paid"]:
        raise Reject("NOT_ELIGIBLE", "This coupon is only valid on your first purchase.")


def compute_benefit(d: dict, subtotal: Decimal):
    bt, value = d["benefit_type"], Decimal(str(d["value"]))
    discount, grant = Decimal(0), None
    if bt == "percent":
        discount = subtotal * value / 100
        if d["max_discount"] is not None:
            discount = min(discount, Decimal(str(d["max_discount"])))
    elif bt == "flat":
        discount = min(value, subtotal)
    else:  # sub_hours | ai_credits | custom: a grant, not a price change
        grant = {"type": bt, "value": float(value), "meta": d.get("meta")}
    return discount.quantize(Decimal("0.01")), grant


def _summary(d: dict, subtotal: Decimal) -> dict:
    discount, grant = compute_benefit(d, subtotal)
    return {
        "code": d["code"], "kind": d["kind"], "offer": d["offer_name"],
        "discount": float(discount), "final_price": float(subtotal - discount),
        "grant": grant, "pin_required": d["kind"] == "user_pin",
    }


# ---------------------------------------------------------------- rate limiting
async def rate_limit(user_id: int | None, ip: str | None) -> None:
    m = settings.rate_limit_max
    checks = []
    if user_id is not None:
        checks.append((f"rl:apply:user:{user_id}", m))
    if ip:
        checks.append((f"rl:apply:ip:{ip}", m * 3))
    ok_user = ok_ip = await cache.allow_many(checks, settings.rate_limit_window_s)
    if not (ok_user and ok_ip):
        await log_event("rate_limited", user_id=user_id, reason="RATE_LIMITED", payload={"ip": ip})
        raise Reject("RATE_LIMITED", status=429)


# ---------------------------------------------------------------- validate (read-only preview)
async def validate(code: str, user_id: int, subtotal: Decimal, has_promotion: bool, ip: str | None) -> dict:
    code = norm(code)
    await rate_limit(user_id, ip)
    d = None
    try:
        d = await get_definition(code)
        if not d:
            raise Reject("INVALID_CODE")
        check_static(d, user_id, subtotal, has_promotion)
        async with SessionLocal() as s:
            await check_user_rules(s, d, user_id)
        return {"ok": True, **_summary(d, subtotal)}
    except Reject as e:
        await log_event("rejected", campaign_id=d and d["campaign_id"], code_id=d and d["code_id"],
                        user_id=user_id, reason=e.reason, payload={"code": code, "stage": "validate", "ip": ip})
        raise


# ---------------------------------------------------------------- PIN (own transaction: failures must persist)
async def verify_pin(d: dict, user_id: int, pin: str | None) -> None:
    if not pin:
        raise Reject("PIN_REQUIRED")
    async with SessionLocal() as s:
        row = (await s.execute(
            text("SELECT pin_hash, pin_attempts, status FROM coupon_codes WHERE id=:i FOR UPDATE"),
            {"i": d["code_id"]})).mappings().one()
        if row["status"] == "locked":
            raise Reject("PIN_LOCKED", status=423)
        try:
            ph.verify(row["pin_hash"], pin)
        except (VerifyMismatchError, Exception):
            attempts = row["pin_attempts"] + 1
            locked = attempts >= settings.pin_max_attempts
            await s.execute(
                text("UPDATE coupon_codes SET pin_attempts=:a, status=CASE WHEN :l THEN 'locked' ELSE status END WHERE id=:i"),
                {"a": attempts, "l": locked, "i": d["code_id"]})
            await log_event("pin_failed", campaign_id=d["campaign_id"], code_id=d["code_id"], user_id=user_id,
                            reason="locked" if locked else f"attempt {attempts}", session=s)
            await s.commit()
            await cache.bump(f"pin:fail:{d['code_id']}", 3600)
            await cache.delete(def_key(d["code"]))
            if locked:
                raise Reject("PIN_LOCKED", status=423)
            left = settings.pin_max_attempts - attempts
            raise Reject("PIN_INVALID", f"The PIN is incorrect. {left} attempt(s) left.", attempts_left=left)
        await s.execute(text("UPDATE coupon_codes SET pin_attempts=0 WHERE id=:i"), {"i": d["code_id"]})
        await s.commit()


# ---------------------------------------------------------------- reserve (at "Pay")
async def reserve(code: str, user_id: int, order_id: str, subtotal: Decimal, has_promotion: bool,
                  pin: str | None, ip: str | None) -> dict:
    code = norm(code)
    cached = await cache.get_json(f"idem:{order_id}")      # retry of the same request -> same answer
    if cached and cached.get("code") == code and cached.get("user_id") == user_id:
        return cached["result"]
    await rate_limit(user_id, ip)
    d = None
    try:
        d = await get_definition(code)
        if not d:
            raise Reject("INVALID_CODE")
        check_static(d, user_id, subtotal, has_promotion)
        if d["kind"] == "user_pin":
            await verify_pin(d, user_id, pin)
        result = await _reserve_tx(d, user_id, order_id, subtotal)
        await cache.set_json(f"idem:{order_id}", {"code": code, "user_id": user_id, "result": result}, 1800)
        await cache.delete(def_key(code))                  # counters changed -> drop stale cache
        return result
    except Reject as e:
        await log_event("rejected", campaign_id=d and d["campaign_id"], code_id=d and d["code_id"],
                        user_id=user_id, reason=e.reason,
                        payload={"code": code, "stage": "reserve", "order_id": order_id, "ip": ip})
        raise


async def _reserve_tx(d: dict, user_id: int, order_id: str, subtotal: Decimal) -> dict:
    discount, grant = compute_benefit(d, subtotal)
    until = now() + timedelta(minutes=settings.reservation_ttl_min)
    async with SessionLocal() as s:
        try:
            # 1. serialise this user's attempts on this campaign (per-user limit is race-free)
            await s.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                            {"k": f"{d['campaign_id']}:{user_id}"})
            # 2. same order already holds a coupon?
            ex = (await s.execute(
                text("SELECT id, coupon_code_id, user_id, status, discount_applied, reserved_until FROM redemptions "
                     "WHERE order_id=:o AND status<>'released'"), {"o": order_id})).mappings().first()
            if ex:
                if ex["coupon_code_id"] == d["code_id"] and ex["user_id"] == user_id:
                    return {"ok": True, "status": ex["status"], "order_id": order_id, "code": d["code"],
                            "discount": float(ex["discount_applied"]),
                            "final_price": float(subtotal - ex["discount_applied"]), "grant": grant,
                            "reserved_until": str(ex["reserved_until"]), "redemption_id": ex["id"]}
                raise Reject("ONE_PER_ORDER", status=409)
            # 3. per-user limit + first purchase
            await check_user_rules(s, d, user_id)
            # 4. record the reservation first (no hot locks taken yet)
            await s.execute(text(
                "INSERT INTO orders(id,user_id,status) VALUES (:o,:u,'pending') ON CONFLICT (id) DO NOTHING"),
                {"o": order_id, "u": user_id})
            rid = (await s.execute(text(
                "INSERT INTO redemptions(coupon_code_id,campaign_id,user_id,order_id,status,cart_subtotal,"
                "discount_applied,reserved_until) VALUES (:k,:c,:u,:o,'reserved',:sub,:disc,:until) RETURNING id"),
                {"k": d["code_id"], "c": d["campaign_id"], "u": user_id, "o": order_id,
                 "sub": subtotal, "disc": discount, "until": until})).scalar_one()
            await log_event("reserved", campaign_id=d["campaign_id"], code_id=d["code_id"], user_id=user_id,
                            payload={"order_id": order_id, "discount": float(discount), "code": d["code"]}, session=s)
            # 5. the caps, LAST and in one statement, so the hot campaign row is locked for as short as possible.
            #    Conditional UPDATEs are atomic: 100 parallel requests on a cap of 10 give exactly 10.
            ok = (await s.execute(text(
                "WITH c AS (UPDATE campaigns SET redeemed_count = redeemed_count + 1 "
                "  WHERE id=:c AND status='active' AND (max_redemptions IS NULL OR redeemed_count < max_redemptions) RETURNING 1), "
                "k AS (UPDATE coupon_codes SET used_count = used_count + 1 "
                "  WHERE id=:k AND status='active' AND (max_uses IS NULL OR used_count < max_uses) RETURNING 1) "
                "SELECT (SELECT count(*) FROM c) AS campaign_ok, (SELECT count(*) FROM k) AS code_ok"),
                {"c": d["campaign_id"], "k": d["code_id"]})).mappings().one()
            if not ok["campaign_ok"]:
                raise Reject("EXHAUSTED")
            if not ok["code_ok"]:
                raise Reject("ALREADY_USED")
            await s.commit()
        except IntegrityError:                 # unique index one_coupon_per_order won a race
            await s.rollback()
            raise Reject("ONE_PER_ORDER", status=409)
        except Reject:
            await s.rollback()
            raise
    return {"ok": True, "status": "reserved", "order_id": order_id, "code": d["code"],
            "discount": float(discount), "final_price": float(subtotal - discount), "grant": grant,
            "reserved_until": until.isoformat(), "redemption_id": rid}


# ---------------------------------------------------------------- confirm / release
async def confirm(order_id: str) -> dict:
    async with SessionLocal() as s:
        row = (await s.execute(text(
            "UPDATE redemptions SET status='confirmed', confirmed_at=now() "
            "WHERE order_id=:o AND status='reserved' AND reserved_until > now() "
            "RETURNING id, campaign_id, coupon_code_id, user_id"), {"o": order_id})).mappings().first()
        if not row:
            cur = (await s.execute(text(
                "SELECT status FROM redemptions WHERE order_id=:o ORDER BY id DESC LIMIT 1"),
                {"o": order_id})).scalar()
            if cur == "confirmed":
                return {"ok": True, "status": "confirmed", "order_id": order_id}
            if cur is None:
                raise Reject("NOT_FOUND", status=404)
            raise Reject("RESERVATION_EXPIRED", status=409)
        await s.execute(text("UPDATE orders SET status='paid' WHERE id=:o"), {"o": order_id})
        await log_event("confirmed", campaign_id=row["campaign_id"], code_id=row["coupon_code_id"],
                        user_id=row["user_id"], payload={"order_id": order_id}, session=s)
        await s.commit()
    return {"ok": True, "status": "confirmed", "order_id": order_id}


async def release(order_id: str, refund: bool = False, event: str = "released", reason: str | None = None) -> dict:
    allowed = "('reserved','confirmed')" if refund else "('reserved')"
    async with SessionLocal() as s:
        row = (await s.execute(text(
            f"UPDATE redemptions SET status='released' WHERE order_id=:o AND status IN {allowed} "
            "RETURNING id, campaign_id, coupon_code_id, user_id"), {"o": order_id})).mappings().first()
        if not row:
            return {"ok": True, "status": "noop", "order_id": order_id}   # idempotent
        await _give_back(s, row, order_id, event, reason or ("refund" if refund else "payment_failed"))
        await s.execute(text("UPDATE orders SET status=:st WHERE id=:o"),
                        {"st": "refunded" if refund else "failed", "o": order_id})
        await s.commit()
        code = (await s.execute(text("SELECT code FROM coupon_codes WHERE id=:i"),
                                {"i": row["coupon_code_id"]})).scalar()
    await cache.delete(f"idem:{order_id}", def_key(code))
    return {"ok": True, "status": "released", "order_id": order_id}


async def _give_back(s, row, order_id: str, event: str, reason: str) -> None:
    await s.execute(text("UPDATE campaigns SET redeemed_count=GREATEST(redeemed_count-1,0) WHERE id=:c"),
                    {"c": row["campaign_id"]})
    await s.execute(text("UPDATE coupon_codes SET used_count=GREATEST(used_count-1,0) WHERE id=:k"),
                    {"k": row["coupon_code_id"]})
    await log_event(event, campaign_id=row["campaign_id"], code_id=row["coupon_code_id"], user_id=row["user_id"],
                    reason=reason, payload={"order_id": order_id}, session=s)


async def release_expired() -> int:
    """Background worker: reservations past their 15-minute TTL go back to the pool."""
    async with SessionLocal() as s:
        rows = (await s.execute(text(
            "UPDATE redemptions SET status='released' WHERE id IN ("
            "  SELECT id FROM redemptions WHERE status='reserved' AND reserved_until < now() "
            "  FOR UPDATE SKIP LOCKED LIMIT 200) "
            "RETURNING id, campaign_id, coupon_code_id, user_id, order_id"))).mappings().all()
        for r in rows:
            await _give_back(s, r, r["order_id"], "expired", "reservation_ttl")
            await s.execute(text("UPDATE orders SET status='failed' WHERE id=:o AND status='pending'"),
                            {"o": r["order_id"]})
        await s.commit()
    return len(rows)


# ---------------------------------------------------------------- issuing codes
async def insert_codes(session, campaign_id: int, n: int, prefix="SL", max_uses=1, user_id=None,
                       offer_id=None, pin_hash=None, expires_at=None) -> list[str]:
    made: list[str] = []
    while len(made) < n:
        batch = {gen_code(prefix) for _ in range(min(500, n - len(made)))}
        rows = (await session.execute(text(
            "INSERT INTO coupon_codes(campaign_id,offer_id,code,assigned_user_id,pin_hash,max_uses,expires_at) "
            "SELECT :c,:o,x,:u,:p,:m,:x FROM unnest(CAST(:codes AS text[])) AS x "
            "ON CONFLICT (code) DO NOTHING RETURNING code"),
            {"c": campaign_id, "o": offer_id, "u": user_id, "p": pin_hash, "m": max_uses,
             "x": expires_at, "codes": list(batch)})).scalars().all()
        made.extend(rows)
    return made


async def _active_campaign(s, kind: str):
    row = (await s.execute(text(
        "SELECT * FROM campaigns WHERE kind=:k AND status='active' AND starts_at<=now() AND ends_at>now() "
        "ORDER BY id DESC LIMIT 1"), {"k": kind})).mappings().first()
    if not row:
        raise Reject("NOT_FOUND", f"No active {kind} campaign.", status=404)
    return row


async def issue_signup(user_id: int) -> dict:
    async with SessionLocal() as s:
        c = await _active_campaign(s, "signup")
        await s.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"signup:{user_id}"})
        ex = (await s.execute(text(
            "SELECT code FROM coupon_codes WHERE campaign_id=:c AND assigned_user_id=:u"),
            {"c": c["id"], "u": user_id})).scalar()
        if ex:
            return {"ok": True, "code": ex, "issued": False}
        [code] = await insert_codes(s, c["id"], 1, prefix="WEL", max_uses=1, user_id=user_id)
        await log_event("created", campaign_id=c["id"], user_id=user_id, reason="signup", payload={"code": code}, session=s)
        await s.commit()
    return {"ok": True, "code": code, "issued": True}


async def issue_referral(referrer_id: int, referee_id: int) -> dict:
    if referrer_id == referee_id:
        raise Reject("NOT_ELIGIBLE", "A user cannot refer themselves.")
    async with SessionLocal() as s:
        c = await _active_campaign(s, "referral")
        ref = (await s.execute(text(
            "INSERT INTO referrals(referrer_id,referee_id,status) VALUES (:a,:b,'qualified') "
            "ON CONFLICT (referee_id) DO NOTHING RETURNING id"), {"a": referrer_id, "b": referee_id})).scalar()
        if not ref:
            raise Reject("ALREADY_USED", "This referee has already been rewarded.", status=409)
        [referee_code] = await insert_codes(s, c["id"], 1, prefix="REF", user_id=referee_id)
        [referrer_code] = await insert_codes(s, c["id"], 1, prefix="REF", user_id=referrer_id,
                                             offer_id=c["referrer_offer_id"])
        await s.execute(text(
            "UPDATE referrals SET status='rewarded', referee_code_id=(SELECT id FROM coupon_codes WHERE code=:b), "
            "referrer_code_id=(SELECT id FROM coupon_codes WHERE code=:a) WHERE id=:i"),
            {"a": referrer_code, "b": referee_code, "i": ref})
        await log_event("created", campaign_id=c["id"], user_id=referee_id, reason="referral",
                        payload={"referrer": referrer_id, "referee": referee_id}, session=s)
        await s.commit()
    return {"ok": True, "referrer_code": referrer_code, "referee_code": referee_code}
