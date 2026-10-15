export class CouponError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const E = {
  INVALID_CODE: ['INVALID_CODE', 'This coupon code is invalid.'],
  COUPON_DISABLED: ['COUPON_DISABLED', 'This coupon has been disabled.'],
  COUPON_NOT_STARTED: ['COUPON_NOT_STARTED', 'This coupon is not active yet.'],
  COUPON_EXPIRED: ['COUPON_EXPIRED', 'This coupon has expired.'],
  COUPON_EXHAUSTED: ['COUPON_EXHAUSTED', 'This coupon has reached its usage limit.'],
  ALREADY_USED: ['ALREADY_USED', 'You have already used this coupon.'],
  NOT_ELIGIBLE: ['NOT_ELIGIBLE', 'This coupon is not available for your account.'],
  PIN_REQUIRED: ['PIN_REQUIRED', 'This coupon requires a PIN.'],
  PIN_INVALID: ['PIN_INVALID', 'Incorrect PIN.'],
  PIN_LOCKED: ['PIN_LOCKED', 'Too many incorrect PIN attempts. Coupon temporarily locked.'],
  FIRST_PURCHASE_ONLY: ['FIRST_PURCHASE_ONLY', 'This coupon is valid only on your first purchase.'],
  MIN_ORDER_NOT_MET: ['MIN_ORDER_NOT_MET', 'Order amount does not meet the coupon minimum.'],
  PROMOTION_CONFLICT: ['PROMOTION_CONFLICT', 'Coupons cannot be combined with other offers or promotions.'],
  COUPON_ALREADY_APPLIED: ['COUPON_ALREADY_APPLIED', 'Only one coupon can be used per transaction.'],
  OFFER_INACTIVE: ['OFFER_INACTIVE', 'The offer linked to this coupon is no longer active.'],
  RATE_LIMITED: ['RATE_LIMITED', 'Too many attempts. Please try again later.'],
  USER_NOT_FOUND: ['USER_NOT_FOUND', 'User not found.'],
  ACCOUNT_TYPE_MISMATCH: ['ACCOUNT_TYPE_MISMATCH', 'This coupon is not valid for your account type.'],
};

export function fail(key, status = 400, extra = {}) {
  const [code, message] = E[key];
  return new CouponError(code, message, status, extra);
}
