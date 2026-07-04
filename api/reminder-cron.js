// api/reminder-cron.js — Daily cron that sends morning reminder emails for scheduled tasks.
//
// ACTIVATION CHECKLIST:
//   1. Set env var RESEND_API_KEY (get a free key at resend.com — 100 emails/day tier)
//   2. Set env var CRON_SECRET to a random string (prevents unauthorized triggers)
//   3. vercel.json has `crons: [{ path: "/api/reminder-cron", schedule: "0 * * * *" }]`
//      — runs hourly; per-user reminderHour determines who gets an email this hour
//
// SECURITY:
//   - Vercel cron auto-attaches Authorization: Bearer {CRON_SECRET} header.
//   - Anyone can also POST to this endpoint with the same bearer token (useful for manual reruns).
//   - Without CRON_SECRET set, the endpoint will refuse to run (defense in depth).
//
// IDEMPOTENCY:
//   - Before sending, checks `steddi:reminded:{code}:{yyyy-mm-dd}` — skips if already sent today.
//   - After sending, sets that key with 48h TTL so same-day retries don't duplicate.

import { kv } from './_kv.js';
import { sendReminderDirect } from './email.js';

const DEVICES_KEY = 'steddi:devices';
const REMIND_KEY  = (code, dateIso) => `steddi:reminded:${code}:${dateIso}`;
const REMIND_TTL  = 48 * 60 * 60; // 48 hours

// Compute the local date (yyyy-mm-dd) + local hour for a given IANA timezone.
// Returns null if the timezone string is invalid.
function localNow(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value;
    const year = get('year'), month = get('month'), day = get('day');
    const hour = parseInt(get('hour'), 10);
    if (!year || !month || !day || isNaN(hour)) return null;
    return {
      dateIso: `${year}-${month}-${day}`,
      hour,
      dateLabel: new Date().toLocaleDateString('en-US', {
        timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
      }),
    };
  } catch (err) {
    return null;
  }
}

// Find scheduled tasks (deferred) that are due today, plus any recurring tasks
// that land on today's date in the user's timezone.
function tasksDueToday(data, localDateIso) {
  const todayTasks = [];
  const deferred = Array.isArray(data?.deferred) ? data.deferred : [];
  deferred.forEach(t => {
    if (!t) return;
    // Direct date match
    if (t.date === localDateIso) {
      if (Array.isArray(t.completedDates) && t.completedDates.includes(localDateIso)) return;
      todayTasks.push({
        text: t.text,
        description: t.description || '',
        time: t.time || null,
        priority: t.priority || 'should',
      });
      return;
    }
    // Recurring task — project forward from recurStart/date
    if (t.recur) {
      const startIso = t.recurStart || t.date;
      if (!startIso || localDateIso < startIso) return;
      if (t.recurEnd && localDateIso > t.recurEnd) return;
      if (Array.isArray(t.completedDates) && t.completedDates.includes(localDateIso)) return;
      const startDate = new Date(startIso + 'T00:00:00');
      const todayDate = new Date(localDateIso + 'T00:00:00');
      if (isNaN(startDate.getTime())) return;
      const anchorDow = startDate.getDay();
      const anchorDom = startDate.getDate();
      const dow = todayDate.getDay();
      const dom = todayDate.getDate();
      let matches = false;
      if (t.recur === 'daily') matches = true;
      else if (t.recur === 'weekdays' && dow >= 1 && dow <= 5) matches = true;
      else if (t.recur === 'weekly' && dow === anchorDow) matches = true;
      else if (t.recur === 'monthly' && dom === anchorDom) matches = true;
      if (matches) {
        todayTasks.push({
          text: t.text,
          description: t.description || '',
          time: t.time || null,
          priority: t.priority || 'should',
        });
      }
    }
  });
  return todayTasks;
}

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (!expected) {
    return res.status(503).json({ error: 'CRON_SECRET not configured — set in Vercel env vars' });
  }
  const auth = req.headers['authorization'];
  if (auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const stats = { devices: 0, eligible: 0, sent: 0, skipped: 0, failed: 0, reasons: {} };
  const track = (reason) => { stats.reasons[reason] = (stats.reasons[reason] || 0) + 1; };

  try {
    const codes = await kv.smembers(DEVICES_KEY);
    stats.devices = codes.length;

    for (const entry of codes) {
      try {
        // Index entries can be either "code:abc", "user:xyz", or legacy bare "abc".
        // Resolve to the right storage key.
        let storageKey, code;
        if (typeof entry !== 'string') { stats.skipped++; continue; }
        if (entry.startsWith('user:')) {
          const userId = entry.slice(5);
          storageKey = `steddi:tasks:user:${userId}`;
          code = userId; // used as idempotency key suffix
        } else if (entry.startsWith('code:')) {
          code = entry.slice(5);
          storageKey = `steddi:tasks:${code}`;
        } else {
          // Legacy entry — bare code
          code = entry;
          storageKey = `steddi:tasks:${code}`;
        }

        const raw = await kv.get(storageKey);
        if (!raw) { track('no-data'); stats.skipped++; continue; }
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const profile = data?.profile || {};

        if (!profile.reminderOptIn) { track('not-opted-in'); stats.skipped++; continue; }
        if (!profile.email) { track('no-email'); stats.skipped++; continue; }
        const tz = profile.timezone || 'UTC';
        const local = localNow(tz);
        if (!local) { track('bad-timezone'); stats.skipped++; continue; }

        // Vercel Hobby plan only allows daily crons, so the per-user hour check is disabled.
        // Everyone opted-in with tasks today gets the email at cron-time (13:00 UTC = 8am Central).
        // If you upgrade to Vercel Pro, switch vercel.json cron back to "0 * * * *" and re-enable:
        //   const wantHour = typeof profile.reminderHour === 'number' ? profile.reminderHour : 8;
        //   if (local.hour !== wantHour) { track('wrong-hour'); stats.skipped++; continue; }
        stats.eligible++;

        const alreadyKey = REMIND_KEY(code, local.dateIso);
        const already = await kv.get(alreadyKey);
        if (already) { track('already-sent'); stats.skipped++; continue; }

        const tasks = tasksDueToday(data, local.dateIso);
        if (tasks.length === 0) { track('nothing-today'); stats.skipped++; continue; }

        const result = await sendReminderDirect({
          toEmail: profile.email,
          toName: profile.name,
          tasks,
          intention: data.intention,
          dateLabel: local.dateLabel,
          appUrl: `https://${req.headers.host || 'steddi-olie.vercel.app'}`,
        });

        if (result.ok) {
          await kv.set(alreadyKey, '1', { ex: REMIND_TTL });
          stats.sent++;
        } else {
          track('send-failed:' + (result.reason || 'unknown'));
          stats.failed++;
        }
      } catch (err) {
        track('error:' + (err?.message || 'unknown'));
        stats.failed++;
      }
    }

    res.status(200).json({
      ok: true,
      durationMs: Date.now() - startedAt,
      stats,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[reminder-cron] fatal:', err?.message);
    res.status(500).json({ error: 'Cron run failed', message: err?.message });
  }
}
