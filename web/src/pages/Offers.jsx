import React, { useEffect, useState } from 'react';
import { api, fmtINR } from '../api/client.js';
import { Badge, Modal, Field, Alert, useToast, Empty, BENEFIT_LABEL } from '../components/ui.jsx';
import { IcPlus, IcPercent, IcRupee, IcClock, IcSparkle, IcGift, IcTag, IcPower } from '../components/Icons.jsx';

const ICON = { PERCENT_DISCOUNT: IcPercent, FIXED_DISCOUNT: IcRupee, EXTRA_HOURS: IcClock, AI_CREDITS: IcSparkle, CUSTOM: IcGift };
const COLOR = { PERCENT_DISCOUNT: 'var(--s1)', FIXED_DISCOUNT: 'var(--s3)', EXTRA_HOURS: 'var(--s4)', AI_CREDITS: 'var(--s7)', CUSTOM: 'var(--s2)' };
const empty = { name: '', description: '', benefit_type: 'PERCENT_DISCOUNT', value: 10, max_discount: '', min_order_amount: 0, config: '{\n  "label": "Free mentor session"\n}' };

export default function Offers() {
  const toast = useToast();
  const [offers, setOffers] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState('');
  const load = () => api.admin.get('/api/admin/offers').then(setOffers);
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr('');
    try {
      let config = {};
      if (form.benefit_type === 'CUSTOM') { try { config = JSON.parse(form.config || '{}'); } catch { throw new Error('Config must be valid JSON'); } }
      await api.admin.post('/api/admin/offers', { ...form, max_discount: form.max_discount === '' ? null : form.max_discount, config });
      toast.success(`Offer "${form.name}" created`); setOpen(false); setForm(empty); load();
    } catch (e) { setErr(e.message); }
  };
  const toggle = async (o) => { await api.admin.put(`/api/admin/offers/${o.id}`, { is_active: !o.is_active }); toast.success(`${o.name} ${o.is_active ? 'deactivated' : 'activated'}`); load(); };
  const unit = { PERCENT_DISCOUNT: 'Percent off', FIXED_DISCOUNT: 'Amount off (₹)', EXTRA_HOURS: 'Lab hours', AI_CREDITS: 'Credits', CUSTOM: 'Value (unused)' }[form.benefit_type];

  return (
    <>
      <div className="page-head"><div><h1>Offers</h1><p>An offer defines the benefit a coupon grants. Link any number of coupons to one offer so the reward is managed in one place.</p></div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}><IcPlus />New offer</button></div>
      {offers && offers.length === 0 && <div className="card"><Empty icon={IcTag}>No offers yet. Create one to start issuing coupons.</Empty></div>}
      <div className="grid cols-3">
        {offers?.map((o) => { const Icon = ICON[o.benefit_type]; return (
          <div key={o.id} className="card tile" style={{ gap: 12, opacity: o.is_active ? 1 : .7 }}>
            <div className="tile-top"><span className="icon" style={{ background: `color-mix(in srgb, ${COLOR[o.benefit_type]} 14%, transparent)`, color: COLOR[o.benefit_type] }}><Icon /></span><Badge kind={o.is_active ? 'good' : ''}>{o.is_active ? 'Active' : 'Inactive'}</Badge></div>
            <div><div style={{ fontWeight: 600, fontSize: 15 }}>{o.name}</div><div className="small muted">{BENEFIT_LABEL[o.benefit_type]}</div></div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{o.summary}</div>
            {o.description && <div className="small text-2">{o.description}</div>}
            <div className="divider" />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">{Number(o.min_order_amount) ? `Min order ${fmtINR(o.min_order_amount)}` : 'No minimum'} · <b style={{ color: 'var(--text-2)' }}>{o.coupon_count}</b> coupon{o.coupon_count === 1 ? '' : 's'}</span>
              <button className={`btn btn-sm ${o.is_active ? 'btn-ghost' : ''}`} onClick={() => toggle(o)}><IcPower />{o.is_active ? 'Deactivate' : 'Activate'}</button>
            </div>
          </div>); })}
      </div>

      {open && <Modal title="New offer" subtitle="Define the benefit. You can attach coupons to it afterwards." onClose={() => setOpen(false)}
        footer={<><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={!form.name}>Create offer</button></>}>
        <div className="form-grid">
          <Field label="Offer name" className="span-2"><input autoFocus value={form.name} placeholder="e.g. 20% launch discount" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Benefit type"><select value={form.benefit_type} onChange={(e) => setForm({ ...form, benefit_type: e.target.value })}>{Object.entries(BENEFIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label={unit}><input type="number" min="0" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} disabled={form.benefit_type === 'CUSTOM'} /></Field>
          {form.benefit_type === 'PERCENT_DISCOUNT' && <Field label="Maximum discount (₹)" hint="Caps the discount · blank = no cap"><input type="number" min="0" value={form.max_discount} onChange={(e) => setForm({ ...form, max_discount: e.target.value })} /></Field>}
          <Field label="Minimum order amount (₹)"><input type="number" min="0" value={form.min_order_amount} onChange={(e) => setForm({ ...form, min_order_amount: e.target.value })} /></Field>
          <Field label="Description" className="span-2"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Shown to admins" /></Field>
          {form.benefit_type === 'CUSTOM' && <Field label="Benefit config (JSON)" className="span-2" hint="Returned to the storefront as the benefit payload"><textarea rows={4} style={{ fontFamily: 'var(--mono)' }} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} /></Field>}
        </div>
        {err && <Alert kind="error">{err}</Alert>}
      </Modal>}
    </>
  );
}
