import React, { useEffect, useState } from 'react';
import { api, fmtINR } from '../api/client.js';
import { Tile, Alert, Segmented, TypeChip, Skeleton, Empty, Avatar, Badge, useToast } from '../components/ui.jsx';
import { LineChart, BarList } from '../components/Charts.jsx';
import AiAssistant from '../components/AiAssistant.jsx';
import { IcTicket, IcTrend, IcZap, IcRupee, IcUsers, IcLink, IcGift, IcShield, IcSparkle, IcRefresh } from '../components/Icons.jsx';

export default function Dashboard() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [refs, setRefs] = useState([]);
  const [err, setErr] = useState(null);
  const [simulating, setSimulating] = useState(false);

  const loadData = () => {
    setData(null);
    Promise.all([
      api.admin.get(`/api/admin/analytics/overview?days=${days}`),
      api.admin.get(`/api/admin/analytics/insights?days=${days}`),
      api.admin.get('/api/admin/analytics/top-referrers'),
    ])
      .then(([d, ins, r]) => {
        setData(d);
        setInsights(ins);
        setRefs(r);
      })
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    loadData();
  }, [days]);

  const simulateTraffic = async () => {
    setSimulating(true);
    try {
      const res = await api.admin.post('/api/admin/analytics/simulate', {});
      toast.success(res.message || 'Simulated traffic generated!');
      loadData();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSimulating(false);
    }
  };

  if (err) return <Alert kind="error">{err}</Alert>;

  const head = (
    <div className="page-head">
      <div>
        <h1>Analytics</h1>
        <p>Redemption performance, coupon health, financial ROI and AI-driven growth recommendations.</p>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn-sm" onClick={simulateTraffic} disabled={simulating} title="Generate realistic demo transactions & attempts">
          <IcZap />{simulating ? 'Simulating…' : 'Simulate Activity'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={loadData} title="Refresh data">
          <IcRefresh />
        </button>
        <Segmented
          value={days}
          onChange={setDays}
          options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]}
        />
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {head}
        <div className="card mb" style={{ padding: 24 }}><Skeleton w={200} h={24} /><Skeleton w={350} h={14} style={{ marginTop: 8 }} /></div>
        <div className="grid cols-4">{[1, 2, 3, 4].map((i) => <div key={i} className="card tile"><Skeleton w={110} /><Skeleton w={90} h={28} /><Skeleton w={140} h={10} /></div>)}</div>
      </>
    );
  }

  const t = data.totals, r = data.referral;

  return (
    <>
      {head}

      <AiAssistant days={days} />

      {/* AI Growth & Anomaly Insights Card */}
      {insights && (
        <div className="card mb" style={{ border: '1px solid color-mix(in srgb, var(--brand) 32%, var(--border))', background: 'color-mix(in srgb, var(--brand) 3%, var(--surface))' }}>
          <div className="card-head" style={{ borderBottom: '1px solid color-mix(in srgb, var(--brand) 15%, var(--border))' }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="icon" style={{ background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: 'var(--brand)', width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <IcSparkle width="16" height="16" />
              </span>
              <div>
                <h2 style={{ fontSize: 16 }}>AI Growth &amp; Anomaly Insights</h2>
                <div className="sub">Real-time business telemetry synthesis, coupon fraud tracking, and automated growth prescriptions.</div>
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Badge kind={insights.summary.healthScore === 'Excellent' ? 'good' : insights.summary.healthScore === 'Good' ? 'info' : 'critical'}>
                Health: {insights.summary.healthScore}
              </Badge>
            </div>
          </div>
          <div className="card-body stack" style={{ gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text)' }}>
              {insights.summary.headline}
            </div>

            {insights.anomalies.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                {insights.anomalies.map((a, i) => (
                  <Alert key={i} kind={a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'} title={a.title}>
                    {a.description}
                  </Alert>
                ))}
              </div>
            )}

            <div className="grid cols-3" style={{ gap: 12 }}>
              {insights.insights.map((item, idx) => (
                <div key={idx} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div className="small muted">{item.metric}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{item.value}</div>
                  <div className="tiny muted" style={{ marginTop: 2 }}>{item.detail}</div>
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="small" style={{ fontWeight: 600, color: 'var(--text-2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Recommended Actions
              </div>
              <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {insights.recommendations.map((rec, i) => (
                  <li key={i} style={{ color: 'var(--text)' }}>{rec}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Primary KPI Grid */}
      <div className="grid cols-4">
        <Tile label="Coupons issued" value={t.coupons_total.toLocaleString()} sub={<><b>{t.coupons_active}</b> currently active</>} icon={IcTicket} />
        <Tile label="Redemption rate" value={`${t.redemption_rate}%`} sub="coupons redeemed at least once" icon={IcTrend} color="var(--s3)" />
        <Tile label={`Redemptions · ${days}d`} value={t.redemptions_period.toLocaleString()} sub={<><b>{t.redemptions_total}</b> all-time</>} icon={IcZap} color="var(--s2)" />
        <Tile label="Discount given" value={fmtINR(t.discount_total)} sub={<><b>{t.coupon_order_share}%</b> of {t.orders_total} orders used a coupon</>} icon={IcRupee} color="var(--s7)" />
      </div>

      {/* Financial & Security Grid */}
      <div className="grid cols-4 mt">
        <Tile
          label="Coupon Gross Sales"
          value={fmtINR(t.revenue_with_coupon || 0)}
          sub={<>ROI: <b>{t.discount_roi || 0}x</b> sales return per discount rupee</>}
          icon={IcRupee}
          color="var(--s1)"
        />
        <Tile
          label="Apply Success Rate"
          value={`${t.apply_success_rate ?? 0}%`}
          sub="validation attempts completed into orders"
          icon={IcTrend}
          color="var(--s2)"
        />
        <Tile
          label="Average Order Value"
          value={fmtINR(t.aov_with_coupon || 0)}
          sub={<>vs <b>{fmtINR(t.aov_without_coupon || 0)}</b> without coupon</>}
          icon={IcZap}
          color="var(--s4)"
        />
        <Tile
          label="Abuse & Security Signals"
          value={`${(t.security?.pin_lockout_events || 0) + (t.security?.rate_limited_events || 0)}`}
          sub={<><b>{t.security?.flagged_ips || 0}</b> flagged IPs · <b>{t.security?.active_pin_lockouts || 0}</b> locked PINs</>}
          icon={IcShield}
          color={(t.security?.flagged_ips || 0) > 0 ? "var(--s5)" : "var(--s3)"}
        />
      </div>

      <div className="grid cols-2 mt">
        <div className="card"><div className="card-head"><div><h2>Daily redemptions</h2><div className="sub">Coupon redemptions per day</div></div></div><div className="card-body"><LineChart data={data.daily} y="redemptions" label="Redemptions" /></div></div>
        <div className="card"><div className="card-head"><div><h2>Discount value</h2><div className="sub">Total discount granted per day</div></div></div><div className="card-body"><LineChart data={data.daily} y="discount" label="Discount" format={(v) => fmtINR(v)} /></div></div>
      </div>

      <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)' }}>
        <div className="card"><div className="card-head"><div><h2>Performance by coupon type</h2><div className="sub">Issued vs redeemed</div></div></div>
          <div className="table-wrap"><table><thead><tr><th>Type</th><th className="num nowrap">Issued · Redeemed</th><th style={{ width: 130 }}>Rate</th><th className="num nowrap">Expired · Exhausted</th></tr></thead>
            <tbody>{data.byType.map((b) => <tr key={b.coupon_type} className="hover"><td><TypeChip type={b.coupon_type} /></td><td className="num nowrap"><strong>{b.issued}</strong> <span className="muted">· {b.redemptions}</span></td>
              <td><div className="row row-nowrap" style={{ gap: 8 }}><div className="progress" style={{ flex: 1 }}><i style={{ width: `${b.redemption_rate}%` }} /></div><span className="small num" style={{ width: 44 }}>{b.redemption_rate}%</span></div></td>
              <td className="num nowrap">{b.expired} <span className="muted">· {b.exhausted}</span></td></tr>)}</tbody></table></div></div>
        <div className="card"><div className="card-head"><div><h2>Top coupons</h2><div className="sub">By number of redemptions</div></div></div>
          <div className="card-body"><BarList items={data.topCoupons.map((c) => ({ label: c.code, value: c.usage_count, sub: c.offer_name }))} /></div></div>
      </div>

      <div className="row mt-lg mb" style={{ gap: 10 }}><IcLink /><h2 style={{ fontSize: 17 }}>Referral effectiveness</h2></div>
      <div className="grid cols-4">
        <Tile label="Referrals" value={r.referrals} sub={<><b>{r.active_referrers}</b> active referrers</>} icon={IcLink} color="var(--s2)" />
        <Tile label="Conversion rate" value={`${r.conversion_rate}%`} sub={<><b>{r.converted}</b> referred users purchased</>} icon={IcTrend} color="var(--s3)" />
        <Tile label="Referral coupons" value={`${r.referral_coupons_redeemed} / ${r.referral_coupons_issued}`} sub="redeemed / issued" icon={IcGift} />
        <Tile label="Users via referral" value={r.referred_users} sub={<>of <b>{r.all_users}</b> total users</>} icon={IcUsers} color="var(--s7)" />
      </div>
      <div className="grid cols-2 mt">
        <div className="card"><div className="card-head"><h2>Top referrers</h2></div>
          {refs.length === 0 ? <Empty>No referrals yet.</Empty> : <table><thead><tr><th>User</th><th className="num">Referrals</th><th className="num">Converted</th></tr></thead>
            <tbody>{refs.map((u) => <tr key={u.id} className="hover"><td><div className="row row-nowrap"><Avatar name={u.name} /><div><div style={{ fontWeight: 500 }}>{u.name}</div><div className="cell-sub">{u.email}</div></div></div></td><td className="num">{u.referrals}</td><td className="num">{u.converted}</td></tr>)}</tbody></table>}</div>
        <div className="card"><div className="card-head"><div><h2>Validation outcomes · {days}d</h2><div className="sub">{t.failed_attempts_period} failed attempts. A spike in INVALID_CODE suggests code guessing.</div></div><IcShield style={{ color: 'var(--muted)' }} /></div>
          <div className="card-body"><BarList items={data.outcomes.map((o) => ({ label: o.outcome.replace(/_/g, ' ').toLowerCase(), value: o.n }))} color="var(--s2)" /></div></div>
      </div>
    </>
  );
}

