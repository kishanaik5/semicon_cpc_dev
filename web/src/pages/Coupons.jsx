import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtINR, fmtDateShort } from '../api/client.js';
import { ACCOUNT_TYPES, accountLabel } from '../constants.js';
import { Badge, StatusBadge, TypeChip, Modal, Field, Segmented, Alert, useToast, Empty, Pager, usePage, CopyButton, TYPE_LABEL } from '../components/ui.jsx';
import { IcPlus, IcSearch, IcDownload, IcLock, IcUnlock, IcPower, IcEye, IcTicket } from '../components/Icons.jsx';

const toISO = (v) => (v ? new Date(v).toISOString() : null);
const dl = async (batchId) => {
  const res = await fetch(`/api/admin/coupons/batches/${batchId}/codes?format=csv`, { credentials: 'same-origin' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `batch-${batchId}.csv`; a.click();
};

export default function Coupons() {
  const toast = useToast();
  const [offers, setOffers] = useState([]);
  const [users, setUsers] = useState([]);
  const [list, setList] = useState(null);
  const [batches, setBatches] = useState([]);
  const [filter, setFilter] = useState({ type: '', status: '', q: '', batch_id: '' });
  const pg = usePage(1, 15);
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState(null);

  const load = async () => {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)), limit: pg.size, offset: pg.offset }).toString();
    const [l, b] = await Promise.all([api.admin.get(`/api/admin/coupons?${qs}`), api.admin.get('/api/admin/coupons/batches')]);
    setList(l); setBatches(b);
  };
  useEffect(() => { api.admin.get('/api/admin/offers').then(setOffers); api.get('/api/users').then(setUsers); }, []);
  useEffect(() => { load(); }, [filter, pg.page]);
  const setF = (patch) => { setFilter({ ...filter, ...patch }); pg.setPage(1); };

  const setStatus = async (c, status) => { await api.admin.patch(`/api/admin/coupons/${c.id}/status`, { status }); toast.success(`${c.code} ${status === 'DISABLED' ? 'disabled' : 'enabled'}`); load(); };
  const unlock = async (c) => { await api.admin.post(`/api/admin/coupons/${c.id}/unlock-pin`); toast.success(`PIN unlocked for ${c.code}`); load(); };
  const showDetail = async (c) => setDetail({ coupon: c, redemptions: await api.admin.get(`/api/admin/coupons/${c.id}/redemptions`) });

  const stats = list ? { total: list.total } : {};
  return (
    <>
      <div className="page-head"><div><h1>Coupons</h1><p>Create fixed codes, generate one-time unique batches, or issue PIN-protected personal coupons. Signup and referral coupons are issued automatically by their programs.</p></div>
        <button className="btn btn-primary" onClick={() => setCreate(true)}><IcPlus />New coupon</button></div>

      {batches.length > 0 && <div className="card mb"><div className="card-head"><div><h2>Unique code batches</h2><div className="sub">Each code in a batch can be redeemed exactly once</div></div></div>
        <table><thead><tr><th>Batch</th><th>Offer</th><th style={{ width: 220 }}>Redeemed</th><th>Valid until</th><th></th></tr></thead>
          <tbody>{batches.map((b) => <tr key={b.id} className="hover"><td><strong>{b.name}</strong><div className="cell-sub">{b.prefix ? `prefix ${b.prefix} · ` : ''}created {fmtDate(b.created_at)}</div></td><td>{b.offer_name}</td>
            <td><div className="row row-nowrap" style={{ gap: 8 }}><div className="progress" style={{ flex: 1 }}><i style={{ width: `${(b.redeemed / b.quantity) * 100}%` }} /></div><span className="small num" style={{ width: 70 }}>{b.redeemed} / {b.quantity}</span></div></td>
            <td className="small nowrap">{fmtDateShort(b.valid_until)}</td>
            <td><div className="actions"><button className="btn btn-sm" onClick={() => setF({ batch_id: b.id, type: '', q: '' })}><IcEye />Codes</button><button className="btn btn-sm" onClick={() => dl(b.id)}><IcDownload />CSV</button></div></td></tr>)}</tbody></table></div>}

      <div className="card">
        <div className="card-head" style={{ gap: 10, flexWrap: 'wrap' }}>
          <h2>All coupons {stats.total != null && <span className="muted" style={{ fontWeight: 500 }}>· {stats.total}</span>}</h2>
          <div className="row row-nowrap">
            <div className="input-group"><IcSearch /><input style={{ width: 220 }} placeholder="Search code" value={filter.q} onChange={(e) => setF({ q: e.target.value, batch_id: '' })} /></div>
            <select style={{ width: 170 }} value={filter.type} onChange={(e) => setF({ type: e.target.value, batch_id: '' })}><option value="">All types</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select style={{ width: 150 }} value={filter.status} onChange={(e) => setF({ status: e.target.value })}><option value="">All statuses</option>{['ACTIVE', 'DISABLED', 'EXHAUSTED', 'EXPIRED'].map((s) => <option key={s}>{s}</option>)}</select>
            {filter.batch_id && <button className="btn btn-sm" onClick={() => setF({ batch_id: '' })}>Clear batch filter</button>}
          </div>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Code</th><th className="nowrap">Type</th><th>Offer</th><th>Assigned to</th><th className="num">Usage</th><th>Validity</th><th>Status</th><th></th></tr></thead>
          <tbody>{list?.items.map((c) => {
            const locked = c.pin_locked_until && new Date(c.pin_locked_until) > new Date();
            return (<tr key={c.id} className="hover">
              <td><div className="row row-nowrap" style={{ gap: 6 }}><a href="#" onClick={(e) => { e.preventDefault(); showDetail(c); }} className="code-chip" style={{ color: 'var(--brand-text)' }}>{c.code}</a>{c.has_pin && <Badge dot={false} kind={locked ? 'critical' : ''}><IcLock width="10" height="10" />{locked ? 'Locked' : 'PIN'}</Badge>}</div>
                <div className="cell-sub">{[c.first_purchase_only && 'first purchase only', c.account_type && `${accountLabel(c.account_type).toLowerCase()} accounts only`, c.description].filter(Boolean).join(' · ')}</div></td>
              <td><TypeChip type={c.coupon_type} /></td>
              <td>{c.offer_name}<div className="cell-sub">{c.offer_summary}</div></td>
              <td>{c.assigned_user_email ? <span className="small">{c.assigned_user_email}</span> : <span className="muted small">Anyone</span>}</td>
              <td className="num nowrap"><strong>{c.usage_count}</strong><span className="muted">{c.global_usage_limit != null ? ` / ${c.global_usage_limit}` : ''}</span><div className="cell-sub">{c.per_user_limit != null ? `${c.per_user_limit} per user` : 'unlimited per user'}</div></td>
              <td className="small nowrap">{fmtDateShort(c.valid_from)}<div className="cell-sub">to {c.valid_until ? fmtDateShort(c.valid_until) : 'no expiry'}</div></td>
              <td><StatusBadge status={c.status} /></td>
              <td><div className="actions">
                {locked && <button className="btn btn-sm" onClick={() => unlock(c)} title="Unlock PIN"><IcUnlock />Unlock</button>}
                {c.status === 'ACTIVE' && <button className="btn btn-sm btn-danger" onClick={() => setStatus(c, 'DISABLED')}><IcPower />Disable</button>}
                {c.status === 'DISABLED' && <button className="btn btn-sm" onClick={() => setStatus(c, 'ACTIVE')}><IcPower />Enable</button>}
              </div></td></tr>);
          })}</tbody></table></div>
        {list && list.items.length === 0 && <Empty icon={IcTicket}>No coupons match these filters.</Empty>}
        {list && <Pager {...pg} total={list.total} />}
      </div>

      {create && <CreateCoupon offers={offers} users={users} onClose={() => setCreate(false)} onCreated={() => { load(); }} />}

      {detail && <Modal title={<span className="row">Redemptions · <span className="code-chip">{detail.coupon.code}</span></span>} subtitle={`${detail.coupon.offer_name} · ${detail.coupon.offer_summary}`} onClose={() => setDetail(null)}>
        {detail.redemptions.length === 0 ? <Empty>Not redeemed yet.</Empty> : <table><thead><tr><th>When</th><th>User</th><th>Order</th><th className="num">Amount</th><th className="num">Discount</th></tr></thead>
          <tbody>{detail.redemptions.map((r) => <tr key={r.id}><td className="small">{fmtDate(r.redeemed_at)}</td><td>{r.email}</td><td><span className="code-chip">{r.order_ref}</span></td><td className="num">{fmtINR(r.order_amount)}</td><td className="num" style={{ color: 'var(--good-text)' }}>−{fmtINR(r.discount_amount)}</td></tr>)}</tbody></table>}
      </Modal>}
    </>
  );
}

function CreateCoupon({ offers, users, onClose, onCreated }) {
  const toast = useToast();
  const [tab, setTab] = useState('FIXED');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [fixed, setFixed] = useState({ code: '', offer_id: '', description: '', valid_from: '', valid_until: '', global_usage_limit: '', per_user_limit: 1, account_type: '', first_purchase_only: false });
  const [batch, setBatch] = useState({ name: '', offer_id: '', quantity: 50, prefix: '', valid_until: '', account_type: '' });
  const [upin, setUpin] = useState({ user_id: '', offer_id: '', description: '', valid_until: '', pin: '', first_purchase_only: false });
  const active = offers.filter((o) => o.is_active);
  const OfferSel = ({ value, onChange }) => <Field label="Offer"><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Select an offer…</option>{active.map((o) => <option key={o.id} value={o.id}>{o.name} — {o.summary}</option>)}</select></Field>;
  const AcctSel = ({ value, onChange }) => <Field label="Account type"><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Any account</option>{ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.plural} only</option>)}</select></Field>;

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      if (tab === 'FIXED') {
        const r = await api.admin.post('/api/admin/coupons/fixed', { ...fixed, valid_from: toISO(fixed.valid_from), valid_until: toISO(fixed.valid_until), global_usage_limit: fixed.global_usage_limit === '' ? null : fixed.global_usage_limit, per_user_limit: fixed.per_user_limit === '' ? null : fixed.per_user_limit, account_type: fixed.account_type || null });
        toast.success(`Coupon ${r.code} created`); onCreated(); onClose();
      } else if (tab === 'UNIQUE') {
        const r = await api.admin.post('/api/admin/coupons/unique-batch', { ...batch, valid_until: toISO(batch.valid_until), account_type: batch.account_type || null, prefix: batch.prefix || null });
        setResult({ codes: r.codes, batchId: r.batch.id, name: r.batch.name }); onCreated();
      } else {
        const r = await api.admin.post('/api/admin/coupons/user-pin', { ...upin, valid_until: toISO(upin.valid_until), pin: upin.pin || undefined });
        setResult({ pin: r.pin, code: r.code, user: r.user }); onCreated();
      }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const valid = tab === 'FIXED' ? fixed.code.length >= 3 && fixed.offer_id : tab === 'UNIQUE' ? batch.name && batch.offer_id && batch.quantity > 0 : upin.user_id && upin.offer_id;

  if (result) return (
    <Modal title={result.pin ? 'Personal coupon issued' : `Batch "${result.name}" generated`} onClose={onClose} size={result.pin ? 'sm' : ''} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      {result.pin ? <>
        <Alert kind="warn" title="Share the PIN now">It is stored as a hash and cannot be shown again. The coupon is bound to {result.user.email}.</Alert>
        <div className="row" style={{ justifyContent: 'space-between' }}><div><div className="small muted">Coupon code</div><span className="code-chip" style={{ fontSize: 15 }}>{result.code}</span></div><CopyButton text={result.code} /></div>
        <div><div className="small muted" style={{ marginBottom: 6 }}>PIN</div><div className="row"><span className="pin-box">{result.pin}</span><CopyButton text={result.pin} /></div></div>
      </> : <>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="text-2">{result.codes.length} unique one-time codes created.</span><div className="row"><CopyButton text={result.codes.join('\n')} label="Copy all" /><button className="btn btn-sm" onClick={() => dl(result.batchId)}><IcDownload />Download CSV</button></div></div>
        <div className="codes-box">{result.codes.map((c) => <div key={c}>{c}</div>)}</div>
      </>}
    </Modal>
  );

  return (
    <Modal title="New coupon" subtitle="Choose a coupon type, then link it to an offer." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit} disabled={!valid || busy}>{busy ? 'Creating…' : tab === 'UNIQUE' ? 'Generate codes' : 'Create coupon'}</button></>}>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'FIXED', label: 'Fixed code' }, { value: 'UNIQUE', label: 'One-time unique batch' }, { value: 'USER_PIN', label: 'User-specific + PIN' }]} />
      {tab === 'FIXED' && <div className="form-grid">
        <Field label="Code" hint="Letters and numbers, shared publicly"><input value={fixed.code} placeholder="DIWALI25" style={{ fontFamily: 'var(--mono)', textTransform: 'uppercase' }} onChange={(e) => setFixed({ ...fixed, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} /></Field>
        <OfferSel value={fixed.offer_id} onChange={(v) => setFixed({ ...fixed, offer_id: v })} />
        <Field label="Valid from" hint="Blank = now"><input type="datetime-local" value={fixed.valid_from} onChange={(e) => setFixed({ ...fixed, valid_from: e.target.value })} /></Field>
        <Field label="Valid until" hint="Blank = no expiry"><input type="datetime-local" value={fixed.valid_until} onChange={(e) => setFixed({ ...fixed, valid_until: e.target.value })} /></Field>
        <Field label="Global usage limit" hint="Blank = unlimited"><input type="number" min="1" value={fixed.global_usage_limit} onChange={(e) => setFixed({ ...fixed, global_usage_limit: e.target.value })} /></Field>
        <Field label="Uses per user" hint="Blank = unlimited"><input type="number" min="1" value={fixed.per_user_limit} onChange={(e) => setFixed({ ...fixed, per_user_limit: e.target.value })} /></Field>
        <AcctSel value={fixed.account_type} onChange={(v) => setFixed({ ...fixed, account_type: v })} />
        <Field label="Description"><input value={fixed.description} onChange={(e) => setFixed({ ...fixed, description: e.target.value })} placeholder="Internal note" /></Field>
        <label className="check span-2"><input type="checkbox" checked={fixed.first_purchase_only} onChange={(e) => setFixed({ ...fixed, first_purchase_only: e.target.checked })} />Restrict to the customer's first purchase</label>
      </div>}
      {tab === 'UNIQUE' && <div className="form-grid">
        <Field label="Batch name"><input value={batch.name} placeholder="IIT Campus Drive" onChange={(e) => setBatch({ ...batch, name: e.target.value })} /></Field>
        <OfferSel value={batch.offer_id} onChange={(v) => setBatch({ ...batch, offer_id: v })} />
        <Field label="Quantity" hint="1 – 10,000 codes"><input type="number" min="1" max="10000" value={batch.quantity} onChange={(e) => setBatch({ ...batch, quantity: e.target.value })} /></Field>
        <Field label="Code prefix" hint="Optional, up to 8 characters"><input value={batch.prefix} maxLength={8} placeholder="CAMPUS" style={{ fontFamily: 'var(--mono)' }} onChange={(e) => setBatch({ ...batch, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></Field>
        <Field label="Valid until" hint="Blank = no expiry"><input type="datetime-local" value={batch.valid_until} onChange={(e) => setBatch({ ...batch, valid_until: e.target.value })} /></Field>
        <AcctSel value={batch.account_type} onChange={(v) => setBatch({ ...batch, account_type: v })} />
      </div>}
      {tab === 'USER_PIN' && <div className="form-grid">
        <Field label="Customer"><select value={upin.user_id} onChange={(e) => setUpin({ ...upin, user_id: e.target.value })}><option value="">Select a customer…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}</select></Field>
        <OfferSel value={upin.offer_id} onChange={(v) => setUpin({ ...upin, offer_id: v })} />
        <Field label="PIN" hint="4–8 digits · blank to auto-generate"><input value={upin.pin} inputMode="numeric" maxLength={8} style={{ fontFamily: 'var(--mono)' }} onChange={(e) => setUpin({ ...upin, pin: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Valid until" hint="Blank = no expiry"><input type="datetime-local" value={upin.valid_until} onChange={(e) => setUpin({ ...upin, valid_until: e.target.value })} /></Field>
        <Field label="Description" className="span-2"><input value={upin.description} onChange={(e) => setUpin({ ...upin, description: e.target.value })} placeholder="e.g. Enterprise onboarding offer" /></Field>
        <label className="check span-2"><input type="checkbox" checked={upin.first_purchase_only} onChange={(e) => setUpin({ ...upin, first_purchase_only: e.target.checked })} />Restrict to the customer's first purchase</label>
      </div>}
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}
