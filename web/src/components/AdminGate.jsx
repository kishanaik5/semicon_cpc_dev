import React, { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { api, adminLogin, adminLogout, setAdminUser, clearAdminUser } from '../api/client.js';
import { Alert, Field, Skeleton } from './ui.jsx';
import { IcShield, IcLock } from './Icons.jsx';

const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];

export default function AdminGate() {
  const [state, setState] = useState('checking');   // checking | login | ok
  const [form, setForm] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const idleMs = useRef(15 * 60 * 1000);
  const timer = useRef(null);

  const toLogin = (message = '') => { clearAdminUser(); setNotice(message); setForm({ username: '', password: '' }); setState('login'); };

  // On load: is there already a live session cookie?
  useEffect(() => {
    api.admin.get('/api/admin/ping')
      .then((r) => { setAdminUser(r.username); idleMs.current = r.idle_minutes * 60 * 1000; setState('ok'); })
      .catch(() => toLogin());
  }, []);

  // Any admin call that comes back 401 (server-side expiry) sends us to the login screen.
  useEffect(() => {
    const onExpired = () => toLogin('Your session has expired. Please sign in again.');
    window.addEventListener('sl-admin-expired', onExpired);
    return () => window.removeEventListener('sl-admin-expired', onExpired);
  }, []);

  // Client-side inactivity timer (the server enforces the same limit independently).
  useEffect(() => {
    if (state !== 'ok') return undefined;
    let last = 0;
    const arm = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => { await adminLogout(); toLogin('You were signed out after a period of inactivity.'); }, idleMs.current);
    };
    const onActivity = () => { const now = Date.now(); if (now - last > 1000) { last = now; arm(); } };
    arm();
    ACTIVITY.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => { clearTimeout(timer.current); ACTIVITY.forEach((e) => window.removeEventListener(e, onActivity)); };
  }, [state]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await adminLogin(form.username, form.password);
      setAdminUser(r.username); idleMs.current = r.idle_minutes * 60 * 1000;
      setNotice(''); setForm({ username: '', password: '' }); setState('ok');
    } catch (ex) { setErr(ex.message); setForm((f) => ({ ...f, password: '' })); }
    finally { setBusy(false); }
  };

  if (state === 'checking') return <div className="stack"><Skeleton w={240} h={28} /><div className="grid cols-4">{[1, 2, 3, 4].map((i) => <div key={i} className="card tile"><Skeleton w={100} /><Skeleton w={80} h={28} /></div>)}</div></div>;
  if (state === 'login') {
    return (
      <div className="login-wrap"><form className="card card-pad login stack" onSubmit={submit}>
        <div className="brand-mark"><IcShield width="22" height="22" /></div>
        <div><h1 style={{ fontSize: 20 }}>PF Admin</h1><p className="text-2" style={{ marginTop: 4 }}>Sign in to manage coupons, offers and view analytics.</p></div>
        {notice && <Alert kind="warn">{notice}</Alert>}
        <Field label="Username"><input autoFocus autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••••••" /></Field>
        {err && <Alert kind="error">{err}</Alert>}
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !form.username || !form.password}><IcLock />{busy ? 'Signing in…' : 'Sign in'}</button>
      </form></div>
    );
  }
  return <Outlet />;
}
