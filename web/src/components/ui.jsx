import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { IcCheckCircle, IcAlert, IcInfo, IcX, IcInbox, IcCopy, IcCheck } from './Icons.jsx';

/* ---------- Badges ---------- */
const STATUS_KIND = { ACTIVE: 'good', DISABLED: '', EXPIRED: 'serious', EXHAUSTED: 'warn', CONVERTED: 'good', PENDING: 'warn', SUCCESS: 'good', Active: 'good', Inactive: '' };
export function Badge({ children, kind, dot = true, outline }) {
  const k = kind ?? STATUS_KIND[children] ?? '';
  return <span className={`badge ${k} ${outline ? 'outline' : ''}`}>{dot && k && <i />}{children}</span>;
}
export const StatusBadge = ({ status }) => <Badge kind={STATUS_KIND[status] ?? 'critical'}>{status}</Badge>;

export const TYPE_LABEL = { FIXED: 'Fixed code', UNIQUE: 'One-time unique', USER_PIN: 'User + PIN', SIGNUP: 'First signup', REFERRAL: 'Referral' };
export const TYPE_COLOR = { FIXED: 'var(--s1)', UNIQUE: 'var(--s3)', USER_PIN: 'var(--s7)', SIGNUP: 'var(--s4)', REFERRAL: 'var(--s2)' };
export const TypeChip = ({ type }) => <span className="type-chip"><i style={{ background: TYPE_COLOR[type] }} />{TYPE_LABEL[type] || type}</span>;
export const BENEFIT_LABEL = { PERCENT_DISCOUNT: 'Percentage discount', FIXED_DISCOUNT: 'Fixed amount off', EXTRA_HOURS: 'Extra lab hours', AI_CREDITS: 'AI credits', CUSTOM: 'Custom benefit' };

/* ---------- Alerts ---------- */
export function Alert({ kind = 'info', children, title }) {
  const Icon = { success: IcCheckCircle, error: IcAlert, warn: IcAlert, info: IcInfo }[kind];
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon /><div>{title && <strong style={{ display: 'block' }}>{title}</strong>}{children}</div></div>;
}

/* ---------- KPI tile ---------- */
export function Tile({ label, value, sub, icon: Icon, color }) {
  return (
    <div className="card tile">
      <div className="tile-top"><span className="label">{label}</span>{Icon && <span className="icon" style={color ? { background: `color-mix(in srgb, ${color} 14%, transparent)`, color } : undefined}><Icon /></span>}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, subtitle, onClose, children, footer, size }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><div><h2>{title}</h2>{subtitle && <div className="small muted" style={{ marginTop: 2 }}>{subtitle}</div>}</div><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><IcX /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- Toasts ---------- */
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((kind, text) => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l, { id, kind, text }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  const api = { success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t) };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.kind === 'success' ? <IcCheckCircle /> : t.kind === 'error' ? <IcAlert /> : <IcInfo />}<span>{t.text}</span></div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------- Misc ---------- */
export const Empty = ({ children, icon: Icon = IcInbox }) => <div className="empty"><Icon />{children}</div>;
export const Skeleton = ({ w = '100%', h = 14, style }) => <div className="skeleton" style={{ width: w, height: h, ...style }} />;
export function Segmented({ options, value, onChange }) {
  return <div className="segmented">{options.map((o) => <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function CopyButton({ text, label }) {
  const [ok, setOk] = useState(false);
  return <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? <IcCheck /> : <IcCopy />}{label ?? (ok ? 'Copied' : 'Copy')}</button>;
}
export const Avatar = ({ name = '?', size }) => {
  const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s5)', 'var(--s7)', 'var(--s8)'];
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return <span className={`avatar ${size || ''}`} style={{ background: colors[h % colors.length] }}>{name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase()}</span>;
};
export const Field = ({ label, hint, children, className }) => <label className={`field ${className || ''}`}><span>{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>;
export function usePage(initial = 1, size = 20) {
  const [page, setPage] = useState(initial);
  return { page, setPage, size, offset: (page - 1) * size };
}
export function Pager({ page, setPage, size, total }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pager"><span>Showing {total === 0 ? 0 : (page - 1) * size + 1}–{Math.min(page * size, total)} of {total}</span>
      <div className="row"><button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} / {pages}</span><button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></div>
  );
}
