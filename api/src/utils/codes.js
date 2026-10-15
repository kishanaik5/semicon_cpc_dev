import crypto from 'node:crypto';

// No 0/O/1/I to avoid ambiguity when codes are read aloud or typed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function uniqueCode(prefix = '', length = 10) {
  const body = randomCode(length);
  const p = (prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return p ? `${p}-${body.slice(0, 4)}-${body.slice(4)}` : `${body.slice(0, 5)}-${body.slice(5)}`;
}

export function randomPin(digits = 6) {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(digits, '0');
}

export function referralCode(name = '') {
  const base = (name || 'USER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
  return `${base}${randomCode(5)}`;
}

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}
