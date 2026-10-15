"""Analytics: aggregate metrics (no PII) + a rule-based summary.
`summarize()` is the single place to plug in an LLM once the client approves a provider."""
from datetime import timedelta

from sqlalchemy import text

from .db import SessionLocal


async def gather_metrics(days: int = 30) -> dict:
    p = {"d": timedelta(days=int(days))}
    async with SessionLocal() as s:
        async def rows(sql, **kw):
            return [dict(r) for r in (await s.execute(text(sql), {**p, **kw})).mappings().all()]

        async def one(sql):
            return dict((await s.execute(text(sql), p)).mappings().one())

        campaigns = await rows("""
            SELECT k.id, k.name, k.kind, k.status, k.max_redemptions, k.redeemed_count, k.ends_at,
                   (SELECT count(*) FROM coupon_codes c WHERE c.campaign_id=k.id) AS codes_issued,
                   (SELECT count(*) FROM redemptions r WHERE r.campaign_id=k.id AND r.status='confirmed') AS confirmed
            FROM campaigns k ORDER BY k.id""")
        for c in campaigns:   # redemption rate = confirmed / codes issued (fixed: confirmed / cap)
            denom = c["max_redemptions"] if c["kind"] == "fixed" and c["max_redemptions"] else c["codes_issued"]
            c["redemption_rate"] = round(c["confirmed"] / denom, 3) if denom else None
            c["ends_at"] = str(c["ends_at"])

        funnel = await one("""
            SELECT count(*) FILTER (WHERE event_type='reserved') AS reserved,
                   count(*) FILTER (WHERE event_type='rejected') AS rejected,
                   count(*) FILTER (WHERE event_type='confirmed') AS confirmed,
                   count(*) FILTER (WHERE event_type IN ('released','expired')) AS released
            FROM coupon_events WHERE created_at > now() - CAST(:d AS interval)""")
        attempts = funnel["reserved"] + funnel["rejected"]
        funnel["apply_success_rate"] = round(funnel["reserved"] / attempts, 3) if attempts else None

        reasons = await rows("""
            SELECT reason, count(*) AS n FROM coupon_events
            WHERE event_type='rejected' AND created_at > now() - CAST(:d AS interval)
            GROUP BY reason ORDER BY n DESC""")

        money = await one("""
            SELECT COALESCE(sum(discount_applied),0)::float AS discount_cost,
                   COALESCE(sum(cart_subtotal),0)::float AS revenue_on_coupon_orders,
                   count(*) AS orders
            FROM redemptions WHERE status='confirmed' AND confirmed_at > now() - CAST(:d AS interval)""")

        referral = await one("""
            SELECT count(*) AS referrals,
                   count(*) FILTER (WHERE status='rewarded') AS rewarded,
                   (SELECT count(DISTINCT r.user_id) FROM redemptions r
                    JOIN coupon_codes c ON c.id=r.coupon_code_id JOIN campaigns k ON k.id=c.campaign_id
                    WHERE k.kind='referral' AND r.status='confirmed') AS reward_redeemers
            FROM referrals""")

        abuse = await one("""
            SELECT count(*) FILTER (WHERE event_type='pin_failed') AS pin_failures,
                   count(*) FILTER (WHERE event_type='rate_limited') AS rate_limited,
                   count(DISTINCT payload->>'ip') FILTER (WHERE event_type IN ('rate_limited','rejected')
                         AND reason IN ('INVALID_CODE','RATE_LIMITED')) AS ips_guessing
            FROM coupon_events WHERE created_at > now() - CAST(:d AS interval)""")
        abuse["locked_codes"] = (await s.execute(
            text("SELECT count(*) FROM coupon_codes WHERE status='locked'"))).scalar_one()

        ttr = (await s.execute(text("""
            SELECT avg(extract(epoch FROM (r.confirmed_at - c.created_at)))::float
            FROM redemptions r JOIN coupon_codes c ON c.id=r.coupon_code_id
            WHERE r.status='confirmed'"""))).scalar()

        daily = await rows("""
            SELECT date_trunc('day', confirmed_at)::date::text AS day, count(*) AS redemptions,
                   COALESCE(sum(discount_applied),0)::float AS discount
            FROM redemptions WHERE status='confirmed' AND confirmed_at > now() - CAST(:d AS interval)
            GROUP BY 1 ORDER BY 1""")

    money["revenue_per_discount"] = round(money["revenue_on_coupon_orders"] / money["discount_cost"], 2) \
        if money["discount_cost"] else None
    return {"range_days": days, "campaigns": campaigns, "funnel": funnel, "rejection_reasons": reasons,
            "money": money, "referral_funnel": referral, "abuse": abuse,
            "avg_seconds_to_redeem": round(ttr, 1) if ttr is not None else None, "daily": daily}


def summarize(m: dict) -> dict:
    """Rule-based now. Swap this for `llm.complete(system, json.dumps(m))` after provider approval."""
    flags, actions = [], []
    f, money, abuse = m["funnel"], m["money"], m["abuse"]
    total_rej = sum(r["n"] for r in m["rejection_reasons"])
    invalid = next((r["n"] for r in m["rejection_reasons"] if r["reason"] == "INVALID_CODE"), 0)
    if total_rej >= 10 and invalid / total_rej > 0.35:
        flags.append(f"Code-guessing spike: {invalid} of {total_rej} rejections were INVALID_CODE.")
        actions.append("Review rate-limit thresholds and the IPs behind the invalid attempts.")
    for c in m["campaigns"]:
        cap = c["max_redemptions"]
        if cap and c["redeemed_count"] / cap >= 0.8 and c["status"] == "active":
            flags.append(f"'{c['name']}' has used {c['redeemed_count']} of {cap} redemptions.")
            actions.append(f"Raise the cap on '{c['name']}' or announce it is almost gone.")
    if abuse["locked_codes"]:
        flags.append(f"{abuse['locked_codes']} PIN coupon(s) are locked after repeated wrong PINs.")
        actions.append("Contact the affected users and unlock only after verifying them.")
    if f["apply_success_rate"] is not None and f["apply_success_rate"] < 0.5:
        actions.append("Under half of apply attempts succeed; check messaging and eligibility rules.")
    headline = (f"{money['orders']} confirmed coupon orders, {money['discount_cost']:.0f} discount given, "
                f"apply success rate {f['apply_success_rate'] if f['apply_success_rate'] is not None else 'n/a'}.")
    return {"headline": headline, "anomalies": flags, "recommended_actions": actions[:3] or ["No action needed."]}


async def insights(days: int = 30) -> dict:
    m = await gather_metrics(days)
    return {"charts": m, "summary": summarize(m)}
