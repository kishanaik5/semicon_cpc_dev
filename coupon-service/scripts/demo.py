"""Walks the PDF's demo script against a running API.  python -m scripts.demo [base_url]"""
import sys, time, httpx
from app.config import settings

B = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
ADM, SVC = {"X-Admin-Key": settings.admin_api_key}, {"X-Service-Key": settings.internal_api_key}
c = httpx.Client(base_url=B, timeout=120)
T = str(int(time.time()))[-6:]


def show(title, r):
    j = r.json()
    print(f"{title:<46} {r.status_code}  {j.get('reason') or j.get('status') or j.get('ok')}  "
          f"{j.get('message', '') if r.status_code >= 400 else ''}")
    return j


def reserve(code, user, order, pin=None, sub=1000, **kw):
    return c.post("/coupons/reserve", json={"code": code, "user_id": user, "order_id": order, "subtotal": sub,
                                            **({"pin": pin} if pin else {}), **kw})


for i in range(6):
    show(f"0 LAUNCH10 user #{i+1} (cap 5)", reserve("LAUNCH10", 200 + i, f"l{i}-{T}"))
show("2 unknown code", c.post("/coupons/validate", json={"code": "NOPE", "user_id": 1, "subtotal": 1000}))
codes = c.get("/admin/campaigns", headers=ADM).json()
uniq = next(k for k in codes if k["kind"] == "unique")["id"]
code = c.get(f"/admin/campaigns/{uniq}/codes?limit=1", headers=ADM).json()[0]["code"]
show("3a unique code, user 1", reserve(code, 1, f"u1-{T}"))
show("3b same unique code, user 2 (rejected)", reserve(code, 2, f"u2-{T}"))
show("4 second coupon on same order", reserve("LAUNCH10", 1, f"u1-{T}"))
show("5 promotion already on cart", c.post("/coupons/validate", json={"code": "LAUNCH10", "user_id": 3, "subtotal": 1000, "has_promotion": True}))
vip = next(k for k in codes if k["kind"] == "user_pin")["id"]
vcode = [x for x in c.get(f"/admin/campaigns/{vip}/codes", headers=ADM).json() if x["assigned_user_id"] == 102][0]["code"]
show("6a PIN required", reserve(vcode, 102, f"v-{T}"))
for i in range(5):
    show(f"6b wrong PIN #{i+1}", reserve(vcode, 102, f"v-{T}", pin="0000"))
show("6c correct PIN after lockout", reserve(vcode, 102, f"v-{T}", pin="4321"))
uid = 900000 + int(T)
j = show("7a signup event", c.post("/internal/events/signup", headers=SVC, json={"user_id": uid}))
show("7b use signup coupon", reserve(j["code"], uid, f"s-{T}"))
show("7c confirm payment", c.post("/coupons/confirm", headers=SVC, json={"order_id": f"s-{T}"}))
show("8 referral event", c.post("/internal/events/referral-qualified", headers=SVC, json={"referrer_id": uid, "referee_id": uid + 1}))
show("9 release failed payment (u1 order)", c.post("/coupons/release", headers=SVC, json={"order_id": f"u1-{T}"}))
offers = c.get("/admin/offers", headers=ADM).json()
pct = next(o for o in offers if o["benefit_type"] == "percent")["id"]
show("10 strict mode: signup campaign w/ % offer", c.post("/admin/campaigns", headers=ADM, json={
    "name": f"bad-{T}", "kind": "signup", "offer_id": pct,
    "starts_at": "2020-01-01T00:00:00Z", "ends_at": "2099-01-01T00:00:00Z"}))
print(c.get("/admin/analytics/insights", headers=ADM).json()["summary"])
