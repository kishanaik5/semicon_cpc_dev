import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api/client.js';
import { accountLabel } from '../constants.js';
import { Badge, StatusBadge, TypeChip, Avatar, Empty, CopyButton } from '../components/ui.jsx';
import { IcSearch, IcUser, IcLock } from '../components/Icons.jsx';

export default function Users() {
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [wallet, setWallet] = useState([]);
  const [orders, setOrders] = useState([]);
  useEffect(() => { api.get('/api/users').then(setUsers); }, []);
  const open = async (u) => { setSel(u); const [w, o] = await Promise.all([api.get(`/api/users/${u.id}/coupons`), api.get(`/api/users/${u.id}/orders`)]); setWallet(w); setOrders(o); };
  const shown = users.filter((u) => !q || `${u.name} ${u.email} ${u.referral_code}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="page-head"><div><h1>Users</h1><p>Customer accounts, referral codes and personal coupon wallets.</p></div></div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><h2>{shown.length} account{shown.length === 1 ? '' : 's'}</h2><div className="input-group"><IcSearch /><input style={{ width: 240 }} placeholder="Search name, email, code" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
          <div className="table-wrap"><table><thead><tr><th>User</th><th>Referral code</th><th className="num">Orders</th><th className="num">Coupons</th></tr></thead>
            <tbody>{shown.map((u) => <tr key={u.id} className={`hover clickable`} style={{ background: sel?.id === u.id ? 'var(--brand-soft)' : undefined }} onClick={() => open(u)}>
              <td><div className="row row-nowrap"><Avatar name={u.name} /><div style={{ minWidth: 0 }}><div className="row row-nowrap" style={{ gap: 6 }}><span style={{ fontWeight: 500 }}>{u.name}</span><Badge outline dot={false}>{accountLabel(u.account_type)}</Badge></div><div className="cell-sub truncate">{u.email}{u.referred_by_email && ` · referred by ${u.referred_by_email}`}</div></div></div></td>
              <td><span className="code-chip">{u.referral_code}</span></td><td className="num">{u.purchases_count}</td><td className="num">{u.active_coupons}</td></tr>)}</tbody></table></div>
        </div>
        <div className="card sticky">
          {!sel ? <Empty icon={IcUser}>Select a user to inspect their wallet and orders.</Empty> : <>
            <div className="card-head"><div className="row row-nowrap"><Avatar name={sel.name} size="lg" /><div><div style={{ fontWeight: 600, fontSize: 15 }}>{sel.name}</div><div className="small muted">{sel.email} · joined {fmtDate(sel.created_at)}</div></div></div></div>
            <div className="card-body stack">
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="small muted">Referral code</span><span className="row"><span className="code-chip">{sel.referral_code}</span><CopyButton text={sel.referral_code} /></span></div>
              <div><h3 style={{ marginBottom: 8 }}>Coupon wallet</h3>
                {wallet.length === 0 ? <div className="muted small">No personal coupons.</div> : <div className="stack stack-sm">{wallet.map((w) => <div key={w.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div><div className="row row-nowrap" style={{ gap: 6 }}><span className="code-chip">{w.code}</span>{w.requires_pin && <Badge dot={false}><IcLock width="10" height="10" />PIN</Badge>}</div><div className="cell-sub"><TypeChip type={w.coupon_type} /> · {w.offer_summary} · exp {fmtDate(w.valid_until)}</div></div><StatusBadge status={w.status} /></div>)}</div>}</div>
              <div><h3 style={{ marginBottom: 8 }}>Orders</h3>
                {orders.length === 0 ? <div className="muted small">No orders yet.</div> : <table><tbody>{orders.slice(0, 6).map((o) => <tr key={o.id}><td style={{ padding: '8px 0' }}><span className="code-chip">{o.order_ref}</span><div className="cell-sub">{fmtDate(o.created_at)}</div></td><td>{o.coupon_code ? <Badge kind="good" dot={false}>{o.coupon_code}</Badge> : <span className="muted small">—</span>}</td><td className="num">₹{Number(o.total).toLocaleString('en-IN')}</td></tr>)}</tbody></table>}</div>
            </div></>}
        </div>
      </div>
    </>
  );
}
