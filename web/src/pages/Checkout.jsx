import React, { useEffect, useState } from 'react';
import { api, fmtINR, fmtDate } from '../api/client.js';
import { ACCOUNT_TYPES, DEFAULT_ACCOUNT_TYPE, accountLabel } from '../constants.js';
import { Alert, Badge, TypeChip, Modal, Field, Avatar, useToast, Empty, TYPE_LABEL } from '../components/ui.jsx';
import { IcCheck, IcTicket, IcLock, IcShield, IcZap, IcClock, IcSparkle, IcPercent, IcRupee, IcGift, IcPlus, IcX } from '../components/Icons.jsx';

const PLANS = [
  { id: 'solo-monthly', for: 'Individual', name: 'Lab Access · Monthly', price: 1999, per: '/ month', feats: ['40 lab hours', 'All device simulators', 'Community support'] },
  { id: 'solo-annual', for: 'Individual', name: 'Lab Access · Annual', price: 14999, per: '/ year', feats: ['Unlimited lab hours', 'All device simulators', '200 AI credits'] },
  { id: 'org-team', for: 'Organization', name: 'Team Lab · 10 seats', price: 49999, per: '/ year', feats: ['10 engineer seats', 'Private workspaces', 'Priority support'] },
  { id: 'org-enterprise', for: 'Organization', name: 'Enterprise Lab', price: 149999, per: '/ year', feats: ['Unlimited seats', 'SSO & audit', 'Dedicated success manager'] },
];
const BENEFIT_ICON = { PERCENT_DISCOUNT: IcPercent, FIXED_DISCOUNT: IcRupee, EXTRA_HOURS: IcClock, AI_CREDITS: IcSparkle, CUSTOM: IcGift };

export default function Checkout() {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [plan, setPlan] = useState(PLANS[0]);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [needsPin, setNeedsPin] = useState(false);
  const [applied, setApplied] = useState(null);
  const [msg, setMsg] = useState(null);
  const [hasPromo, setHasPromo] = useState(false);
  const [wallet, setWallet] = useState([]);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);
  const [reg, setReg] = useState({ name: '', email: '', account_type: DEFAULT_ACCOUNT_TYPE, referral_code: '' });
  const [regErr, setRegErr] = useState('');
  const [placed, setPlaced] = useState(null);

  const loadUsers = async () => { const list = await api.get('/api/users'); setUsers(list); if (!userId && list.length) setUserId(String(list[list.length - 1].id)); };
  useEffect(() => { loadUsers(); }, []);
  const loadWallet = async () => { if (!userId) return; const [w, o] = await Promise.all([api.get(`/api/users/${userId}/coupons?available=1`), api.get(`/api/users/${userId}/orders`)]); setWallet(w); setOrders(o); };
  useEffect(() => { loadWallet(); removeCoupon(); }, [userId]);
  const user = users.find((u) => String(u.id) === String(userId));

  function removeCoupon() { setApplied(null); setCode(''); setPin(''); setNeedsPin(false); setMsg(null); }

  const apply = async (c = code, p = pin) => {
    if (!c) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/api/checkout/validate', { user_id: Number(userId), subtotal: plan.price, coupon_code: c, pin: p || undefined, has_existing_promotion: hasPromo });
      setApplied(r.coupon); setCode(r.coupon.code); setNeedsPin(false); setMsg({ kind: 'success', text: r.message });
    } catch (e) {
      setApplied(null);
      if (e.code === 'PIN_REQUIRED') { setCode(c); setNeedsPin(true); setMsg({ kind: 'warn', text: 'This is a protected coupon. Enter the PIN you were given to apply it.' }); }
      else if (e.code === 'PIN_INVALID') { setNeedsPin(true); setMsg({ kind: 'error', text: `${e.message} ${e.extra.attemptsRemaining} attempt(s) remaining before the coupon locks.` }); }
      else setMsg({ kind: 'error', text: e.message });
    } finally { setBusy(false); }
  };

  const placeOrder = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/checkout', { user_id: Number(userId), subtotal: plan.price, description: plan.name, coupon_code: applied ? applied.code : null, pin: pin || undefined, has_existing_promotion: hasPromo });
      setPlaced(r); removeCoupon(); loadWallet(); loadUsers();
    } catch (e) { setMsg({ kind: 'error', text: e.message }); if (e.code === 'PIN_REQUIRED' || e.code === 'PIN_INVALID') setNeedsPin(true); }
    finally { setBusy(false); }
  };

  const register = async () => {
    setRegErr('');
    try {
      const r = await api.post('/api/users/register', { ...reg, referral_code: reg.referral_code || null });
      const extras = [r.signupCoupon && `welcome coupon ${r.signupCoupon.code}`, r.referral?.refereeCoupon && `referral reward ${r.referral.refereeCoupon}`].filter(Boolean);
      toast.success(`Account created for ${r.user.name}${extras.length ? ` · ${extras.join(', ')} added to wallet` : ''}`);
      setSignup(false); setReg({ name: '', email: '', account_type: DEFAULT_ACCOUNT_TYPE, referral_code: '' });
      await loadUsers(); setUserId(String(r.user.id));
    } catch (e) { setRegErr(e.message); }
  };

  const discount = applied?.discountAmount || 0;
  const total = Math.max(0, plan.price - discount);

  return (
    <>
      <div className="store-head">
        <div><h1>Checkout</h1><p className="text-2" style={{ marginTop: 4 }}>Secure checkout for SemiconLabs lab subscriptions.</p></div>
        <button className="btn" onClick={() => setSignup(true)}><IcPlus />New customer account</button>
      </div>

      <div className="checkout">
        <div className="stack">
          <section className="card">
            <div className="card-head"><div className="step"><span className="step-no">1</span><h2>Account</h2></div></div>
            <div className="card-body stack">
              <Field label="Customer"><select value={userId} onChange={(e) => setUserId(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}</select></Field>
              {user && <div className="account-card"><Avatar name={user.name} size="lg" />
                <div style={{ flex: 1, minWidth: 0 }}><div className="row" style={{ gap: 8 }}><strong>{user.name}</strong><Badge outline dot={false}>{accountLabel(user.account_type)}</Badge>{user.purchases_count === 0 && <Badge kind="info" dot={false}>First purchase</Badge>}</div>
                  <div className="small muted truncate">{user.email} · {user.purchases_count} previous order{user.purchases_count === 1 ? '' : 's'}{user.referred_by_email ? ` · referred by ${user.referred_by_email}` : ''}</div></div>
                <div style={{ textAlign: 'right' }}><div className="tiny muted">Your referral code</div><span className="code-chip">{user.referral_code}</span></div></div>}
            </div>
          </section>

          <section className="card">
            <div className="card-head"><div className="step"><span className="step-no">2</span><h2>Plan</h2></div><label className="check small text-2"><input type="checkbox" checked={hasPromo} onChange={(e) => { setHasPromo(e.target.checked); setApplied(null); setMsg(null); }} />Cart already has a promotion (test)</label></div>
            <div className="card-body"><div className="plan-grid">
              {PLANS.map((p) => (
                <label key={p.id} className={`plan ${plan.id === p.id ? 'on' : ''}`}>
                  <input type="radio" name="plan" checked={plan.id === p.id} onChange={() => { setPlan(p); setApplied(null); setMsg(null); }} />
                  <span className="tick">{plan.id === p.id && <IcCheck width="12" height="12" />}</span>
                  <div className="plan-for">{p.for}</div><div className="plan-name">{p.name}</div>
                  <div className="plan-price">{fmtINR(p.price)} <small>{p.per}</small></div>
                  <ul>{p.feats.map((f) => <li key={f}><IcCheck />{f}</li>)}</ul>
                </label>
              ))}
            </div></div>
          </section>

          <section className="card">
            <div className="card-head"><div className="step"><span className="step-no">3</span><h2>Apply coupon</h2></div><span className="small muted">One coupon per order</span></div>
            <div className="card-body stack">
              {applied ? (
                <div className="ticket">
                  <div className="ticket-main"><div className="row" style={{ gap: 8 }}><span className="ticket-code">{applied.code}</span><Badge kind="info" dot={false}>{TYPE_LABEL[applied.type]}</Badge></div>
                    <div className="small text-2" style={{ marginTop: 4 }}>{applied.offer.name} · {applied.offer.summary}</div>
                    <div className="tiny muted" style={{ marginTop: 2 }}>Valid until {fmtDate(applied.validUntil)}</div></div>
                  <div className="ticket-side"><span className="ticket-save">{discount ? `−${fmtINR(discount)}` : 'Bonus'}</span><button className="btn btn-ghost btn-sm" onClick={removeCoupon}><IcX />Remove</button></div>
                </div>
              ) : (
                <>
                  <div className="coupon-input">
                    <input placeholder="ENTER CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-label="Coupon code" />
                    <button className="btn btn-primary" onClick={() => apply()} disabled={busy || !code}>{busy ? 'Checking…' : 'Apply'}</button>
                  </div>
                  {needsPin && <div className="coupon-input">
                    <input placeholder="PIN" value={pin} inputMode="numeric" maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-label="Coupon PIN" autoFocus />
                    <button className="btn btn-primary" onClick={() => apply()} disabled={busy || !pin}><IcLock />Verify PIN</button>
                  </div>}
                </>
              )}
              {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
              <div>
                <h3 style={{ marginBottom: 10 }}>Available coupons</h3>
                {wallet.length === 0 ? <Empty icon={IcTicket}>No coupons available right now.</Empty> : (
                  <div className="wallet">{wallet.map((w) => { const usable = w.status === 'ACTIVE'; const Icon = BENEFIT_ICON[w.benefit_type] || IcGift; return (
                    <div key={w.id} className={`wallet-item ${usable ? '' : 'used'}`} onClick={() => usable && !applied && apply(w.code, '')} role="button" tabIndex={usable ? 0 : -1}>
                      <span className="wallet-icon"><Icon /></span>
                      <div style={{ flex: 1, minWidth: 0 }}><div className="row" style={{ gap: 8 }}><span className="code-chip">{w.code}</span>{w.requires_pin && <Badge dot={false}><IcLock width="10" height="10" />PIN</Badge>}{!w.is_public && <Badge kind="info" dot={false}>For you</Badge>}{w.first_purchase_only && <Badge dot={false}>1st purchase</Badge>}</div>
                        <div className="small muted" style={{ marginTop: 3 }}>{w.offer_summary} · {TYPE_LABEL[w.coupon_type]} · expires {fmtDate(w.valid_until)}</div></div>
                      {usable ? <span className="small" style={{ color: 'var(--brand-text)', fontWeight: 500 }}>Apply</span> : <Badge>{w.status}</Badge>}
                    </div>); })}</div>
                )}
              </div>
            </div>
          </section>
        </div>

        <aside className="stack sticky">
          <div className="card card-pad">
            <h2 style={{ marginBottom: 12 }}>Order summary</h2>
            <div className="summary-line"><span className="text-2">{plan.name}</span><span>{fmtINR(plan.price)}</span></div>
            <div className="summary-line" style={{ color: discount ? 'var(--good-text)' : 'var(--muted)' }}><span>Coupon {applied ? <span className="code-chip" style={{ marginLeft: 4 }}>{applied.code}</span> : 'discount'}</span><span>−{fmtINR(discount)}</span></div>
            <div className="summary-line total"><span>Total due</span><span>{fmtINR(total)}</span></div>
            {applied?.benefit?.extraHours && <div className="perk mt"><IcClock />+{applied.benefit.extraHours} bonus lab hours included</div>}
            {applied?.benefit?.aiCredits && <div className="perk mt"><IcSparkle />+{applied.benefit.aiCredits} AI credits included</div>}
            <button className="btn btn-primary btn-lg btn-block mt" onClick={placeOrder} disabled={busy || !userId}>{busy ? 'Processing…' : `Pay ${fmtINR(total)}`}</button>
            <div className="trust"><span><IcShield />Secure checkout</span><span><IcZap />Instant activation</span></div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Recent orders</h2></div>
            {orders.length === 0 ? <Empty>No orders for this account.</Empty> : (
              <table><tbody>{orders.slice(0, 5).map((o) => <tr key={o.id} className="hover"><td><span className="code-chip">{o.order_ref}</span><div className="cell-sub">{fmtDate(o.created_at)}</div></td><td>{o.coupon_code ? <Badge kind="good" dot={false}>{o.coupon_code}</Badge> : <span className="muted small">no coupon</span>}</td><td className="num"><strong>{fmtINR(o.total)}</strong>{Number(o.discount_amount) > 0 && <div className="cell-sub" style={{ color: 'var(--good-text)' }}>saved {fmtINR(o.discount_amount)}</div>}</td></tr>)}</tbody></table>
            )}
          </div>
        </aside>
      </div>

      {signup && <Modal size="sm" title="Create customer account" subtitle="New accounts automatically receive the first-time signup coupon." onClose={() => setSignup(false)}
        footer={<><button className="btn" onClick={() => setSignup(false)}>Cancel</button><button className="btn btn-primary" onClick={register} disabled={!reg.name || !reg.email}>Create account</button></>}>
        <Field label="Full name"><input autoFocus value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="Account type"><select value={reg.account_type} onChange={(e) => setReg({ ...reg, account_type: e.target.value })}>{ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
          <Field label="Referral code" hint="Optional · unlocks referral rewards"><input value={reg.referral_code} onChange={(e) => setReg({ ...reg, referral_code: e.target.value.toUpperCase() })} placeholder="e.g. ASHA8K2PQ" /></Field>
        </div>
        {regErr && <Alert kind="error">{regErr}</Alert>}
      </Modal>}

      {placed && <Modal size="sm" title="Order confirmed" onClose={() => setPlaced(null)} footer={<button className="btn btn-primary" onClick={() => setPlaced(null)}>Done</button>}>
        <div style={{ textAlign: 'center', padding: '8px 0' }}><div className="brand-mark" style={{ margin: '0 auto 12px', width: 52, height: 52, borderRadius: 16, background: 'var(--good)' , boxShadow: 'none' }}><IcCheck width="26" height="26" /></div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>{fmtINR(placed.order.total)}</div><div className="muted small">Order {placed.order.orderRef}</div></div>
        <dl className="kv"><dt>Plan</dt><dd>{plan.name}</dd><dt>Subtotal</dt><dd>{fmtINR(placed.order.subtotal)}</dd>
          {placed.coupon && <><dt>Coupon</dt><dd><span className="code-chip">{placed.coupon.code}</span> · {placed.coupon.offer.summary}</dd><dt>You saved</dt><dd style={{ color: 'var(--good-text)', fontWeight: 600 }}>{fmtINR(placed.order.discountAmount)}</dd></>}
          {placed.order.benefits?.extraHours && <><dt>Bonus</dt><dd>+{placed.order.benefits.extraHours} lab hours</dd></>}
          {placed.order.benefits?.aiCredits && <><dt>Bonus</dt><dd>+{placed.order.benefits.aiCredits} AI credits</dd></>}</dl>
      </Modal>}
    </>
  );
}
