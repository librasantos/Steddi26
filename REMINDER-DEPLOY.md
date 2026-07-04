# Steddi — Email Reminder System Deployment

## What was built

A full morning email reminder system that sends users a friendly summary of today's
scheduled tasks. Timezone-aware, per-user opt-in, idempotent, and safe.

## What needs to happen for it to work in production

### 1. Set two environment variables in Vercel

Go to your Vercel project → Settings → Environment Variables. Add:

**`RESEND_API_KEY`**
- Sign up at https://resend.com (free tier: 100 emails/day, 3,000/month)
- Verify your sending domain OR use their sandbox domain for testing
- Copy the API key from resend.com → API Keys → Create API Key
- Paste into Vercel as `RESEND_API_KEY`

**`CRON_SECRET`**
- Generate any random string, e.g. `openssl rand -hex 32` or just type something random
- Example: `a1b2c3d4e5f6789abc123def456789abcdef0123456`
- Paste into Vercel as `CRON_SECRET`
- Vercel will automatically send this as the Authorization header when cron runs

### 2. Verify the cron is scheduled

`vercel.json` now includes:
```json
"crons": [{ "path": "/api/reminder-cron", "schedule": "0 13 * * *" }]
```

**Schedule:** Daily at 13:00 UTC = 8am Central / 9am Eastern / 6am Pacific.

Vercel Hobby plan only allows **daily** crons, which is why it's fixed once-per-day.
Users' per-hour preference is captured in settings but currently unused — if you
upgrade to Pro, change the schedule to `"0 * * * *"` (hourly) and re-enable the
`wantHour` gate in `api/reminder-cron.js` (commented block around line 131).

### 3. Users must opt in

Reminders are OFF by default. Each user has to:
1. Enter their email in Settings (already existed)
2. Toggle "Morning reminders" ON (new)
3. Optionally adjust the reminder hour (defaults to 8am their local time)

### 4. First day behavior

- User sets email + toggles reminders ON at, say, 3pm Monday
- App pushes opt-in to cloud; their device code is added to `steddi:devices` set
- Cron runs hourly; next time it runs at user's local 8am (Tuesday), it fires
- Email arrives in their inbox with the day's scheduled tasks

## Files touched

- `api/_kv.js` — added `sadd`, `smembers`, `srem` wrappers
- `api/tasks.js` — accepts `timezone`, `reminderOptIn`, `reminderHour` in profile;
  indexes device code in `steddi:devices` set on every write
- `api/email.js` — added `reminder` email type; exported `sendReminderDirect` for
  server-to-server use by the cron
- `api/reminder-cron.js` — full implementation (was a stub)
- `vercel.json` — cron schedule added
- `index.html`:
  - captures browser timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
  - new state: `reminderOptIn`, `reminderHour`, `userTz`
  - settings UI: toggle + hour picker under the email field
  - cloud push/pull includes the new fields

## How to test manually

After deploy:

```bash
# Trigger the cron manually (replace values)
curl -X GET https://steddi-olie.vercel.app/api/reminder-cron \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Response includes `stats` showing how many devices were found, eligible,
sent, skipped, and reasons for skips. Useful for debugging.

## How it's safe

- **Opt-in only.** Toggle defaults false. Cron refuses to send without it.
- **Idempotent.** `steddi:reminded:{code}:{date}` key prevents double-sends.
- **Auth-guarded.** Without `CRON_SECRET` set, endpoint returns 503.
- **No data leaks.** Cron reads from `steddi:tasks:{code}` which is already stored.
- **Honors timezones.** Uses `Intl.DateTimeFormat` with IANA timezone string.
- **Nothing-to-send = no email.** Empty days don't get spammy "nothing due" emails.
- **Recurring-aware.** If a daily task is already marked done today via `completedDates`,
  it's excluded from the email.

## Known gaps (acceptable for v1)

- No unsubscribe link in email — user has to open app and toggle off. Adding
  an unsubscribe endpoint is a 30-minute follow-up.
- No email bounce handling — if Resend rejects (invalid email), we log it but
  don't auto-disable. User would need to fix the email manually.
- `steddi:devices` set grows forever. For v1 with <1000 users, fine. At scale,
  add TTL-based cleanup or GC.
- No "test email now" button in settings. Future nice-to-have.
