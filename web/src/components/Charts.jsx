import React, { useState } from 'react';
import { fmtDay } from '../api/client.js';

/** Single-series line chart with crosshair + tooltip. Series color: slot 1 blue. */
export function LineChart({ data, x = 'day', y = 'redemptions', label = 'Redemptions', height = 180, format = (v) => v }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = height, PL = 36, PR = 12, PT = 10, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;
  const vals = data.map((d) => Number(d[y]) || 0);
  const max = Math.max(1, ...vals);
  const xs = (i) => PL + (data.length > 1 ? (i / (data.length - 1)) * iw : iw / 2);
  const ys = (v) => PT + ih - (v / max) * ih;
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(Number(d[y]) || 0).toFixed(1)}`).join(' ');
  const area = data.length ? `${path} L${xs(data.length - 1).toFixed(1)},${PT + ih} L${xs(0).toFixed(1)},${PT + ih} Z` : '';
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    data.forEach((_, i) => { const d = Math.abs(xs(i) - px); if (d < bd) { bd = d; best = i; } });
    setHover({ i: best, left: (xs(best) / W) * 100, top: (ys(vals[best]) / H) * 100 });
  };
  const step = Math.max(1, Math.ceil(data.length / 7));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${label} over time`}>
        {ticks.map((t) => <g key={t}><line className="grid-line" x1={PL} x2={W - PR} y1={ys(t)} y2={ys(t)} /><text className="axis-text" x={PL - 6} y={ys(t) + 4} textAnchor="end">{format(t)}</text></g>)}
        {data.map((d, i) => (i % step === 0 || i === data.length - 1) && <text key={i} className="axis-text" x={xs(i)} y={H - 8} textAnchor="middle">{fmtDay(d[x])}</text>)}
        <path d={area} fill="var(--s1)" opacity=".08" />
        <path d={path} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover && <>
          <line x1={xs(hover.i)} x2={xs(hover.i)} y1={PT} y2={PT + ih} stroke="var(--muted)" strokeDasharray="3 3" />
          <circle cx={xs(hover.i)} cy={ys(vals[hover.i])} r="4.5" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" />
        </>}
      </svg>
      {hover && <div className="tooltip" style={{ left: `${hover.left}%`, top: `${hover.top}%`, transform: 'translate(-50%, -120%)' }}>
        <strong>{fmtDay(data[hover.i][x])}</strong> · {label}: {format(vals[hover.i])}</div>}
    </div>
  );
}

/** Horizontal bar list, one hue (magnitude), labels in text tokens. */
export function BarList({ items, label = 'label', value = 'value', format = (v) => v, color = 'var(--s1)' }) {
  const max = Math.max(1, ...items.map((i) => Number(i[value]) || 0));
  if (!items.length) return <div className="empty">No data yet.</div>;
  return (
    <div className="bar-list">
      {items.map((it, idx) => {
        const v = Number(it[value]) || 0;
        return (
          <div className="bar-row" key={idx} title={`${it[label]}: ${format(v)}`}>
            <span className="truncate" style={{ textTransform: 'capitalize' }}>{it[label]}{it.sub && <span className="cell-sub truncate" style={{ textTransform: 'none' }}>{it.sub}</span>}</span>
            <div className="track"><div className="fill" style={{ width: `${(v / max) * 100}%`, background: color }} /></div>
            <span className="num" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}
