# Steddi — Email Auth (Magic Link) Deployment

## What was built

Optional, passwordless authentication via magic links. Users tap "Sign in" → enter email →
receive a one-time link → click it → signed in for 30 days. Identity is bound to email.

Steddi works **fully without** signing in. Sign-in unlocks:
- Cloud backup (your tasks live in Redis, restorable to any device)
- Morning email reminders (the cron knows who you are)
- "View my cloud backup" in settings

## What you need to do to activate

### 1. Add `AUTH_SECRET` env var in Vercel

Generate a random 32+ character string. Easiest:
```bash
openssl rand -hex 32
```
Or just type any random gibberish 40+ chars long.

Vercel → your project → Settings → Environment Variables:
- Key: `AUTH_SECRET`
- Value: that random string
- Apply to: Production, Preview, Development

This is what signs session cookies. **Don't change it after launch** — changing it
invalidates all active sessions and signs everyone out.

### 2. You already need `RESEND_API_KEY`

Same key as for the reminder cron — used to send magic-link emails.

That's it. No third Auth provider, no DB migrations.

## How it works

**Storage layout:**
- Anonymous users: tasks at `steddi:tasks:{code}` (legacy, still works)
- Signed-in users: tasks at `steddi:tasks:user:{userIdHash}` (where userIdHash = sha256(email)[0..16])
- Sessions: HMAC-signed cookie, no DB row needed
- Magic-link tokens: `steddi:auth:token:{token}` with 15-min TTL, single-use
- Rate limit: max 5 sign-in requests per email per hour

**Endpoints:**
- `POST /api/auth/request` — body `{email}`. Sends magic link email.
- `GET /api/auth/verify?token=...` — validates token, sets session cookie, redirects to `/?signedin=1`.
- `GET /api/auth/me` — returns `{signedIn, user: {userId, email}}` or 401.
- `POST /api/auth/logout` — clears cookie.

**Cookies:** `HttpOnly; Secure; SameSite=Lax; Max-Age=30 days` — JS can't read them
(XSS protection), only sent over HTTPS, only sent on top-level navigation (CSRF protection).

## Backward compatibility

Existing users with sync codes keep working unchanged. Their data stays at
`steddi:tasks:{code}`. They can sign in later if they want; their old code-based
data isn't auto-migrated yet (TODO: add migration UI in a follow-up).

## Test plan

1. Deploy with both env vars set (`AUTH_SECRET`, `RESEND_API_KEY`)
2. Open Steddi → Settings → tap "📨 Sign in with email"
3. Enter your email → tap Send link
4. Modal switches to "Check your email"
5. Open the email → tap the link
6. Land back in Steddi with `?signedin=1` in URL (auto-stripped)
7. Settings now shows "Signed in as your@email.com" + Sign out button
8. Add a task → check that it pushes to cloud (status indicator)
9. Open in incognito browser → sign in with same email → tasks restore from cloud

## Known gaps

- **No code → user migration UI.** If a long-time user with a sync code signs in,
  their old code-based tasks aren't auto-imported. They can still type the code
  in Family Sync to access old data, but the two stores are independent. Add a
  migration prompt in v1.1.
- **No email change flow.** Today, signing in with a different email creates a
  separate account. No "merge" or "change my email" UI.
- **Widget/family.html still code-based.** They read from `steddi:tasks:{code}`
  via `/api/family`. To make them work for auth users, we'd need to extend
  `/api/family` to accept session cookies too. Reasonable v1.1 follow-up.

## Security notes

- Cookies are HttpOnly so JavaScript can't steal them via XSS
- Magic-link tokens are single-use and 15-min TTL
- Rate limited per email (5/hour) to prevent abuse
- All endpoints set `Cache-Control: no-store` to prevent CDN caching of auth state
- `AUTH_SECRET` is the only thing protecting session integrity — keep it secret,
  rotate if you suspect leak (will sign everyone out, which is the safe outcome)
