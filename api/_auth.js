// api/_auth.js — Shared auth helpers for magic-link authentication.
//
// DESIGN:
//   - Users identified by a deterministic hash of their email (first 16 hex of sha256).
//   - Sessions are HMAC-signed cookies: base64url({userId, email, exp}).signature
//   - Signed with AUTH_SECRET env var (required).
//   - 30-day session lifetime.
//   - HttpOnly, Secure, SameSite=Lax — protects against XSS and CSRF respectively.
//
// ENV VARS REQUIRED:
//   - AUTH_SECRET — 32+ character random string. Used to sign session cookies.
//                   Generate with: openssl rand -hex 32

import crypto from 'node:crypto';

const SESSION_COOKIE = 'steddi_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes for magic link tokens

// Derive a stable userId from an email address.
// Uses first 16 hex chars of SHA-256 — collision-resistant for any realistic user base.
export function userIdFromEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// Validate email shape — not exhaustive, just sane.
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 3 || e.length > 254) return false;
  // Simple but practical: one @, something on each side, a dot in the domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Generate a cryptographically random token for magic links.
// Returns 32 hex chars (128 bits of entropy).
export function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// HMAC sign arbitrary string data. Used for session cookies.
function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

// Constant-time string comparison to prevent timing attacks on signature verify.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Build a signed session cookie value.
// Format: base64url(JSON({userId, email, exp})).signature
export function createSessionCookie({ userId, email }) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET not set');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = { userId, email, exp };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(encoded, secret);
  return `${encoded}.${sig}`;
}

// Verify a session cookie value. Returns the payload if valid, null otherwise.
export function verifySessionCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = sign(encoded, secret);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.userId || !payload.email || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

// Build the Set-Cookie header string for a session.
export function buildSessionSetCookie(cookieValue) {
  // Secure: requires HTTPS — fine for Vercel
  // HttpOnly: JS can't read — protects against XSS
  // SameSite=Lax: sent on top-level navigation, blocks most CSRF
  return `${SESSION_COOKIE}=${cookieValue}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

// Build the Set-Cookie header to clear the session (logout).
export function buildLogoutSetCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Parse the cookie header from a request and extract the session payload (or null).
export function getSessionFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  if (!cookieHeader) return null;
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const idx = c.indexOf('=');
      if (idx < 0) return [c.trim(), ''];
      return [c.slice(0, idx).trim(), c.slice(idx + 1).trim()];
    })
  );
  const sessionValue = cookies[SESSION_COOKIE];
  if (!sessionValue) return null;
  return verifySessionCookie(sessionValue);
}

export const AUTH_CONSTANTS = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
};
