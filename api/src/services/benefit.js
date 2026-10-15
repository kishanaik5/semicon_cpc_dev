/**
 * Compute what an offer gives for a given order subtotal.
 * Returns { discountAmount, benefit } where benefit is a JSON description
 * of non-monetary perks (extra hours, AI credits, custom).
 */
export function computeBenefit(offer, subtotal) {
  const sub = Number(subtotal) || 0;
  const value = Number(offer.value) || 0;
  let discountAmount = 0;
  let benefit = { type: offer.benefit_type };

  switch (offer.benefit_type) {
    case 'PERCENT_DISCOUNT': {
      discountAmount = (sub * value) / 100;
      if (offer.max_discount != null) discountAmount = Math.min(discountAmount, Number(offer.max_discount));
      benefit.percent = value;
      break;
    }
    case 'FIXED_DISCOUNT': {
      discountAmount = Math.min(value, sub);
      benefit.amount = value;
      break;
    }
    case 'EXTRA_HOURS': {
      benefit.extraHours = value;
      break;
    }
    case 'AI_CREDITS': {
      benefit.aiCredits = value;
      break;
    }
    case 'CUSTOM':
    default: {
      benefit = { type: 'CUSTOM', ...(offer.config || {}) };
      break;
    }
  }

  discountAmount = Math.round(discountAmount * 100) / 100;
  return { discountAmount, benefit, total: Math.max(0, Math.round((sub - discountAmount) * 100) / 100) };
}

export function describeOffer(offer) {
  const v = Number(offer.value);
  switch (offer.benefit_type) {
    case 'PERCENT_DISCOUNT':
      return `${v}% off${offer.max_discount != null ? ` (max ₹${Number(offer.max_discount)})` : ''}`;
    case 'FIXED_DISCOUNT':
      return `₹${v} off`;
    case 'EXTRA_HOURS':
      return `+${v} lab hours`;
    case 'AI_CREDITS':
      return `+${v} AI credits`;
    default:
      return offer.config?.label || 'Custom benefit';
  }
}
