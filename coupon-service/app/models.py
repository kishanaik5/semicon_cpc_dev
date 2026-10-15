"""Six tables from the design: offers, campaigns, coupon_codes, redemptions, referrals, coupon_events (+ demo orders)."""
from datetime import datetime

from sqlalchemy import (BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index,
                        Integer, Numeric, SmallInteger, String, Text, func, text)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Offer(Base):                      # WHAT the user gets
    __tablename__ = "offers"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    benefit_type: Mapped[str] = mapped_column(String(20))  # percent|flat|sub_hours|ai_credits|custom
    value: Mapped[float] = mapped_column(Numeric(12, 2))
    max_discount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    min_cart: Mapped[float | None] = mapped_column(Numeric(12, 2))
    meta: Mapped[dict | None] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    description: Mapped[str | None] = mapped_column(Text)


class Campaign(Base):                   # the RULES
    __tablename__ = "campaigns"
    __table_args__ = (CheckConstraint("ends_at > starts_at", name="valid_window"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(20))           # fixed|unique|user_pin|signup|referral
    offer_id: Mapped[int] = mapped_column(ForeignKey("offers.id"))
    referrer_offer_id: Mapped[int | None] = mapped_column(ForeignKey("offers.id"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    max_redemptions: Mapped[int | None] = mapped_column(Integer)  # global cap, null = unlimited
    redeemed_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    max_per_user: Mapped[int | None] = mapped_column(Integer)
    first_purchase_only: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    status: Mapped[str] = mapped_column(String(10), default="active", server_default="active")
    meta: Mapped[dict | None] = mapped_column(JSONB)       # account_type, validity_days, trigger, ...


class CouponCode(Base):                 # the thing a user types
    __tablename__ = "coupon_codes"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), index=True)
    offer_id: Mapped[int | None] = mapped_column(ForeignKey("offers.id"))  # override (referrer reward)
    code: Mapped[str] = mapped_column(String(40), unique=True)             # normalized uppercase
    assigned_user_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    pin_hash: Mapped[str | None] = mapped_column(Text)                     # argon2
    pin_attempts: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    max_uses: Mapped[int | None] = mapped_column(Integer)                  # 1 for unique codes
    used_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    status: Mapped[str] = mapped_column(String(10), default="active", server_default="active")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # per-code expiry (signup/referral)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Redemption(Base):
    __tablename__ = "redemptions"
    __table_args__ = (
        # ONE coupon per order: unique while the reservation is alive
        Index("one_coupon_per_order", "order_id", unique=True, postgresql_where=text("status <> 'released'")),
        Index("redemptions_campaign_user", "campaign_id", "user_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    coupon_code_id: Mapped[int] = mapped_column(ForeignKey("coupon_codes.id"))
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"))
    user_id: Mapped[int] = mapped_column(BigInteger)
    order_id: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(10))         # reserved|confirmed|released
    cart_subtotal: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    discount_applied: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    reserved_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Referral(Base):
    __tablename__ = "referrals"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    referrer_id: Mapped[int] = mapped_column(BigInteger)
    referee_id: Mapped[int] = mapped_column(BigInteger, unique=True)  # a referee is rewarded only once
    referrer_code_id: Mapped[int | None] = mapped_column(ForeignKey("coupon_codes.id"))
    referee_code_id: Mapped[int | None] = mapped_column(ForeignKey("coupon_codes.id"))
    status: Mapped[str] = mapped_column(String(10))         # pending|qualified|rewarded
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CouponEvent(Base):                # append-only audit log
    __tablename__ = "coupon_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(20), index=True)
    campaign_id: Mapped[int | None] = mapped_column(BigInteger)
    coupon_code_id: Mapped[int | None] = mapped_column(BigInteger)
    user_id: Mapped[int | None] = mapped_column(BigInteger)
    reason: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class Order(Base):                      # minimal demo table so "first purchase" has something to check
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending|paid|failed|refunded
    subtotal: Mapped[float | None] = mapped_column(Numeric(12, 2))
    discount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    coupon_code: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):                       # minimal customer record used by the storefront UI
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    email: Mapped[str] = mapped_column(Text, unique=True)
    account_type: Mapped[str] = mapped_column(String(20), default="INDIVIDUAL")
    referral_code: Mapped[str] = mapped_column(String(20), unique=True)
    referred_by: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AdminUser(Base):                  # PF Admin accounts: argon2 password hash, never the plain password
    __tablename__ = "admin_users"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(String(60), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AdminSession(Base):               # server-side sessions; the browser only holds a random token
    __tablename__ = "admin_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)   # sha256(token)
    admin_id: Mapped[int] = mapped_column(ForeignKey("admin_users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ip: Mapped[str | None] = mapped_column(String(64))
