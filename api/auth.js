// api/auth.js — Single endpoint for all auth operations.
// Routes by ?action= query parameter. Combines what was four endpoints
// (request, verify, me, logout) into one to stay under the Vercel Hobby
// 12-function limit.
//
// USAGE:
//   POST /api/auth?action=request   body {email}      → sends magic link
//   GET  /api/auth?action=verify&token=...            → sets cookie, redirects
//   GET  /api/auth?action=me                          → returns session info
//   POST /api/auth?action=logout                      → clears cookie

import { kv } from './_kv.js';
import {
  isValidEmail,
  generateToken,
  userIdFromEmail,
  createSessionCookie,
  buildSessionSetCookie,
  buildLogoutSetCookie,
  getSessionFromRequest,
  AUTH_CONSTANTS,
} from './_auth.js';

const RATE_LIMIT_PER_HOUR = 5;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function jsonError(res, code, msg) {
  setCORS(res);
  return res.status(code).json({ error: msg });
}

function htmlError(message) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Steddi — Sign in</title>
  <style>
    body { font-family: -apple-system, system-ui, Helvetica, Arial, sans-serif; background: #FBF7F2; color: #1A1612; margin: 0; padding: 32px 16px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; }
    .card { background: white; max-width: 440px; width: 100%; border-radius: 20px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    .emoji { font-size: 40px; margin-bottom: 8px; }
    h1 { font-family: Georgia, serif; font-weight: 400; font-size: 22px; margin: 0 0 12px; }
    p { color: #6A5A4E; font-size: 14px; line-height: 1.6; margin: 0 0 24px; }
    a.btn { display: inline-block; background: #E07840; color: white; text-decoration: none; padding: 12px 28px; border-radius: 50px; font-size: 14px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">🐬</div>
    <h1>Sign-in didn't go through</h1>
    <p>${message}</p>
    <a class="btn" href="/">Open Steddi →</a>
  </div>
</body>
</html>`;
}

// === Action: request — POST {email}. Send magic link. ===
async function handleRequest(req, res) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return jsonError(res, 503, 'Email service not configured');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return jsonError(res, 400, 'Invalid JSON'); }
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return jsonError(res, 400, 'Invalid email');

  // Rate limit per email
  try {
    const rateKey = `steddi:auth:rate:${email}`;
    const count = await kv.incr(rateKey);
    if (count === 1) {
      try { await kv.set(rateKey, '1', { ex: 3600 }); } catch {}
    }
    if (count > RATE_LIMIT_PER_HOUR) {
      return jsonError(res, 429, 'Too many requests. Try again in an hour.');
    }
  } catch {}

  const token = generateToken();
  const tokenKey = `steddi:auth:token:${token}`;

  try {
    await kv.set(tokenKey, JSON.stringify({ email, createdAt: Date.now() }), { ex: AUTH_CONSTANTS.TOKEN_TTL_SECONDS });
  } catch (err) {
    console.error('[auth.request] kv.set failed:', err?.message);
    return jsonError(res, 500, 'Storage unavailable');
  }

  const host = req.headers.host || 'steddi-olie.vercel.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const link = `${proto}://${host}/api/auth?action=verify&token=${token}`;

  const subject = 'Your Steddi sign-in link 🐬';
  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FBF7F2;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:500px;margin:32px auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#E07840;padding:28px 32px;text-align:center;">
      <div style="font-size:40px;margin-bottom:8px;">🐬</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:white;">steddi</div>
    </div>
    <div style="padding:32px;text-align:center;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#1A1612;font-size:20px;margin:0 0 12px;">Tap to sign in</h2>
      <p style="color:#6A5A4E;font-size:14px;line-height:1.6;margin:0 0 28px;">
        We got a request to sign in to Steddi. If that was you, tap the button below. The link is good for 15 minutes.
      </p>
      <a href="${link}" style="display:inline-block;background:#E07840;color:white;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:700;">Sign in to Steddi →</a>
      <p style="color:#999;font-size:12px;line-height:1.6;margin:32px 0 0;">
        If you didn't ask for this, you can safely ignore this email. No one can sign in without tapping the link from your inbox.
      </p>
    </div>
  </div>
</body>
</html>`;
  const text = `Tap to sign in to Steddi: ${link}\n\nThis link expires in 15 minutes. If you didn't request this, ignore this email.`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Steddi <onboarding@resend.dev>',
        to: [email],
        subject, html, text,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      console.error('[auth.request] Resend error:', j);
      return jsonError(res, 502, 'Email delivery failed');
    }
    setCORS(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth.request] fetch error:', err?.message);
    return jsonError(res, 500, 'Email service unavailable');
  }
}

// === Action: verify — GET ?token=... Sets cookie, redirects to /. ===
async function handleVerify(req, res) {
  const token = req.query?.token;
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).send(htmlError('That link looks invalid. Please request a new one.'));
  }

  if (!process.env.AUTH_SECRET) {
    return res.status(503).send(htmlError('Authentication is not configured. Set AUTH_SECRET env var.'));
  }

  const tokenKey = `steddi:auth:token:${token}`;
  let tokenData = null;
  try {
    const raw = await kv.get(tokenKey);
    if (!raw) {
      return res.status(400).send(htmlError("This link has expired or already been used. Request a new one from Steddi."));
    }
    tokenData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error('[auth.verify] kv.get failed:', err?.message);
    return res.status(500).send(htmlError('Could not verify the link. Try again in a moment.'));
  }

  // Single-use: delete the token immediately
  try { await kv.del(tokenKey); } catch {}

  const email = String(tokenData?.email || '').trim().toLowerCase();
  const userId = userIdFromEmail(email);
  if (!userId) {
    return res.status(400).send(htmlError('The email on this link is invalid.'));
  }

  let cookieValue;
  try {
    cookieValue = createSessionCookie({ userId, email });
  } catch (err) {
    console.error('[auth.verify] cookie creation failed:', err?.message);
    return res.status(500).send(htmlError('Could not start your session. Try again.'));
  }

  res.setHeader('Set-Cookie', buildSessionSetCookie(cookieValue));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.statusCode = 200;
  // Use HTML success page that self-tests the cookie before redirecting.
  // This way we can SEE whether the cookie is actually working in this browser.
  res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Signed in — Steddi</title>
  <style>
    body { font-family: -apple-system, system-ui, Helvetica, Arial, sans-serif; background: #FBF7F2; color: #1A1612; margin: 0; padding: 32px 16px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; }
    .card { background: white; max-width: 440px; width: 100%; border-radius: 20px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    .emoji { font-size: 56px; margin-bottom: 12px; }
    h1 { font-family: Georgia, serif; font-weight: 400; font-size: 22px; margin: 0 0 8px; }
    p { color: #6A5A4E; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
    .status { padding: 12px 16px; border-radius: 12px; font-size: 13px; margin: 16px 0; font-family: ui-monospace, 'SF Mono', Menlo, monospace; word-break: break-all; }
    .ok { background: #EDF4EE; color: #2A6A40; }
    .fail { background: #FDEAEA; color: #A04040; }
    .pending { background: #F4F0E8; color: #6A5A4E; }
    a.btn { display: inline-block; background: #E07840; color: white; text-decoration: none; padding: 12px 28px; border-radius: 50px; font-size: 14px; font-weight: 700; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">🐬</div>
    <h1>Sign-in self-test</h1>
    <p id="msg">Checking if your cookie was saved…</p>
    <div id="status" class="status pending">⏳ Testing…</div>
    <a class="btn" id="continue" href="/?signedin=1" style="display:none;">Open Steddi →</a>
  </div>
  <script>
    (async function() {
      const status = document.getElementById('status');
      const msg = document.getElementById('msg');
      const cont = document.getElementById('continue');
      try {
        const r = await fetch('/api/auth?action=me', { credentials: 'include' });
        const j = await r.json().catch(() => ({}));
        if (j.signedIn) {
          status.className = 'status ok';
          status.textContent = '✅ Cookie works! Signed in as ' + j.user.email;
          msg.textContent = 'Sign-in succeeded. Tap below to open Steddi.';
          cont.style.display = 'inline-block';
          // Auto-redirect after 1.5s
          setTimeout(() => { window.location.href = '/?signedin=1'; }, 1500);
        } else {
          status.className = 'status fail';
          status.textContent = '❌ Cookie not saved. The browser is blocking it. Status: ' + r.status;
          msg.textContent = 'Sign-in did not stick. Try opening this link in regular Safari (not in-app browser).';
          cont.style.display = 'inline-block';
          cont.textContent = 'Try anyway →';
        }
      } catch (err) {
        status.className = 'status fail';
        status.textContent = '❌ Network error: ' + (err && err.message ? err.message : 'unknown');
        cont.style.display = 'inline-block';
      }
    })();
  </script>
</body>
</html>`);
}

// === Action: me — GET. Returns current session, or 401. ===
function handleMe(req, res) {
  setCORS(res);
  res.setHeader('Cache-Control', 'no-store');
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ ok: false, signedIn: false });
  return res.status(200).json({
    ok: true,
    signedIn: true,
    user: { userId: session.userId, email: session.email },
  });
}

// === Action: logout — POST. Clears cookie. ===
function handleLogout(req, res) {
  setCORS(res);
  res.setHeader('Set-Cookie', buildLogoutSetCookie());
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}

// === Action: debug — GET. Returns config + cookie status. Useful for diagnosing sign-in issues. ===
function handleDebug(req, res) {
  setCORS(res);
  res.setHeader('Cache-Control', 'no-store');
  const cookieHeader = req.headers.cookie || '';
  const hasSessionCookie = cookieHeader.includes('steddi_session=');
  const session = getSessionFromRequest(req);

  // List all env var names matching common storage patterns to help diagnose
  // which variable the Upstash/KV integration created.
  const envVarNames = Object.keys(process.env).filter(k =>
    /KV|REDIS|UPSTASH/i.test(k)
  );

  return res.status(200).json({
    env: {
      AUTH_SECRET_set: !!process.env.AUTH_SECRET,
      RESEND_API_KEY_set: !!process.env.RESEND_API_KEY,
      EMAIL_FROM_set: !!process.env.EMAIL_FROM,
      CRON_SECRET_set: !!process.env.CRON_SECRET,
      KV_REST_API_URL_set: !!process.env.KV_REST_API_URL || !!process.env.UPSTASH_REDIS_REST_URL,
      // Show all names that look like storage env vars (just names, not values)
      storageEnvVarNames: envVarNames,
    },
    request: {
      hasCookieHeader: cookieHeader.length > 0,
      hasSessionCookie,
      cookieHeaderLength: cookieHeader.length,
      host: req.headers.host,
      userAgent: (req.headers['user-agent'] || '').slice(0, 100),
      proto: req.headers['x-forwarded-proto'] || 'unknown',
    },
    session: session ? { signedIn: true, email: session.email } : { signedIn: false },
    serverTime: new Date().toISOString(),
  });
}

// === Main router ===
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCORS(res);
    return res.status(204).end();
  }

  const action = String(req.query?.action || '').toLowerCase();

  switch (action) {
    case 'request':
      if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');
      return handleRequest(req, res);
    case 'verify':
      if (req.method !== 'GET') return jsonError(res, 405, 'Method not allowed');
      return handleVerify(req, res);
    case 'me':
      if (req.method !== 'GET') return jsonError(res, 405, 'Method not allowed');
      return handleMe(req, res);
    case 'logout':
      if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');
      return handleLogout(req, res);
    case 'debug':
      if (req.method !== 'GET') return jsonError(res, 405, 'Method not allowed');
      return handleDebug(req, res);
    default:
      return jsonError(res, 400, 'Unknown action. Use ?action=request, verify, me, logout, or debug.');
  }
}
