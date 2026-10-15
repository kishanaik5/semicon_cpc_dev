import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api/client.js';
import { ACCOUNT_TYPES, accountLabel } from '../constants.js';
import { Badge, StatusBadge, Modal, Field, Alert, useToast, Empty, Tile } from '../components/ui.jsx';
import { IcPlus, IcGift, IcLink, IcPower, IcUser } from '../components/Icons.jsx';

export default function Programs() {
  const toast = useToast();
  const [offers, setOffers] = useState([]);
  const [signups, setSignups] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [activity, setActivity] = useState([]);
  const [modal, setModal] = useState(null); // 'signup' | 'referral'
  const [err, setErr] = useState('');
  const [s, setS] = useState({ name: '', offer_id: '', validity_days: 30, first_purchase_only: true, account_type: '' });
  const [r, setR] = useState({ name: '', referrer_offer_id: '', referee_offer_id: '', referrer_reward_trigger: 'FIRST_PURCHASE', coupon_validity_days: 30, max_referrals_per_user: '' });

  const load = () => Promise.all([api.admin.get('/api/admin/offers'), api.admin.get('/api/admin/programs/signup'), api.admin.get('/api/admin/programs/referral'), api.admin.get('/api/admin/programs/referral/activity')])
    .then(([o, sg, p, a]) => { setOffers(o); setSignups(sg); setPrograms(p); setActivity(a); });
  useEffect(() => { load(); }, []);
  const opts = offers.filter((o) => o.is_active).map((o) => <option key={o.id} value={o.id}>{o.name} — {o.summary}</option>);

  const saveSignup = async () => { setErr(''); try { await api.admin.post('/api/admin/programs/signup', { ...s, account_type: s.account_type || null }); toast.success('Signup coupon rule created'); setModal(null); load(); } catch (e) { setErr(e.message); } };
  const saveReferral = async () => { setErr(''); try { await api.admin.post('/api/admin/programs/referral', { ...r, referrer_offer_id: r.referrer_offer_id || null, referee_offer_id: r.referee_offer_id || null, max_referrals_per_user: r.max_referrals_per_user || null }); toast.success('Referral program activated'); setModal(null); load(); } catch (e) { setErr(e.message); } };
  const toggleSignup = async (x) => { await api.admin.patch(`/api/admin/programs/signup/${x.id}`, { is_active: !x.is_active }); load(); };
  const toggleReferral = async (x) => { await api.admin.patch(`/api/admin/programs/referral/${x.id}`, { is_active: !x.is_active }); load(); };
  const totalRef = activity.length, conv = activity.filter((a) => a.status === 'CONVERTED').length;

  return (
    <>
      <div className="page-head"><div><h1>Signup &amp; referral</h1><p>Rules for coupons the platform issues automatically: a welcome coupon on registration, and rewards when existing users refer new ones.</p></div></div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><div className="row"><div><h2 className="row" style={{ gap: 8 }}><IcGift style={{ color: 'var(--s4)' }} />First-time signup coupon</h2><div className="sub">Issued to every new account. The most specific active rule wins.</div></div></div><button className="btn btn-sm" onClick={() => { setErr(''); setModal('signup'); }}><IcPlus />Add rule</button></div>
          {signups.length === 0 ? <Empty>No signup rules yet.</Empty> : <table><thead><tr><th>Rule</th><th>Offer</th><th className="num">Issued · Redeemed</th><th></th></tr></thead>
            <tbody>{signups.map((x) => <tr key={x.id} className="hover"><td><strong>{x.name}</strong><div className="cell-sub">{x.account_type ? `${accountLabel(x.account_type).toLowerCase()} accounts` : 'all accounts'} · {x.validity_days} days · {x.first_purchase_only ? 'first purchase only' : 'any purchase'}</div></td><td className="small">{x.offer_name}</td><td className="num nowrap"><strong>{x.issued}</strong> <span className="muted">· {x.redeemed}</span></td>
              <td><div className="actions"><Badge kind={x.is_active ? 'good' : ''}>{x.is_active ? 'Active' : 'Off'}</Badge><button className="btn btn-sm btn-ghost" onClick={() => toggleSignup(x)}><IcPower /></button></div></td></tr>)}</tbody></table>}
        </div>

        <div className="card">
          <div className="card-head"><div><h2 className="row" style={{ gap: 8 }}><IcLink style={{ color: 'var(--s2)' }} />Referral program</h2><div className="sub">One program is active at a time. Referee reward is immediate; referrer reward follows the trigger.</div></div><button className="btn btn-sm" onClick={() => { setErr(''); setModal('referral'); }}><IcPlus />New program</button></div>
          {programs.length === 0 ? <Empty>No referral program configured.</Empty> : <table><thead><tr><th>Program</th><th>Rewards</th><th className="num">Referrals · Converted</th><th></th></tr></thead>
            <tbody>{programs.map((x) => <tr key={x.id} className="hover"><td><strong>{x.name}</strong><div className="cell-sub">referrer paid on {x.referrer_reward_trigger === 'SIGNUP' ? 'signup' : "referee's first purchase"} · {x.coupon_validity_days}d validity{x.max_referrals_per_user ? ` · max ${x.max_referrals_per_user}/user` : ''}</div></td>
              <td className="small nowrap"><div><span className="muted">Referrer</span> {x.referrer_offer_name || '—'}</div><div><span className="muted">Referee</span> {x.referee_offer_name || '—'}</div></td><td className="num nowrap"><strong>{x.referrals}</strong> <span className="muted">· {x.conversions}</span></td>
              <td><div className="actions"><Badge kind={x.is_active ? 'good' : ''}>{x.is_active ? 'Active' : 'Off'}</Badge><button className="btn btn-sm btn-ghost" onClick={() => toggleReferral(x)}><IcPower /></button></div></td></tr>)}</tbody></table>}
        </div>
      </div>

      <div className="card mt">
        <div className="card-head"><div><h2>Referral activity</h2><div className="sub">{totalRef} referral{totalRef === 1 ? '' : 's'} · {conv} converted</div></div></div>
        {activity.length === 0 ? <Empty icon={IcUser}>No referrals yet. Share a user's referral code at signup to see activity here.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Referrer</th><th>Referee</th><th>Referee coupon</th><th>Referrer coupon</th><th>Status</th><th>Signed up</th><th>Converted</th></tr></thead>
            <tbody>{activity.map((a) => <tr key={a.id} className="hover"><td>{a.referrer_email}</td><td>{a.referee_email}</td>
              <td>{a.referee_coupon ? <div className="row row-nowrap" style={{ gap: 6 }}><span className="code-chip">{a.referee_coupon}</span><StatusBadge status={a.referee_coupon_status} /></div> : '—'}</td>
              <td>{a.referrer_coupon ? <div className="row row-nowrap" style={{ gap: 6 }}><span className="code-chip">{a.referrer_coupon}</span><StatusBadge status={a.referrer_coupon_status} /></div> : <span className="muted small">awaiting first purchase</span>}</td>
              <td><StatusBadge status={a.status} /></td><td className="small">{fmtDate(a.created_at)}</td><td className="small">{fmtDate(a.converted_at)}</td></tr>)}</tbody></table></div>)}
      </div>

      {modal === 'signup' && <Modal size="sm" title="New signup coupon rule" onClose={() => setModal(null)} footer={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveSignup} disabled={!s.name || !s.offer_id}>Add rule</button></>}>
        <Field label="Rule name"><input autoFocus value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Welcome 10% for new accounts" /></Field>
        <Field label="Offer"><select value={s.offer_id} onChange={(e) => setS({ ...s, offer_id: e.target.value })}><option value="">Select an offer…</option>{opts}</select></Field>
        <div className="grid cols-2"><Field label="Valid for (days)"><input type="number" min="1" value={s.validity_days} onChange={(e) => setS({ ...s, validity_days: e.target.value })} /></Field>
          <Field label="Applies to"><select value={s.account_type} onChange={(e) => setS({ ...s, account_type: e.target.value })}><option value="">All users</option>{ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.plural}</option>)}</select></Field></div>
        <label className="check"><input type="checkbox" checked={s.first_purchase_only} onChange={(e) => setS({ ...s, first_purchase_only: e.target.checked })} />Valid only on the first purchase</label>
        {err && <Alert kind="error">{err}</Alert>}
      </Modal>}
      {modal === 'referral' && <Modal title="New referral program" subtitle="Creating a program activates it and deactivates the previous one." onClose={() => setModal(null)} footer={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveReferral} disabled={!r.name}>Create &amp; activate</button></>}>
        <div className="form-grid">
          <Field label="Program name" className="span-2"><input autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Refer a friend · Q4" /></Field>
          <Field label="Referrer reward" hint="Existing user who shared the code"><select value={r.referrer_offer_id} onChange={(e) => setR({ ...r, referrer_offer_id: e.target.value })}><option value="">No reward</option>{opts}</select></Field>
          <Field label="Referee reward" hint="New user who signed up"><select value={r.referee_offer_id} onChange={(e) => setR({ ...r, referee_offer_id: e.target.value })}><option value="">No reward</option>{opts}</select></Field>
          <Field label="Referrer reward trigger"><select value={r.referrer_reward_trigger} onChange={(e) => setR({ ...r, referrer_reward_trigger: e.target.value })}><option value="FIRST_PURCHASE">When referee makes first purchase</option><option value="SIGNUP">Immediately on referee signup</option></select></Field>
          <Field label="Coupon validity (days)"><input type="number" min="1" value={r.coupon_validity_days} onChange={(e) => setR({ ...r, coupon_validity_days: e.target.value })} /></Field>
          <Field label="Max referrals per user" hint="Blank = unlimited"><input type="number" min="1" value={r.max_referrals_per_user} onChange={(e) => setR({ ...r, max_referrals_per_user: e.target.value })} /></Field>
        </div>
        {err && <Alert kind="error">{err}</Alert>}
      </Modal>}
    </>
  );
}
