// Admin auth is a server-side session held in an HttpOnly cookie; JavaScript never sees the token.
// sessionStorage only remembers the display name so the header can show who is signed in.
const USER_KEY = 'semicon_admin_user';
export const getAdminUser = () => sessionStorage.getItem(USER_KEY) || '';
const changed = () => window.dispatchEvent(new Event('sl-admin-changed'));
export const setAdminUser = (u) => { sessionStorage.setItem(USER_KEY, u); changed(); };
export const clearAdminUser = () => { sessionStorage.removeItem(USER_KEY); changed(); };

async function request(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (admin && res.status === 401) window.dispatchEvent(new Event('sl-admin-expired'));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.code = data?.error?.code || 'ERROR';
    err.status = res.status;
    err.extra = data?.error || {};
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  admin: {
    get: (p) => request(p, { admin: true }),
    post: (p, body) => request(p, { method: 'POST', body, admin: true }),
    put: (p, body) => request(p, { method: 'PUT', body, admin: true }),
    patch: (p, body) => request(p, { method: 'PATCH', body, admin: true }),
  },
};

export const adminLogin = (username, password) => request('/api/admin/login', { method: 'POST', body: { username, password } });
export const adminLogout = async () => { try { await request('/api/admin/logout', { method: 'POST' }); } catch { /* already gone */ } clearAdminUser(); };

export const fmtINR = (n) => { const v = Number(n || 0); return `₹${v.toLocaleString('en-IN', Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
export const fmtDateShort = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '');
