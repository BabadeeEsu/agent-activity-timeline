// Minimal signed-cookie session so the browser never holds the Ziki key or the access passphrase.
// The cookie is HttpOnly + SameSite=Strict and carries only an expiry and an HMAC.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'zrk_session';

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

export function passphraseMatches(config, given) {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(config.accessToken).digest();
  return timingSafeEqual(a, b);
}

export function issueSession(config, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + config.sessionHours * 3600;
  const payload = `v1.${expires}`;
  return { value: `${expires}.${sign(config.sessionSecret, payload)}`, maxAge: config.sessionHours * 3600 };
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function verifySession(config, cookieHeader, nowMs = Date.now()) {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return false;
  const [expires, signature] = raw.split('.');
  if (!/^\d{9,12}$/.test(expires || '') || !signature) return false;
  if (Number(expires) * 1000 <= nowMs) return false;
  return safeEqual(signature, sign(config.sessionSecret, `v1.${expires}`));
}

export function sessionCookie(value, { maxAge, secure }) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedCookie({ secure }) {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
