import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api/client.js';
import { Badge, Segmented, Empty } from '../components/ui.jsx';
import { IcSearch, IcLog } from '../components/Icons.jsx';

const KIND = { REDEEMED: 'good', CREATED: 'info', REGISTERED: 'info', CONVERTED: 'good', ENABLED: 'good', PIN_UNLOCKED: 'good', EXPIRED: 'serious', EXHAUSTED: 'warn', DISABLED: '', PIN_LOCKED: 'critical', UPDATED: '', SEEDED: '' };

export default function Audit() {
  const [tab, setTab] = useState('audit');
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState({ entity_type: '', action: '', q: '' });
  useEffect(() => {
    setRows(null);
    if (tab === 'attempts') api.admin.get('/api/admin/audit/attempts').then(setRows);
    else api.admin.get(`/api/admin/audit?limit=200&${new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v)))}`).then(setRows);
  }, [tab, filter]);
  const pretty = (d) => Object.entries(d || {}).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => <span key={k} style={{ marginRight: 10 }}><span className="muted">{k}</span> {String(v)}</span>);
  return (
    <>
      <div className="page-head"><div><h1>Audit log</h1><p>Immutable record of coupon creation, redemption, expiry, status changes and security events.</p></div>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'audit', label: 'Events' }, { value: 'attempts', label: 'Validation attempts' }]} /></div>
      <div className="card">
        {tab === 'audit' && <div className="card-head" style={{ flexWrap: 'wrap' }}><h2>Events</h2><div className="row row-nowrap">
          <select style={{ width: 170 }} value={filter.entity_type} onChange={(e) => setFilter({ ...filter, entity_type: e.target.value })}><option value="">All entities</option>{['coupon', 'coupon_batch', 'offer', 'order', 'user', 'referral', 'referral_program', 'signup_config'].map((x) => <option key={x}>{x}</option>)}</select>
          <select style={{ width: 170 }} value={filter.action} onChange={(e) => setFilter({ ...filter, action: e.target.value })}><option value="">All actions</option>{Object.keys(KIND).map((x) => <option key={x}>{x}</option>)}</select>
          <div className="input-group"><IcSearch /><input style={{ width: 220 }} placeholder="Search details" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} /></div></div></div>}
        {tab === 'attempts' && <div className="card-head"><div><h2>Validation attempts</h2><div className="sub">Every coupon lookup with its outcome and source IP. Feeds brute-force protection.</div></div></div>}
        <div className="table-wrap">
          {tab === 'audit' ? <table><thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Actor</th><th>Details</th></tr></thead>
            <tbody>{rows?.map((r) => <tr key={r.id} className="hover"><td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td><td><Badge kind={KIND[r.action] ?? ''}>{r.action}</Badge></td><td className="small">{r.entity_type} <span className="muted">#{r.entity_id}</span></td><td className="small">{r.actor}</td><td className="small" style={{ maxWidth: 560 }}>{pretty(r.details)}</td></tr>)}</tbody></table>
          : <table><thead><tr><th>Time</th><th>Code attempted</th><th>User</th><th>IP</th><th>Outcome</th></tr></thead>
            <tbody>{rows?.map((r) => <tr key={r.id} className="hover"><td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td><td><span className="code-chip">{r.code_attempted}</span></td><td className="small">{r.email || r.user_id || '—'}</td><td className="small mono">{r.ip}</td><td><Badge kind={r.outcome === 'SUCCESS' ? 'good' : r.outcome === 'RATE_LIMITED' || r.outcome === 'PIN_LOCKED' ? 'critical' : 'serious'}>{r.outcome}</Badge></td></tr>)}</tbody></table>}
        </div>
        {rows && rows.length === 0 && <Empty icon={IcLog}>Nothing recorded yet.</Empty>}
      </div>
    </>
  );
}
