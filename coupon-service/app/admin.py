"""PF Admin endpoints: offers, campaigns, code generation. Every change is written to coupon_events."""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from . import cache
from . import service as svc
from .analytics import gather_metrics, insights
from .config import settings
from .db import SessionLocal

BenefitType = Literal["percent", "flat", "sub_hours", "ai_credits", "custom"]
Kind = Literal["fixed", "unique", "user_pin", "signup", "referral"]


def admin_auth(x_admin_key: str = Header(default="")):
    if x_admin_key != settings.admin_api_key:
        raise HTTPException(401, "admin key required")


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(admin_auth)])


# ------------------------------------------------------------------ offers
class OfferIn(BaseModel):
    name: str
    benefit_type: BenefitType
    value: float = Field(ge=0)
    max_discount: float | None = None
    min_cart: float | None = None
    meta: dict | None = None


@router.get("/offers")
async def list_offers():
    async with SessionLocal() as s:
        rows = (await s.execute(text("SELECT * FROM offers ORDER BY id"))).mappings().all()
    return [dict(r) for r in rows]


@router.post("/offers", status_code=201)
async def create_offer(o: OfferIn):
    async with SessionLocal() as s:
        oid = (await s.execute(text(
            "INSERT INTO offers(name,benefit_type,value,max_discount,min_cart,meta) "
            "VALUES (:n,:b,:v,:m,:c,CAST(:meta AS jsonb)) RETURNING id"),
            {"n": o.name, "b": o.benefit_type, "v": o.value, "m": o.max_discount, "c": o.min_cart,
             "meta": None if o.meta is None else __import__("json").dumps(o.meta)})).scalar_one()
        await svc.log_event("created", reason="offer", payload={"offer_id": oid, **o.model_dump()}, session=s)
        await s.commit()
    return {"id": oid}


# ------------------------------------------------------------------ campaigns
class CampaignIn(BaseModel):
    name: str
    kind: Kind
    offer_id: int
    referrer_offer_id: int | None = None
    starts_at: datetime
    ends_at: datetime
    max_redemptions: int | None = None
    max_per_user: int | None = None
    first_purchase_only: bool = False
    code: str | None = None               # fixed campaigns: the shared code to create


class CampaignPatch(BaseModel):
    status: Literal["active", "paused"] | None = None
    ends_at: datetime | None = None
    max_redemptions: int | None = None


@router.get("/campaigns")
async def list_campaigns():
    async with SessionLocal() as s:
        rows = (await s.execute(text(
            "SELECT k.*, o.name AS offer_name, o.benefit_type, "
            "(SELECT count(*) FROM coupon_codes c WHERE c.campaign_id=k.id) AS codes "
            "FROM campaigns k JOIN offers o ON o.id=k.offer_id ORDER BY k.id"))).mappings().all()
    return [dict(r) for r in rows]


@router.post("/campaigns", status_code=201)
async def create_campaign(c: CampaignIn):
    if c.ends_at <= c.starts_at:
        raise HTTPException(422, "ends_at must be after starts_at")
    async with SessionLocal() as s:
        for oid in filter(None, (c.offer_id, c.referrer_offer_id)):
            bt = (await s.execute(text("SELECT benefit_type FROM offers WHERE id=:i"), {"i": oid})).scalar()
            if bt is None:
                raise HTTPException(404, f"offer {oid} not found")
            try:
                svc.check_offer_allowed(c.kind, bt)        # strict / flexible mapping
            except ValueError as e:
                raise HTTPException(422, str(e))
        cid = (await s.execute(text(
            "INSERT INTO campaigns(name,kind,offer_id,referrer_offer_id,starts_at,ends_at,max_redemptions,"
            "max_per_user,first_purchase_only) VALUES (:n,:k,:o,:ro,:s,:e,:m,:p,:f) RETURNING id"),
            {"n": c.name, "k": c.kind, "o": c.offer_id, "ro": c.referrer_offer_id, "s": c.starts_at,
             "e": c.ends_at, "m": c.max_redemptions, "p": c.max_per_user, "f": c.first_purchase_only})).scalar_one()
        code = None
        if c.kind == "fixed":
            if not c.code:
                raise HTTPException(422, "fixed campaigns need a `code`")
            code = svc.norm(c.code)
            await s.execute(text(
                "INSERT INTO coupon_codes(campaign_id,code,max_uses) VALUES (:c,:code,NULL)"),
                {"c": cid, "code": code})
        await svc.log_event("created", campaign_id=cid, reason="campaign", payload=c.model_dump(mode="json"), session=s)
        await s.commit()
    return {"id": cid, "code": code}


@router.patch("/campaigns/{campaign_id}")
async def patch_campaign(campaign_id: int, p: CampaignPatch):
    fields = p.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(422, "nothing to update")
    sets = ", ".join(f"{k}=:{k}" for k in fields)
    async with SessionLocal() as s:
        ok = (await s.execute(text(f"UPDATE campaigns SET {sets} WHERE id=:id RETURNING id"),
                              {**fields, "id": campaign_id})).first()
        if not ok:
            raise HTTPException(404, "campaign not found")
        codes = (await s.execute(text("SELECT code FROM coupon_codes WHERE campaign_id=:c LIMIT 1000"),
                                 {"c": campaign_id})).scalars().all()
        await svc.log_event("updated", campaign_id=campaign_id, reason="campaign",
                            payload=p.model_dump(mode="json", exclude_unset=True), session=s)
        await s.commit()
    await cache.delete(*[svc.def_key(c) for c in codes])   # admin edit invalidates the cache
    return {"ok": True}


# ------------------------------------------------------------------ codes
class GenerateIn(BaseModel):
    count: int = Field(ge=1, le=100_000)
    prefix: str = "SL"


async def _bulk_generate(campaign_id: int, count: int, prefix: str):
    async with SessionLocal() as s:
        await svc.insert_codes(s, campaign_id, count, prefix=prefix, max_uses=1)
        await svc.log_event("created", campaign_id=campaign_id, reason="codes_generated",
                            payload={"count": count}, session=s)
        await s.commit()


@router.post("/campaigns/{campaign_id}/codes:generate", status_code=202)
async def generate_codes(campaign_id: int, body: GenerateIn, bg: BackgroundTasks):
    async with SessionLocal() as s:
        kind = (await s.execute(text("SELECT kind FROM campaigns WHERE id=:i"), {"i": campaign_id})).scalar()
    if kind is None:
        raise HTTPException(404, "campaign not found")
    if kind != "unique":
        raise HTTPException(422, "bulk generation is for `unique` campaigns")
    bg.add_task(_bulk_generate, campaign_id, body.count, body.prefix)   # background job
    return {"accepted": True, "count": body.count, "note": "generating in background; GET /admin/campaigns/{id}/codes"}


class AssignIn(BaseModel):
    user_id: int
    pin: str = Field(min_length=4, max_length=8, pattern=r"^\d+$")


@router.post("/campaigns/{campaign_id}/codes:assign", status_code=201)
async def assign_pin_code(campaign_id: int, body: AssignIn):
    """user_pin campaigns: one code per user, PIN stored as an argon2 hash."""
    async with SessionLocal() as s:
        kind = (await s.execute(text("SELECT kind FROM campaigns WHERE id=:i"), {"i": campaign_id})).scalar()
        if kind != "user_pin":
            raise HTTPException(422, "campaign is not a user_pin campaign")
        [code] = await svc.insert_codes(s, campaign_id, 1, prefix="VIP", user_id=body.user_id,
                                        pin_hash=svc.ph.hash(body.pin))
        await svc.log_event("created", campaign_id=campaign_id, user_id=body.user_id, reason="pin_code",
                            payload={"code": code}, session=s)
        await s.commit()
    return {"code": code}


@router.get("/campaigns/{campaign_id}/codes")
async def list_codes(campaign_id: int, limit: int = 100):
    async with SessionLocal() as s:
        rows = (await s.execute(text(
            "SELECT id, code, assigned_user_id, max_uses, used_count, status, pin_attempts "
            "FROM coupon_codes WHERE campaign_id=:c ORDER BY id DESC LIMIT :l"),
            {"c": campaign_id, "l": min(limit, 1000)})).mappings().all()
    return [dict(r) for r in rows]


@router.get("/events")
async def list_events(limit: int = 100, event_type: str | None = None):
    async with SessionLocal() as s:
        rows = (await s.execute(text(
            "SELECT * FROM coupon_events WHERE (:t IS NULL OR event_type=:t) ORDER BY id DESC LIMIT :l"),
            {"t": event_type, "l": min(limit, 1000)})).mappings().all()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ analytics
@router.get("/analytics/metrics")
async def metrics(range_days: int = 30):
    return await gather_metrics(range_days)


@router.get("/analytics/insights")
async def get_insights(range_days: int = 30):
    return await insights(range_days)
