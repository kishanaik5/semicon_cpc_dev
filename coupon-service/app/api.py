"""Checkout-facing, payment-webhook and internal-event endpoints."""
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import service as svc
from .config import settings

router = APIRouter()


def internal_auth(x_service_key: str = Header(default="")):
    """Service-to-service shared secret. Never exposed to browsers."""
    if x_service_key != settings.internal_api_key:
        raise HTTPException(401, "invalid service key")


def client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)


class ValidateIn(BaseModel):
    code: str
    user_id: int
    subtotal: Decimal = Field(gt=0)
    has_promotion: bool = False           # cart already carries another promotion


class ReserveIn(ValidateIn):
    order_id: str
    pin: str | None = None


class OrderIn(BaseModel):
    order_id: str
    refund: bool = False


# ---- called by the checkout UI --------------------------------------------------------
@router.post("/coupons/validate", tags=["checkout"], summary="Read-only discount preview")
async def validate(body: ValidateIn, request: Request):
    return await svc.validate(body.code, body.user_id, body.subtotal, body.has_promotion, client_ip(request))


@router.post("/coupons/reserve", tags=["checkout"], summary="Lock the coupon when the user clicks Pay")
async def reserve(body: ReserveIn, request: Request):
    return await svc.reserve(body.code, body.user_id, body.order_id, body.subtotal,
                             body.has_promotion, body.pin, client_ip(request))


# ---- called by the payment service (webhooks) ------------------------------------------
@router.post("/coupons/confirm", tags=["payment webhook"], dependencies=[Depends(internal_auth)])
async def confirm(body: OrderIn):
    return await svc.confirm(body.order_id)


@router.post("/coupons/release", tags=["payment webhook"], dependencies=[Depends(internal_auth)])
async def release(body: OrderIn):
    return await svc.release(body.order_id, refund=body.refund)


# ---- called by auth / order services ---------------------------------------------------
class SignupIn(BaseModel):
    user_id: int


class ReferralIn(BaseModel):
    referrer_id: int
    referee_id: int


@router.post("/internal/events/signup", tags=["internal events"], dependencies=[Depends(internal_auth)])
async def on_signup(body: SignupIn):
    return await svc.issue_signup(body.user_id)


@router.post("/internal/events/referral-qualified", tags=["internal events"], dependencies=[Depends(internal_auth)])
async def on_referral(body: ReferralIn):
    return await svc.issue_referral(body.referrer_id, body.referee_id)
