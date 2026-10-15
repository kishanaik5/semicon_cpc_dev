"""Storefront / PF Admin adapter: serves the `/api/*` routes the existing React UI calls,
on top of the same coupon engine (service.py). No coupon rules live here, only
mapping between the UI's vocabulary and the engine's."""
import csv
import hashlib
import io
import json
import random
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import text

from . import cache
from . import service as svc
from . import ai
from .analytics import gather_metrics, summarize
from .api import client_ip
from .config import settings
from .db import SessionLocal

router = APIRouter(prefix="/api", tags=["storefront + PF Admin (UI adapter)"])

FAR_FUTURE = datetime(2099, 12, 31, tzinfo=timezone.utc)
UI_BT = {"percent": "PERCENT_DISCOUNT", "flat": "FIXED_DISCOUNT", "sub_hours": "EXTRA_HOURS",
         "ai_credits": "AI_CREDITS", "custom": "CUSTOM"}
DB_BT = {v: k for k, v in UI_BT.items()}

# coupon status as the UI shows it, derived from code + campaign + offer rows (aliases c, k)
STATUS_SQL = """CASE
  WHEN c.status = 'revoked' OR k.status <> 'active' THEN 'DISABLED'
  WHEN COALESCE(c.expires_at, k.ends_at) < now() THEN 'EXPIRED'
  WHEN (c.max_uses IS NOT NULL AND c.used_count >= c.max_uses)
    OR (k.max_redemptions IS NOT NULL AND k.redeemed_count >= k.max_redemptions) THEN 'EXHAUSTED'
  ELSE 'ACTIVE' END"""


COOKIE = "admin_session"


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def admin_auth(request: Request) -> dict:
    """Session check for every PF Admin call: valid token, not idle too long, not too old.
    Each call slides the idle window forward."""
    token = request.cookies.get(COOKIE)
    if not token:
        raise svc.Reject("UNAUTHORIZED", "Please sign in.", status=401)
    async with SessionLocal() as s:
        row = (await s.execute(text(
            "UPDATE admin_sessions SET last_seen_at=now() "
            "WHERE token_hash=:h AND last_seen_at > now() - CAST(:idle AS interval) "
            "  AND created_at > now() - CAST(:ttl AS interval) RETURNING admin_id"),
            {"h": _hash_token(token), "idle": timedelta(minutes=settings.admin_idle_minutes),
             "ttl": timedelta(hours=settings.admin_session_hours)})).first()
        if not row:
            await s.execute(text("DELETE FROM admin_sessions WHERE token_hash=:h"), {"h": _hash_token(token)})
            await s.commit()
            raise svc.Reject("SESSION_EXPIRED", "Your session has expired. Please sign in again.", status=401)
        user = (await s.execute(text("SELECT id, username FROM admin_users WHERE id=:i"), {"i": row[0]})).mappings().one()
        await s.commit()
    return dict(user)


admin = APIRouter(prefix="/admin", dependencies=[Depends(admin_auth)])

_DUMMY_HASH = svc.ph.hash("not-a-real-password")      # same timing for unknown usernames


@router.post("/admin/login")
async def admin_login(body: dict, request: Request):
    username = str(body.get("username") or "").strip().lower()
    password = str(body.get("password") or "")
    ip = client_ip(request)
    allowed = await cache.allow_many([(f"rl:login:ip:{ip}", 10), (f"rl:login:user:{username}", 5)], 900)
    if not allowed:
        await svc.log_event("rate_limited", reason="ADMIN_LOGIN", payload={"ip": ip, "username": username})
        raise svc.Reject("RATE_LIMITED", "Too many sign-in attempts. Try again in 15 minutes.", status=429)
    async with SessionLocal() as s:
        u = (await s.execute(text("SELECT id, username, password_hash FROM admin_users WHERE username=:u"),
                             {"u": username})).mappings().first()
        try:
            svc.ph.verify(u["password_hash"] if u else _DUMMY_HASH, password)
            valid = u is not None
        except Exception:  # noqa: BLE001
            valid = False
        if not valid:
            await svc.log_event("login_failed", reason="admin_login", payload={"ip": ip, "username": username}, session=s)
            await s.commit()
            raise svc.Reject("INVALID_CREDENTIALS", "Incorrect username or password.", status=401)
        token = secrets.token_urlsafe(32)
        await s.execute(text("INSERT INTO admin_sessions(token_hash,admin_id,ip) VALUES (:h,:a,:ip)"),
                        {"h": _hash_token(token), "a": u["id"], "ip": ip})
        await s.execute(text("UPDATE admin_users SET last_login_at=now() WHERE id=:i"), {"i": u["id"]})
        await s.execute(text("DELETE FROM admin_sessions WHERE last_seen_at < now() - interval '1 day'"))
        await svc.log_event("login", reason="admin_login", payload={"ip": ip, "username": username}, session=s)
        await s.commit()
    resp = JSONResponse({"ok": True, "username": u["username"], "idle_minutes": settings.admin_idle_minutes})
    resp.set_cookie(COOKIE, token, httponly=True, samesite="strict", path="/api",
                    secure=request.headers.get("x-forwarded-proto") == "https",
                    max_age=settings.admin_session_hours * 3600)
    return resp


@router.post("/admin/logout")
async def admin_logout(request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        async with SessionLocal() as s:
            await s.execute(text("DELETE FROM admin_sessions WHERE token_hash=:h"), {"h": _hash_token(token)})
            await s.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/api")
    return resp


# ------------------------------------------------------------------ helpers
def summary_of(bt: str, value, max_discount=None, meta=None) -> str:
    v = float(value or 0)
    if bt == "percent":
        s = f"{v:g}% off"
        return s + (f" (up to ₹{float(max_discount):g})" if max_discount else "")
    if bt == "flat":
        return f"₹{v:g} off"
    if bt == "sub_hours":
        return f"+{v:g} lab hours"
    if bt == "ai_credits":
        return f"+{v:g} AI credits"
    return (meta or {}).get("label", "Custom benefit") if isinstance(meta, dict) else "Custom benefit"


def _obj(v):
    return json.loads(v) if isinstance(v, str) else (v or {})


def _num(v):
    return None if v in (None, "") else int(v)


def _dt(v, default=None):
    if not v:
        return default
    d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _real_end(d):
    return None if d is None or d.year >= 2099 else d


def _strict(kind: str, bt_db: str):
    try:
        svc.check_offer_allowed(kind, bt_db)
    except ValueError as e:
        raise svc.Reject("OFFER_MODE", str(e), status=422)


async def _offer(s, offer_id):
    row = (await s.execute(text("SELECT * FROM offers WHERE id=:i"), {"i": int(offer_id)})).mappings().first()
    if not row:
        raise svc.Reject("NOT_FOUND", "Offer not found.", status=404)
    return row


def _ref_code(name: str) -> str:
    base = re.sub(r"[^A-Z]", "", name.upper())[:4] or "USER"
    return base + "".join(random.choice(svc.ALPHABET) for _ in range(5))


# ------------------------------------------------------------------ misc
@router.get("/health")
async def health():
    return {"ok": True, "db": "up", "service": "coupon-service"}


@admin.get("/ping")
async def ping(user: dict = Depends(admin_auth)):
    return {"ok": True, "username": user["username"], "idle_minutes": settings.admin_idle_minutes}


# ------------------------------------------------------------------ users
USER_SQL = f"""
SELECT u.id, u.name, u.email, u.account_type, u.referral_code, u.created_at,
  (SELECT count(*) FROM orders o WHERE o.user_id=u.id AND o.status='paid')::int AS purchases_count,
  (SELECT count(*) FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id
    WHERE c.assigned_user_id=u.id AND {STATUS_SQL}='ACTIVE')::int AS active_coupons,
  r.email AS referred_by_email
FROM users u LEFT JOIN users r ON r.id=u.referred_by"""


@router.get("/users")
async def list_users():
    async with SessionLocal() as s:
        return [dict(r) for r in (await s.execute(text(USER_SQL + " ORDER BY u.id"))).mappings().all()]


@router.get("/users/{user_id}/coupons")
async def wallet(user_id: int, available: int = 0):
    """The user's personal coupons. With ?available=1 (checkout) the public fixed codes
    that are currently usable are listed too, so the customer can see what to apply."""
    async with SessionLocal() as s:
        rows = (await s.execute(text(f"""
            SELECT c.id, c.code, {STATUS_SQL} AS status, k.kind, (c.pin_hash IS NOT NULL) AS requires_pin,
                   k.first_purchase_only, o.benefit_type, o.value, o.max_discount, o.meta,
                   COALESCE(c.expires_at, k.ends_at) AS valid_until,
                   (c.assigned_user_id IS NULL) AS is_public,
                   CASE WHEN k.max_per_user IS NOT NULL AND (SELECT count(*) FROM redemptions r
                        WHERE r.campaign_id=k.id AND r.user_id=:u AND r.status<>'released') >= k.max_per_user
                        THEN true ELSE false END AS used_by_user
            FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id
            JOIN offers o ON o.id=COALESCE(c.offer_id,k.offer_id)
            WHERE c.assigned_user_id=:u
               OR (:avail = 1 AND k.kind='fixed' AND c.assigned_user_id IS NULL AND o.is_active
                   AND (k.meta->>'account_type' IS NULL OR k.meta->>'account_type' =
                        (SELECT account_type FROM users WHERE id=:u)))
            ORDER BY (c.assigned_user_id IS NULL), c.id DESC"""), {"u": user_id, "avail": available})).mappings().all()
    out = []
    for r in rows:
        status = "USED" if r["used_by_user"] and r["status"] == "ACTIVE" else r["status"]
        if r["is_public"] and status in ("EXPIRED", "DISABLED"):
            continue                      # don't advertise dead public codes
        out.append({"id": r["id"], "code": r["code"], "status": status, "coupon_type": r["kind"].upper(),
                    "requires_pin": r["requires_pin"], "first_purchase_only": r["first_purchase_only"],
                    "benefit_type": UI_BT[r["benefit_type"]], "valid_until": _real_end(r["valid_until"]),
                    "is_public": r["is_public"],
                    "offer_summary": summary_of(r["benefit_type"], r["value"], r["max_discount"], _obj(r["meta"]))})
    return out


@router.get("/users/{user_id}/orders")
async def user_orders(user_id: int):
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT id, id AS order_ref, created_at, coupon_code,
                   COALESCE(subtotal,0) - COALESCE(discount,0) AS total, COALESCE(discount,0) AS discount_amount
            FROM orders WHERE user_id=:u AND status='paid' ORDER BY created_at DESC"""), {"u": user_id})).mappings().all()
    return [dict(r) for r in rows]


@router.post("/users/register", status_code=201)
async def register(body: dict):
    name, email = (body.get("name") or "").strip(), (body.get("email") or "").strip().lower()
    acct = body.get("account_type") or "INDIVIDUAL"
    if not name or "@" not in email:
        raise svc.Reject("INVALID_INPUT", "Name and a valid email are required.", status=422)
    out: dict = {}
    async with SessionLocal() as s:
        if (await s.execute(text("SELECT 1 FROM users WHERE email=:e"), {"e": email})).first():
            raise svc.Reject("EMAIL_EXISTS", "An account with this email already exists.", status=409)
        referrer = None
        if body.get("referral_code"):
            referrer = (await s.execute(text("SELECT id FROM users WHERE referral_code=:c"),
                                        {"c": str(body["referral_code"]).strip().upper()})).scalar()
            if referrer is None:
                raise svc.Reject("INVALID_CODE", "That referral code does not exist.", status=422)
        uid = (await s.execute(text(
            "INSERT INTO users(name,email,account_type,referral_code,referred_by) VALUES (:n,:e,:a,:c,:r) RETURNING id"),
            {"n": name, "e": email, "a": acct, "c": _ref_code(name), "r": referrer})).scalar_one()
        await svc.log_event("created", user_id=uid, reason="user_registered", payload={"email": email}, session=s)

        # first-time signup coupon: most specific active rule (account-type match beats "all accounts")
        rule = (await s.execute(text("""
            SELECT * FROM campaigns WHERE kind='signup' AND status='active' AND ends_at>now()
              AND (meta->>'account_type' IS NULL OR meta->>'account_type'=:a)
            ORDER BY (meta->>'account_type' IS NOT NULL) DESC, id DESC LIMIT 1"""), {"a": acct})).mappings().first()
        if rule:
            days = int(_obj(rule["meta"]).get("validity_days", 30))
            [code] = await svc.insert_codes(s, rule["id"], 1, prefix="WELCOME", user_id=uid,
                                            expires_at=svc.now() + timedelta(days=days))
            out["signupCoupon"] = {"code": code}

        # referral: referee reward now; referrer reward now or on the referee's first purchase
        if referrer:
            prog = (await s.execute(text(
                "SELECT * FROM campaigns WHERE kind='referral' AND status='active' ORDER BY id DESC LIMIT 1"))).mappings().first()
            ref_id = (await s.execute(text(
                "INSERT INTO referrals(referrer_id,referee_id,status) VALUES (:a,:b,'pending') RETURNING id"),
                {"a": referrer, "b": uid})).scalar_one()
            if prog:
                m = _obj(prog["meta"])
                cap = m.get("max_referrals_per_user")
                used = (await s.execute(text("SELECT count(*) FROM referrals WHERE referrer_id=:r"),
                                        {"r": referrer})).scalar_one()
                if not cap or used <= int(cap):
                    exp = svc.now() + timedelta(days=int(m.get("validity_days", 30)))
                    ref_out: dict = {}
                    if not m.get("no_referee_reward"):
                        [rc] = await svc.insert_codes(s, prog["id"], 1, prefix="REF", user_id=uid, expires_at=exp)
                        await s.execute(text("UPDATE referrals SET referee_code_id=(SELECT id FROM coupon_codes WHERE code=:c) WHERE id=:i"),
                                        {"c": rc, "i": ref_id})
                        ref_out["refereeCoupon"] = rc
                    if m.get("trigger") == "SIGNUP" and prog["referrer_offer_id"]:
                        await _issue_referrer_code(s, prog, referrer, ref_id)
                    out["referral"] = ref_out
        await s.commit()
        user = (await s.execute(text(USER_SQL + " WHERE u.id=:i"), {"i": uid})).mappings().one()
    return {"user": dict(user), **out}


async def _issue_referrer_code(s, prog, referrer_id: int, referral_id: int):
    m = _obj(prog["meta"])
    exp = svc.now() + timedelta(days=int(m.get("validity_days", 30)))
    [code] = await svc.insert_codes(s, prog["id"], 1, prefix="REF", user_id=referrer_id,
                                    offer_id=prog["referrer_offer_id"], expires_at=exp)
    await s.execute(text("UPDATE referrals SET referrer_code_id=(SELECT id FROM coupon_codes WHERE code=:c), "
                         "status='rewarded' WHERE id=:i"), {"c": code, "i": referral_id})


async def _on_first_purchase(user_id: int):
    """Referee paid for the first time: mark the referral converted and pay the referrer if still owed."""
    async with SessionLocal() as s:
        ref = (await s.execute(text(
            "SELECT * FROM referrals WHERE referee_id=:u AND converted_at IS NULL"), {"u": user_id})).mappings().first()
        if not ref:
            return
        await s.execute(text("UPDATE referrals SET converted_at=now() WHERE id=:i"), {"i": ref["id"]})
        if ref["referrer_code_id"] is None:
            prog = (await s.execute(text(
                "SELECT * FROM campaigns WHERE kind='referral' AND status='active' ORDER BY id DESC LIMIT 1"))).mappings().first()
            if prog and prog["referrer_offer_id"]:
                await _issue_referrer_code(s, prog, ref["referrer_id"], ref["id"])
        await s.commit()


# ------------------------------------------------------------------ checkout
def _coupon_view(res: dict, d: dict) -> dict:
    g = res.get("grant") or {}
    return {"code": res["code"], "type": res["kind"].upper(), "validUntil": _real_end(_dt(d.get("expires_at") or d["ends_at"])),
            "offer": {"name": res["offer"], "summary": summary_of(d["benefit_type"], d["value"], d.get("max_discount"), _obj(d.get("meta")))},
            "discountAmount": res["discount"],
            "benefit": {"extraHours": g.get("value") if g.get("type") == "sub_hours" else None,
                        "aiCredits": g.get("value") if g.get("type") == "ai_credits" else None}}


@router.post("/checkout/validate")
async def checkout_validate(body: dict, request: Request):
    from decimal import Decimal
    code, user = svc.norm(body.get("coupon_code") or ""), int(body["user_id"])
    res = await svc.validate(code, user, Decimal(str(body["subtotal"])), bool(body.get("has_existing_promotion")),
                             client_ip(request))
    d = await svc.get_definition(code)
    if res["pin_required"]:
        await svc.verify_pin(d, user, body.get("pin"))
    return {"coupon": _coupon_view(res, d), "message": f"Coupon {code} applied."}


@router.post("/checkout")
async def checkout(body: dict, request: Request):
    from decimal import Decimal
    user, subtotal = int(body["user_id"]), Decimal(str(body["subtotal"]))
    order_ref = "ORD-" + "".join(random.choice(svc.ALPHABET) for _ in range(8))
    code = svc.norm(body["coupon_code"]) if body.get("coupon_code") else None
    discount, coupon, benefits = Decimal(0), None, {}
    if code:
        res = await svc.reserve(code, user, order_ref, subtotal, bool(body.get("has_existing_promotion")),
                                body.get("pin"), client_ip(request))
        await svc.confirm(order_ref)                    # payment is simulated: success
        d = await svc.get_definition(code)
        discount = Decimal(str(res["discount"]))
        coupon = _coupon_view({**res, "kind": d["kind"], "offer": d["offer_name"]}, d)
        g = res.get("grant") or {}
        benefits = {"extraHours": g.get("value") if g.get("type") == "sub_hours" else None,
                    "aiCredits": g.get("value") if g.get("type") == "ai_credits" else None}
    async with SessionLocal() as s:
        await s.execute(text(
            "INSERT INTO orders(id,user_id,status) VALUES (:o,:u,'paid') ON CONFLICT (id) DO NOTHING"),
            {"o": order_ref, "u": user})
        await s.execute(text(
            "UPDATE orders SET subtotal=:s, discount=:d, coupon_code=:c, description=:desc, status='paid' WHERE id=:o"),
            {"s": subtotal, "d": discount, "c": code, "desc": body.get("description"), "o": order_ref})
        await s.commit()
    await _on_first_purchase(user)
    return {"order": {"orderRef": order_ref, "subtotal": float(subtotal), "discountAmount": float(discount),
                      "total": float(subtotal - discount), "benefits": benefits}, "coupon": coupon}


# ------------------------------------------------------------------ offers
OFFER_SQL = """
SELECT o.*, (SELECT count(*) FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id
             WHERE COALESCE(c.offer_id,k.offer_id)=o.id)::int AS coupon_count
FROM offers o"""


def _offer_out(r) -> dict:
    return {"id": r["id"], "name": r["name"], "description": r["description"], "benefit_type": UI_BT[r["benefit_type"]],
            "value": r["value"], "max_discount": r["max_discount"], "min_order_amount": r["min_cart"] or 0,
            "is_active": r["is_active"], "coupon_count": r["coupon_count"], "config": _obj(r["meta"]),
            "summary": summary_of(r["benefit_type"], r["value"], r["max_discount"], _obj(r["meta"]))}


@admin.get("/offers")
async def offers():
    async with SessionLocal() as s:
        return [_offer_out(r) for r in (await s.execute(text(OFFER_SQL + " ORDER BY o.id"))).mappings().all()]


@admin.post("/offers", status_code=201)
async def create_offer(body: dict):
    bt = DB_BT.get(body.get("benefit_type"))
    if not bt or not body.get("name"):
        raise svc.Reject("INVALID_INPUT", "Name and benefit type are required.", status=422)
    async with SessionLocal() as s:
        oid = (await s.execute(text(
            "INSERT INTO offers(name,description,benefit_type,value,max_discount,min_cart,meta) "
            "VALUES (:n,:d,:b,:v,:m,:c,CAST(:meta AS jsonb)) RETURNING id"),
            {"n": body["name"], "d": body.get("description"), "b": bt, "v": float(body.get("value") or 0),
             "m": _num(body.get("max_discount")), "c": float(body.get("min_order_amount") or 0) or None,
             "meta": json.dumps(body.get("config") or {})})).scalar_one()
        await svc.log_event("created", reason="offer", payload={"offer_id": oid, "name": body["name"]}, session=s)
        await s.commit()
        row = (await s.execute(text(OFFER_SQL + " WHERE o.id=:i"), {"i": oid})).mappings().one()
    return _offer_out(row)


@admin.put("/offers/{offer_id}")
async def update_offer(offer_id: int, body: dict):
    async with SessionLocal() as s:
        await s.execute(text("UPDATE offers SET is_active=COALESCE(:a, is_active) WHERE id=:i"),
                        {"a": body.get("is_active"), "i": offer_id})
        await svc.log_event("updated", reason="offer", payload={"offer_id": offer_id, **body}, session=s)
        await s.commit()
        row = (await s.execute(text(OFFER_SQL + " WHERE o.id=:i"), {"i": offer_id})).mappings().one()
    return _offer_out(row)


# ------------------------------------------------------------------ coupons
COUPON_FROM = f"""
FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id
JOIN offers o ON o.id=COALESCE(c.offer_id,k.offer_id)
LEFT JOIN users u ON u.id=c.assigned_user_id"""
COUPON_COLS = f"""
c.id, c.code, k.kind, k.id AS campaign_id, o.name AS offer_name, o.benefit_type, o.value, o.max_discount, o.meta AS offer_meta,
u.email AS assigned_user_email, c.used_count AS usage_count,
CASE WHEN k.kind='fixed' THEN k.max_redemptions ELSE c.max_uses END AS global_usage_limit,
k.max_per_user AS per_user_limit, k.starts_at AS valid_from, COALESCE(c.expires_at, k.ends_at) AS valid_until,
{STATUS_SQL} AS status, (c.pin_hash IS NOT NULL) AS has_pin, c.status AS code_status,
k.first_purchase_only, k.meta->>'account_type' AS account_type, k.meta->>'description' AS description"""


@admin.get("/coupons")
async def coupons(type: str = "", status: str = "", q: str = "", batch_id: str = "", limit: int = 15, offset: int = 0):
    where, p = [], {"l": min(limit, 200), "o": offset}
    if type:
        where.append("k.kind=:t"); p["t"] = type.lower()
    if q:
        where.append("c.code ILIKE :q"); p["q"] = f"%{q}%"
    if batch_id:
        where.append("k.id=:b"); p["b"] = int(batch_id)
    w = ("WHERE " + " AND ".join(where)) if where else ""
    inner = f"SELECT {COUPON_COLS} {COUPON_FROM} {w}"
    outer = "WHERE status=:st" if status else ""
    if status:
        p["st"] = status
    async with SessionLocal() as s:
        total = (await s.execute(text(f"SELECT count(*) FROM ({inner}) x {outer}"), p)).scalar_one()
        rows = (await s.execute(text(f"SELECT * FROM ({inner}) x {outer} ORDER BY id DESC LIMIT :l OFFSET :o"), p)).mappings().all()
    items = []
    for r in rows:
        locked = r["code_status"] == "locked"
        items.append({**{k: r[k] for k in ("id", "code", "offer_name", "assigned_user_email", "usage_count",
                                           "global_usage_limit", "per_user_limit", "valid_from", "status", "has_pin",
                                           "first_purchase_only", "account_type", "description")},
                      "coupon_type": r["kind"].upper(), "valid_until": _real_end(r["valid_until"]),
                      "pin_locked_until": (svc.now() + timedelta(minutes=15)) if locked else None,
                      "offer_summary": summary_of(r["benefit_type"], r["value"], r["max_discount"], _obj(r["offer_meta"]))})
    return {"items": items, "total": total}


async def _new_campaign(s, name, kind, offer_id, starts, ends, **kw) -> int:
    offer = await _offer(s, offer_id)
    _strict(kind, offer["benefit_type"])
    return (await s.execute(text(
        "INSERT INTO campaigns(name,kind,offer_id,starts_at,ends_at,max_redemptions,max_per_user,"
        "first_purchase_only,meta) VALUES (:n,:k,:o,:s,:e,:m,:p,:f,CAST(:meta AS jsonb)) RETURNING id"),
        {"n": name, "k": kind, "o": int(offer_id), "s": starts, "e": ends, "m": kw.get("max_redemptions"),
         "p": kw.get("max_per_user"), "f": kw.get("first_purchase_only", False),
         "meta": json.dumps(kw.get("meta") or {})})).scalar_one()


@admin.post("/coupons/fixed", status_code=201)
async def create_fixed(body: dict):
    code = svc.norm(body.get("code") or "")
    if len(code) < 3:
        raise svc.Reject("INVALID_INPUT", "Code must be at least 3 characters.", status=422)
    starts = _dt(body.get("valid_from"), svc.now() - timedelta(minutes=1))
    ends = _dt(body.get("valid_until"), FAR_FUTURE)
    if ends <= starts:
        raise svc.Reject("INVALID_INPUT", "Valid until must be after valid from.", status=422)
    async with SessionLocal() as s:
        if (await s.execute(text("SELECT 1 FROM coupon_codes WHERE code=:c"), {"c": code})).first():
            raise svc.Reject("CODE_EXISTS", f"Code {code} already exists.", status=409)
        cid = await _new_campaign(
            s, code, "fixed", body["offer_id"], starts, ends, max_redemptions=_num(body.get("global_usage_limit")),
            max_per_user=_num(body.get("per_user_limit")), first_purchase_only=bool(body.get("first_purchase_only")),
            meta={"account_type": body.get("account_type"), "description": body.get("description")})
        await s.execute(text("INSERT INTO coupon_codes(campaign_id,code,max_uses) VALUES (:c,:code,NULL)"),
                        {"c": cid, "code": code})
        await svc.log_event("created", campaign_id=cid, reason="coupon", payload={"code": code, "type": "FIXED"}, session=s)
        await s.commit()
    return {"code": code, "campaign_id": cid}


@admin.post("/coupons/unique-batch", status_code=201)
async def create_batch(body: dict):
    qty = _num(body.get("quantity")) or 0
    if not 1 <= qty <= 10_000 or not body.get("name"):
        raise svc.Reject("INVALID_INPUT", "A name and a quantity between 1 and 10,000 are required.", status=422)
    prefix = (body.get("prefix") or "SL").upper()
    async with SessionLocal() as s:
        cid = await _new_campaign(s, body["name"], "unique", body["offer_id"], svc.now() - timedelta(minutes=1),
                                  _dt(body.get("valid_until"), FAR_FUTURE),
                                  meta={"prefix": prefix, "account_type": body.get("account_type")})
        codes = await svc.insert_codes(s, cid, qty, prefix=prefix, max_uses=1)
        await svc.log_event("created", campaign_id=cid, reason="batch", payload={"name": body["name"], "quantity": qty}, session=s)
        await s.commit()
    return {"codes": codes, "batch": {"id": cid, "name": body["name"]}}


@admin.post("/coupons/user-pin", status_code=201)
async def create_user_pin(body: dict):
    pin = body.get("pin") or "".join(random.choice("0123456789") for _ in range(6))
    if not re.fullmatch(r"\d{4,8}", str(pin)):
        raise svc.Reject("INVALID_INPUT", "PIN must be 4-8 digits.", status=422)
    async with SessionLocal() as s:
        user = (await s.execute(text("SELECT id, email FROM users WHERE id=:i"), {"i": int(body["user_id"])})).mappings().first()
        if not user:
            raise svc.Reject("NOT_FOUND", "Customer not found.", status=404)
        cid = await _new_campaign(s, f"PIN · {user['email']}", "user_pin", body["offer_id"],
                                  svc.now() - timedelta(minutes=1), _dt(body.get("valid_until"), FAR_FUTURE),
                                  max_per_user=1, first_purchase_only=bool(body.get("first_purchase_only")),
                                  meta={"description": body.get("description")})
        [code] = await svc.insert_codes(s, cid, 1, prefix="VIP", user_id=user["id"], pin_hash=svc.ph.hash(str(pin)))
        await svc.log_event("created", campaign_id=cid, user_id=user["id"], reason="pin_coupon", payload={"code": code}, session=s)
        await s.commit()
    return {"pin": str(pin), "code": code, "user": {"email": user["email"]}}


@admin.patch("/coupons/{coupon_id}/status")
async def coupon_status(coupon_id: int, body: dict):
    new = "revoked" if body.get("status") == "DISABLED" else "active"
    async with SessionLocal() as s:
        code = (await s.execute(text("UPDATE coupon_codes SET status=:s WHERE id=:i RETURNING code"),
                                {"s": new, "i": coupon_id})).scalar()
        if not code:
            raise svc.Reject("NOT_FOUND", "Coupon not found.", status=404)
        await svc.log_event("updated", code_id=coupon_id, reason=f"status={new}", session=s)
        await s.commit()
    await cache.delete(svc.def_key(code))
    return {"ok": True}


@admin.post("/coupons/{coupon_id}/unlock-pin")
async def unlock_pin(coupon_id: int):
    async with SessionLocal() as s:
        code = (await s.execute(text(
            "UPDATE coupon_codes SET status='active', pin_attempts=0 WHERE id=:i AND status='locked' RETURNING code"),
            {"i": coupon_id})).scalar()
        await svc.log_event("updated", code_id=coupon_id, reason="pin_unlocked", session=s)
        await s.commit()
    if code:
        await cache.delete(svc.def_key(code))
    return {"ok": True}


@admin.get("/coupons/batches")
async def batches():
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT k.id, k.name, k.meta->>'prefix' AS prefix, k.ends_at AS valid_until, o.name AS offer_name,
                   count(c.id)::int AS quantity, count(c.id) FILTER (WHERE c.used_count>0)::int AS redeemed,
                   min(c.created_at) AS created_at
            FROM campaigns k JOIN offers o ON o.id=k.offer_id JOIN coupon_codes c ON c.campaign_id=k.id
            WHERE k.kind='unique' GROUP BY k.id, o.name ORDER BY k.id DESC"""))).mappings().all()
    return [{**dict(r), "valid_until": _real_end(r["valid_until"])} for r in rows]


@admin.get("/coupons/batches/{batch_id}/codes")
async def batch_codes(batch_id: int, format: str = "json"):
    async with SessionLocal() as s:
        rows = (await s.execute(text(
            "SELECT code, used_count FROM coupon_codes WHERE campaign_id=:c ORDER BY id"), {"c": batch_id})).all()
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["code", "redeemed"])
        w.writerows([(c, "yes" if u else "no") for c, u in rows])
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return [c for c, _ in rows]


@admin.get("/coupons/{coupon_id}/redemptions")
async def coupon_redemptions(coupon_id: int):
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT r.id, COALESCE(r.confirmed_at, r.created_at) AS redeemed_at, u.email, r.order_id AS order_ref,
                   r.cart_subtotal AS order_amount, r.discount_applied AS discount_amount
            FROM redemptions r LEFT JOIN users u ON u.id=r.user_id
            WHERE r.coupon_code_id=:c AND r.status IN ('reserved','confirmed') ORDER BY r.id DESC"""),
            {"c": coupon_id})).mappings().all()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ programs (signup / referral)
@admin.get("/programs/signup")
async def signup_programs():
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT k.id, k.name, k.status, k.first_purchase_only, k.meta, o.name AS offer_name,
                   (SELECT count(*) FROM coupon_codes c WHERE c.campaign_id=k.id)::int AS issued,
                   (SELECT count(*) FROM coupon_codes c WHERE c.campaign_id=k.id AND c.used_count>0)::int AS redeemed
            FROM campaigns k JOIN offers o ON o.id=k.offer_id WHERE k.kind='signup' ORDER BY k.id DESC"""))).mappings().all()
    return [{"id": r["id"], "name": r["name"], "offer_name": r["offer_name"], "is_active": r["status"] == "active",
             "account_type": _obj(r["meta"]).get("account_type"), "validity_days": _obj(r["meta"]).get("validity_days", 30),
             "first_purchase_only": r["first_purchase_only"], "issued": r["issued"], "redeemed": r["redeemed"]} for r in rows]


@admin.post("/programs/signup", status_code=201)
async def create_signup(body: dict):
    async with SessionLocal() as s:
        cid = await _new_campaign(s, body.get("name") or "Signup coupon", "signup", body["offer_id"],
                                  svc.now() - timedelta(minutes=1), FAR_FUTURE, max_per_user=1,
                                  first_purchase_only=bool(body.get("first_purchase_only", True)),
                                  meta={"account_type": body.get("account_type"),
                                        "validity_days": _num(body.get("validity_days")) or 30})
        await svc.log_event("created", campaign_id=cid, reason="signup_program", session=s)
        await s.commit()
    return {"id": cid}


@admin.patch("/programs/{kind}/{program_id}")
async def toggle_program(kind: str, program_id: int, body: dict):
    async with SessionLocal() as s:
        await s.execute(text("UPDATE campaigns SET status=:st WHERE id=:i AND kind=:k"),
                        {"st": "active" if body.get("is_active") else "paused", "i": program_id, "k": kind})
        await svc.log_event("updated", campaign_id=program_id, reason=f"{kind}_program toggled", session=s)
        await s.commit()
    return {"ok": True}


@admin.get("/programs/referral")
async def referral_programs():
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT k.id, k.name, k.status, k.meta, o.name AS referee_offer_name, ro.name AS referrer_offer_name,
                   (SELECT count(*) FROM coupon_codes c WHERE c.campaign_id=k.id)::int AS coupons
            FROM campaigns k JOIN offers o ON o.id=k.offer_id LEFT JOIN offers ro ON ro.id=k.referrer_offer_id
            WHERE k.kind='referral' ORDER BY k.id DESC"""))).mappings().all()
        totals = (await s.execute(text(
            "SELECT count(*)::int AS referrals, count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS conversions FROM referrals"))).mappings().one()
    out = []
    for r in rows:
        m = _obj(r["meta"])
        out.append({"id": r["id"], "name": r["name"], "is_active": r["status"] == "active",
                    "referrer_reward_trigger": m.get("trigger", "FIRST_PURCHASE"),
                    "coupon_validity_days": m.get("validity_days", 30), "max_referrals_per_user": m.get("max_referrals_per_user"),
                    "referrer_offer_name": r["referrer_offer_name"],
                    "referee_offer_name": None if m.get("no_referee_reward") else r["referee_offer_name"],
                    "referrals": totals["referrals"], "conversions": totals["conversions"]})
    return out


@admin.post("/programs/referral", status_code=201)
async def create_referral(body: dict):
    referee, referrer = body.get("referee_offer_id"), body.get("referrer_offer_id")
    if not referee and not referrer:
        raise svc.Reject("INVALID_INPUT", "Choose at least one reward.", status=422)
    async with SessionLocal() as s:
        cid = await _new_campaign(
            s, body.get("name") or "Referral program", "referral", referee or referrer,
            svc.now() - timedelta(minutes=1), FAR_FUTURE,
            meta={"trigger": body.get("referrer_reward_trigger") or "FIRST_PURCHASE",
                  "validity_days": _num(body.get("coupon_validity_days")) or 30,
                  "max_referrals_per_user": _num(body.get("max_referrals_per_user")),
                  "no_referee_reward": not referee})
        if referrer:
            _strict("referral", (await _offer(s, referrer))["benefit_type"])
            await s.execute(text("UPDATE campaigns SET referrer_offer_id=:o WHERE id=:c"), {"o": int(referrer), "c": cid})
        await s.execute(text("UPDATE campaigns SET status='paused' WHERE kind='referral' AND id<>:c"), {"c": cid})
        await svc.log_event("created", campaign_id=cid, reason="referral_program", session=s)
        await s.commit()
    return {"id": cid}


@admin.get("/programs/referral/activity")
async def referral_activity():
    async with SessionLocal() as s:
        rows = (await s.execute(text(f"""
            SELECT r.id, a.email AS referrer_email, b.email AS referee_email, r.created_at, r.converted_at,
                   rc.code AS referee_coupon, rk.code AS referrer_coupon,
                   (SELECT {STATUS_SQL} FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id WHERE c.id=r.referee_code_id) AS referee_coupon_status,
                   (SELECT {STATUS_SQL} FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id WHERE c.id=r.referrer_code_id) AS referrer_coupon_status
            FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referee_id
            LEFT JOIN coupon_codes rc ON rc.id=r.referee_code_id LEFT JOIN coupon_codes rk ON rk.id=r.referrer_code_id
            ORDER BY r.id DESC LIMIT 200"""))).mappings().all()
    return [{**dict(r), "status": "CONVERTED" if r["converted_at"] else "PENDING"} for r in rows]


# ------------------------------------------------------------------ audit
ACTION = {"created": "CREATED", "reserved": "RESERVED", "confirmed": "REDEEMED", "released": "RELEASED",
          "expired": "EXPIRED", "rejected": "REJECTED", "rate_limited": "RATE_LIMITED", "updated": "UPDATED"}


@admin.get("/audit")
async def audit(limit: int = 200, entity_type: str = "", action: str = "", q: str = ""):
    async with SessionLocal() as s:
        rows = (await s.execute(text("SELECT * FROM coupon_events ORDER BY id DESC LIMIT :l"),
                                {"l": min(limit * 3, 1500)})).mappings().all()
    out = []
    for r in rows:
        act = "PIN_LOCKED" if r["event_type"] == "pin_failed" and r["reason"] == "locked" else \
              "PIN_FAILED" if r["event_type"] == "pin_failed" else ACTION.get(r["event_type"], r["event_type"].upper())
        etype = "coupon" if r["coupon_code_id"] else "campaign" if r["campaign_id"] else "user" if r["user_id"] else "offer"
        details = {**(_obj(r["payload"])), "reason": r["reason"], "user_id": r["user_id"]}
        item = {"id": r["id"], "created_at": r["created_at"], "action": act, "entity_type": etype,
                "entity_id": r["coupon_code_id"] or r["campaign_id"] or r["user_id"], "actor": "system", "details": details}
        if entity_type and etype != entity_type:
            continue
        if action and act != action:
            continue
        if q and q.lower() not in json.dumps(details, default=str).lower():
            continue
        out.append(item)
    return out[:limit]


@admin.get("/audit/attempts")
async def attempts():
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT e.id, e.created_at, e.event_type, e.reason, e.payload, e.user_id, u.email
            FROM coupon_events e LEFT JOIN users u ON u.id=e.user_id
            WHERE e.event_type IN ('rejected','reserved','rate_limited','pin_failed') ORDER BY e.id DESC LIMIT 200"""))).mappings().all()
    out = []
    for r in rows:
        p = _obj(r["payload"])
        outcome = "SUCCESS" if r["event_type"] == "reserved" else \
                  ("PIN_LOCKED" if r["reason"] == "locked" else "PIN_INVALID") if r["event_type"] == "pin_failed" \
                  else (r["reason"] or r["event_type"].upper())
        out.append({"id": r["id"], "created_at": r["created_at"], "code_attempted": p.get("code", "—"),
                    "email": r["email"], "user_id": r["user_id"], "ip": p.get("ip", "—"), "outcome": outcome})
    return out


# ------------------------------------------------------------------ analytics
@admin.get("/analytics/overview")
async def overview(days: int = 30):
    days = min(max(days, 1), 365)
    iv = timedelta(days=days)
    async with SessionLocal() as s:
        async def one(sql):
            return dict((await s.execute(text(sql), {"d": iv, "n": days})).mappings().one())

        async def many(sql):
            return [dict(r) for r in (await s.execute(text(sql), {"d": iv, "n": days})).mappings().all()]

        t = await one(f"""SELECT
          (SELECT count(*) FROM coupon_codes)::int AS coupons_total,
          (SELECT count(*) FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id WHERE {STATUS_SQL}='ACTIVE')::int AS coupons_active,
          (SELECT count(*) FROM redemptions WHERE status='confirmed')::int AS redemptions_total,
          (SELECT count(*) FROM redemptions WHERE status='confirmed' AND confirmed_at > now() - CAST(:d AS interval))::int AS redemptions_period,
          (SELECT COALESCE(sum(discount_applied),0)::float FROM redemptions WHERE status='confirmed') AS discount_total,
          (SELECT count(*) FROM orders WHERE status='paid')::int AS orders_total,
          (SELECT count(*) FROM orders WHERE status='paid' AND coupon_code IS NOT NULL)::int AS orders_with_coupon,
          (SELECT count(*) FROM users)::int AS users_total,
          (SELECT count(*) FROM coupon_events WHERE event_type IN ('rejected','pin_failed','rate_limited')
              AND created_at > now() - CAST(:d AS interval))::int AS failed_attempts_period,
          (SELECT count(*) FROM coupon_codes WHERE used_count>0)::int AS redeemed_codes,
          (SELECT COALESCE(sum(subtotal) FILTER (WHERE coupon_code IS NOT NULL),0)::float FROM orders WHERE status='paid') AS revenue_with_coupon,
          (SELECT COALESCE(avg(subtotal) FILTER (WHERE coupon_code IS NOT NULL),0)::float FROM orders WHERE status='paid') AS aov_with_coupon,
          (SELECT COALESCE(avg(subtotal) FILTER (WHERE coupon_code IS NULL),0)::float FROM orders WHERE status='paid') AS aov_without_coupon,
          (SELECT COALESCE(avg(extract(epoch FROM (r.confirmed_at-c.created_at))/3600),0)::float FROM redemptions r
             JOIN coupon_codes c ON c.id=r.coupon_code_id WHERE r.status='confirmed') AS avg_hours_to_redeem,
          (SELECT count(*) FROM coupon_events WHERE event_type='reserved' AND created_at > now() - CAST(:d AS interval))::int AS applied,
          (SELECT count(*) FROM coupon_codes WHERE status='locked')::int AS active_pin_lockouts,
          (SELECT count(*) FROM coupon_events WHERE event_type='pin_failed' AND reason='locked' AND created_at > now() - CAST(:d AS interval))::int AS pin_lockout_events,
          (SELECT count(*) FROM coupon_events WHERE event_type='rate_limited' AND created_at > now() - CAST(:d AS interval))::int AS rate_limited_events,
          (SELECT count(DISTINCT payload->>'ip') FROM coupon_events WHERE event_type IN ('rejected','rate_limited')
              AND created_at > now() - CAST(:d AS interval))::int AS flagged_ips""")
        by_type = await many(f"""SELECT upper(k.kind) AS coupon_type, count(c.id)::int AS issued,
              count(c.id) FILTER (WHERE c.used_count>0)::int AS redeemed_coupons, COALESCE(sum(c.used_count),0)::int AS redemptions,
              count(c.id) FILTER (WHERE {STATUS_SQL}='EXPIRED')::int AS expired,
              count(c.id) FILTER (WHERE {STATUS_SQL}='EXHAUSTED')::int AS exhausted
            FROM campaigns k JOIN coupon_codes c ON c.campaign_id=k.id GROUP BY k.kind ORDER BY k.kind""")
        daily = await many("""SELECT d::date::text AS day, COALESCE(r.n,0)::int AS redemptions, COALESCE(r.disc,0)::float AS discount
            FROM generate_series((now()::date - (:n - 1)), now()::date, interval '1 day') d
            LEFT JOIN (SELECT confirmed_at::date AS day, count(*) n, sum(discount_applied) disc FROM redemptions
                       WHERE status='confirmed' GROUP BY 1) r ON r.day=d::date ORDER BY d""")
        top = await many("""SELECT c.code, upper(k.kind) AS coupon_type, c.used_count AS usage_count, o.name AS offer_name
            FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id JOIN offers o ON o.id=COALESCE(c.offer_id,k.offer_id)
            WHERE c.used_count>0 ORDER BY c.used_count DESC LIMIT 10""")
        ref = await one("""SELECT (SELECT count(*) FROM referrals)::int AS referrals,
              (SELECT count(*) FROM referrals WHERE converted_at IS NOT NULL)::int AS converted,
              (SELECT count(DISTINCT referrer_id) FROM referrals)::int AS active_referrers,
              (SELECT count(*) FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id WHERE k.kind='referral' AND c.used_count>0)::int AS referral_coupons_redeemed,
              (SELECT count(*) FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id WHERE k.kind='referral')::int AS referral_coupons_issued,
              (SELECT count(*) FROM users WHERE referred_by IS NOT NULL)::int AS referred_users,
              (SELECT count(*) FROM users)::int AS all_users""")
        outcomes = await many("""SELECT CASE WHEN event_type='reserved' THEN 'SUCCESS'
                   WHEN event_type='pin_failed' THEN CASE WHEN reason='locked' THEN 'PIN_LOCKED' ELSE 'PIN_INVALID' END
                   ELSE COALESCE(reason, upper(event_type)) END AS outcome,
              count(*)::int AS n FROM coupon_events
            WHERE event_type IN ('reserved','rejected','rate_limited','pin_failed') AND created_at > now() - CAST(:d AS interval)
            GROUP BY 1 ORDER BY n DESC""")
    pct = lambda a, b: round(a / b * 100, 1) if b else 0
    attempts = t["applied"] + t["failed_attempts_period"]
    rev, disc = t["revenue_with_coupon"], t["discount_total"]
    totals = {**t, "redemption_rate": pct(t["redeemed_codes"], t["coupons_total"]),
              "coupon_order_share": pct(t["orders_with_coupon"], t["orders_total"]),
              "apply_success_rate": pct(t["applied"], attempts),
              "discount_roi": round(rev / disc, 1) if disc else 0,
              "security": {k: t[k] for k in ("active_pin_lockouts", "pin_lockout_events", "rate_limited_events", "flagged_ips")}}
    return {"days": days, "totals": totals,
            "byType": [{**b, "redemption_rate": pct(b["redeemed_coupons"], b["issued"])} for b in by_type],
            "daily": daily, "topCoupons": top,
            "referral": {**ref, "conversion_rate": pct(ref["converted"], ref["referrals"])}, "outcomes": outcomes}


@admin.get("/analytics/top-referrers")
async def top_referrers():
    async with SessionLocal() as s:
        rows = (await s.execute(text("""
            SELECT u.id, u.email, u.name, count(r.id)::int AS referrals,
                   count(r.id) FILTER (WHERE r.converted_at IS NOT NULL)::int AS converted
            FROM users u JOIN referrals r ON r.referrer_id=u.id GROUP BY u.id ORDER BY referrals DESC, converted DESC LIMIT 10"""))).mappings().all()
    return [dict(r) for r in rows]


@admin.get("/analytics/insights")
async def ui_insights(days: int = 30):
    m = await gather_metrics(days)
    sm = summarize(m)
    top = max(m["campaigns"], key=lambda c: c["confirmed"], default=None)
    anomalies = [{"severity": "warning", "title": a.split(":")[0].split(".")[0][:60], "description": a} for a in sm["anomalies"]]
    f, ab = m["funnel"], m["abuse"]
    rf = m["referral_funnel"]
    return {"summary": {"headline": sm["headline"], "healthScore": "Needs Attention" if len(anomalies) > 2 else "Good" if anomalies else "Excellent",
                        "anomaliesCount": len(anomalies)},
            "anomalies": anomalies, "recommendations": sm["recommended_actions"],
            "insights": [
                {"metric": "Top Performing Campaign", "value": top["name"] if top and top["confirmed"] else "N/A",
                 "detail": f"{top['confirmed'] if top else 0} confirmed redemptions"},
                {"metric": "Abuse Signal Index", "value": f"{ab['pin_failures'] + ab['rate_limited']} events",
                 "detail": f"{ab['rate_limited']} rate-limited, {ab['locked_codes']} locked PINs"},
                {"metric": "Referral Conversion", "value": f"{round(rf['reward_redeemers'] / rf['referrals'] * 100, 1) if rf['referrals'] else 0}%",
                 "detail": f"{rf['reward_redeemers']} redeemed rewards from {rf['referrals']} referrals"}]}


@admin.post("/ai/ask")
async def ai_ask(body: dict, user: dict = Depends(admin_auth)):
    """Free-form question (or 'summarize') answered by Gemini from aggregated coupon data."""
    if not await cache.allow_many([(f"rl:ai:{user['id']}", 12)], 60):
        raise svc.Reject("RATE_LIMITED", "Slow down: at most 12 AI questions per minute.", status=429)
    q = str(body.get("question") or "").strip()
    days = min(max(int(body.get("days") or 30), 1), 365)
    answer = await ai.ask(q, days)
    await svc.log_event("ai_query", reason="admin_ai", payload={"admin": user["username"], "question": q[:200]})
    return {"answer": answer, "model": settings.gemini_model}


@admin.post("/analytics/simulate")
async def simulate():
    """Generate a few realistic attempts and orders so an empty dashboard has something to show."""
    from decimal import Decimal
    made = {"orders": 0, "attempts": 0}
    async with SessionLocal() as s:
        users = [r[0] for r in (await s.execute(text("SELECT id FROM users ORDER BY id LIMIT 6"))).all()]
        fixed = [r[0] for r in (await s.execute(text(
            "SELECT c.code FROM coupon_codes c JOIN campaigns k ON k.id=c.campaign_id "
            "WHERE k.kind='fixed' AND k.status='active' AND k.ends_at>now() LIMIT 5"))).all()]
    if not users:
        raise svc.Reject("NOT_FOUND", "Create a few customers first.", status=422)
    guesses = ["SUPER50", "HACK2026", "FREE100", "TESTCODE", "WINTER99"]
    for i in range(12):
        u = random.choice(users)
        ip = f"10.1.{random.randint(0, 5)}.{random.randint(1, 250)}"
        code = random.choice(fixed + guesses) if fixed else random.choice(guesses)
        try:
            res = await svc.validate(code, u, Decimal(random.choice([1999, 4999, 14999])), False, ip)
            made["attempts"] += 1
            if random.random() < 0.6:
                oid = f"SIM-{random.randint(10**7, 10**8)}"
                await svc.reserve(code, u, oid, Decimal(res["final_price"] + res["discount"]), False, None, ip)
                await svc.confirm(oid)
                async with SessionLocal() as s:
                    await s.execute(text("UPDATE orders SET subtotal=:s, discount=:d, coupon_code=:c WHERE id=:o"),
                                    {"s": res["final_price"] + res["discount"], "d": res["discount"], "c": code, "o": oid})
                    await s.commit()
                made["orders"] += 1
        except svc.Reject:
            made["attempts"] += 1
    return {"ok": True, "message": f"Simulated {made['attempts']} attempts and {made['orders']} orders.", "result": made}


router.include_router(admin)
