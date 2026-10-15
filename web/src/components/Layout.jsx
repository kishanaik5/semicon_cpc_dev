import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { IcChip, IcDashboard, IcTicket, IcTag, IcGift, IcUsers, IcLog, IcCart, IcSun, IcMoon, IcLogout } from './Icons.jsx';
import { getAdminUser, adminLogout } from '../api/client.js';

const TITLES = { '/checkout': ['Storefront', 'Checkout'], '/admin': ['PF Admin', 'Analytics'], '/admin/coupons': ['PF Admin', 'Coupons'], '/admin/offers': ['PF Admin', 'Offers'], '/admin/programs': ['PF Admin', 'Signup & Referral'], '/admin/users': ['PF Admin', 'Users'], '/admin/audit': ['PF Admin', 'Audit log'] };

export function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('sl_theme', theme); }, [theme]);
  return [theme, setTheme];
}

export default function Layout() {
  const [theme, setTheme] = useTheme();
  const loc = useLocation();
  const [section, title] = TITLES[loc.pathname] || ['SemiconLabs', ''];
  const [adminUser, setUser] = useState(getAdminUser());
  useEffect(() => { const f = () => setUser(getAdminUser()); window.addEventListener('sl-admin-changed', f); return () => window.removeEventListener('sl-admin-changed', f); }, []);
  const signedIn = !!adminUser && loc.pathname.startsWith('/admin');
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><IcChip width="18" height="18" /></div><div><div className="brand-name">SemiconLabs</div><div className="brand-sub">Coupon Platform</div></div></div>
        <nav className="nav">
          <div className="nav-section">Storefront</div>
          <NavLink to="/checkout"><IcCart />Checkout</NavLink>
          <div className="nav-section">PF Admin</div>
          <NavLink to="/admin" end><IcDashboard />Analytics</NavLink>
          <NavLink to="/admin/coupons"><IcTicket />Coupons</NavLink>
          <NavLink to="/admin/offers"><IcTag />Offers</NavLink>
          <NavLink to="/admin/programs"><IcGift />Signup &amp; Referral</NavLink>
          <NavLink to="/admin/users"><IcUsers />Users</NavLink>
          <NavLink to="/admin/audit"><IcLog />Audit log</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="theme-toggle"><span className="row" style={{ gap: 6 }}>{theme === 'dark' ? <IcMoon /> : <IcSun />} {theme === 'dark' ? 'Dark' : 'Light'} mode</span>
            <button className="switch" role="switch" aria-checked={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode" /></div>
          <div className="env-pill"><i />API CONNECTED · v1.0</div>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="crumbs"><span>{section}</span><span>/</span><b>{title}</b></div>
          <div className="spacer" />
          {signedIn && <><span className="chip"><span className="avatar" style={{ background: 'var(--s7)' }}>{adminUser.slice(0, 2).toUpperCase()}</span>{adminUser}</span>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await adminLogout(); window.location.reload(); }}><IcLogout />Sign out</button></>}
        </header>
        <main className="main"><Outlet /></main>
      </div>
    </div>
  );
}
