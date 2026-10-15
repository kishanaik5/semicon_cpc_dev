"""Admin AI assistant (Google Gemini, free tier).

The model only ever sees aggregated numbers and campaign-level facts: no customer names/emails and
no individual unique or PIN codes. The API key stays on the server (sent in a header, never to the browser)."""
import json

import httpx
from sqlalchemy import text

from .analytics import gather_metrics
from .config import settings
from .db import SessionLocal
from .service import Reject

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

SYSTEM = (
    "You are the PF Admin assistant for the SemiconLabs coupon system. You help an administrator understand "
    "coupon performance, spot abuse and decide what to do next. Answer from the JSON data provided; if the data "
    "does not contain the answer, say so instead of guessing. You may also answer general questions about coupon "
    "or promotion strategy. Be concise: short paragraphs or '-' bullet lines, plain text only (no markdown "
    "symbols like ** or #). Amounts are in INR (rupees). Never reveal or ask for secrets, passwords or API keys."
)


async def build_context(days: int = 30) -> dict:
    m = await gather_metrics(days)
    async with SessionLocal() as s:
        coupons = [dict(r) for r in (await s.execute(text("""
            SELECT upper(k.kind) AS type, k.name AS campaign, o.name AS offer, k.status,
                   k.max_redemptions AS global_cap, k.redeemed_count, k.max_per_user, k.ends_at::date::text AS ends,
                   count(c.id)::int AS codes, COALESCE(sum(c.used_count),0)::int AS uses
            FROM campaigns k JOIN offers o ON o.id=k.offer_id LEFT JOIN coupon_codes c ON c.campaign_id=k.id
            GROUP BY k.id, o.name ORDER BY k.id"""))).mappings().all()]
        totals = dict((await s.execute(text("""
            SELECT (SELECT count(*) FROM users)::int AS customers,
                   (SELECT count(*) FROM orders WHERE status='paid')::int AS paid_orders,
                   (SELECT count(*) FROM orders WHERE status='paid' AND coupon_code IS NOT NULL)::int AS paid_orders_with_coupon,
                   (SELECT COALESCE(sum(subtotal),0)::float FROM orders WHERE status='paid') AS gross_sales,
                   (SELECT COALESCE(avg(subtotal) FILTER (WHERE coupon_code IS NOT NULL),0)::float FROM orders WHERE status='paid') AS avg_order_with_coupon,
                   (SELECT COALESCE(avg(subtotal) FILTER (WHERE coupon_code IS NULL),0)::float FROM orders WHERE status='paid') AS avg_order_without_coupon"""))).mappings().one())
    return {"period_days": days, "totals": totals, "campaigns": coupons,
            "funnel": m["funnel"], "rejection_reasons": m["rejection_reasons"], "money": m["money"],
            "referrals": m["referral_funnel"], "abuse_signals": m["abuse"],
            "avg_seconds_to_redeem": m["avg_seconds_to_redeem"], "daily_redemptions": m["daily"]}


async def ask(question: str, days: int = 30) -> str:
    if not settings.gemini_api_key:
        raise Reject("AI_NOT_CONFIGURED", "The AI assistant is not configured. Add GEMINI_API_KEY to the server's .env.", status=503)
    question = question.strip()[:1000]
    if not question:
        raise Reject("INVALID_INPUT", "Type a question first.", status=422)
    context = json.dumps(await build_context(days), default=str)
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": f"DATA (JSON):\n{context}\n\nQUESTION:\n{question}"}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 2048,
                             "thinkingConfig": {"thinkingBudget": 0}},   # no hidden reasoning tokens eating the answer
    }
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(URL.format(model=settings.gemini_model), json=body,
                             headers={"x-goog-api-key": settings.gemini_api_key})
    except httpx.HTTPError:
        raise Reject("AI_UNAVAILABLE", "Could not reach the AI service. Try again in a moment.", status=502)
    if r.status_code == 429:
        raise Reject("AI_BUSY", "The free AI quota is used up for now. Try again in a minute.", status=429)
    if r.status_code == 404:
        raise Reject("AI_MODEL_NOT_FOUND", f"Model '{settings.gemini_model}' is not available for this key. Set GEMINI_MODEL to e.g. gemini-2.5-flash.", status=502)
    if r.status_code in (400, 401, 403):
        raise Reject("AI_KEY_INVALID", "The AI service rejected the request. Check GEMINI_API_KEY and GEMINI_MODEL.", status=502)
    if r.status_code >= 400:
        raise Reject("AI_UNAVAILABLE", "The AI service returned an error. Try again later.", status=502)
    try:
        return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, ValueError):
        raise Reject("AI_UNAVAILABLE", "The AI service returned no answer (it may have been blocked). Rephrase and retry.", status=502)
