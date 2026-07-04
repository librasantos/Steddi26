// api/tasks.js — Cloud sync for tasks, backlog, scheduled, history
// Keyed by either userId (authenticated session) OR device code (legacy).
// Authenticated users write to steddi:tasks:user:{userId}.
// Code-based users write to steddi:tasks:{code} (kept for backward compat).
// Writes are last-wins. Uses updatedAt timestamps for conflict resolution.

import { kv } from './_kv.js';
import { getSessionFromRequest } from './_auth.js';

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB safety cap
const TTL_DAYS = 180; // Keep data for 6 months of inactivity
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeTaskArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => x && typeof x === 'object' && typeof x.text === 'string').slice(0, 500);
}

// Resolve which storage key + identifier to use for this request.
// Priority: signed-in session > device code in body/query.
// Returns { key, identifier, scope: 'user'|'code' } or null if neither.
function resolveStorageKey(req) {
  const session = getSessionFromRequest(req);
  if (session && session.userId) {
    return {
      key: `steddi:tasks:user:${session.userId}`,
      identifier: session.userId,
      scope: 'user',
      session,
    };
  }
  const code = sanitizeCode(req.query?.code || req.body?.code);
  if (code) {
    return {
      key: `steddi:tasks:${code}`,
      identifier: code,
      scope: 'code',
    };
  }
  return null;
}

export default async function handler(req, res) {
  // CORS for safety
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const resolved = resolveStorageKey(req);
  if (!resolved) {
    res.status(400).json({ error: 'Missing session or device code' });
    return;
  }
  const { key, identifier, scope, session } = resolved;

  if (req.method === 'GET') {
    try {
      const raw = await kv.get(key);
      if (!raw) {
        res.status(200).json({ exists: false });
        return;
      }
      // Redis client may return a parsed object or a string
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      res.status(200).json({ exists: true, data });
    } catch (err) {
      console.error('[tasks] GET failed:', err?.message);
      res.status(500).json({ error: 'Failed to load tasks' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const payload = {
        activeTasks: sanitizeTaskArray(body.activeTasks),
        allTasks: sanitizeTaskArray(body.allTasks),
        dumpItems: sanitizeTaskArray(body.dumpItems),
        deferred: sanitizeTaskArray(body.deferred),
        doneTasks: sanitizeTaskArray(body.doneTasks),
        history: Array.isArray(body.history) ? body.history.slice(0, 100) : [],
        energy: ['low','okay','good'].includes(body.energy) ? body.energy : null,
        intention: typeof body.intention === 'string' ? body.intention.slice(0, 500) : null,
        profile: (body.profile && typeof body.profile === 'object') ? {
          name: typeof body.profile.name === 'string' ? body.profile.name.slice(0, 100) : '',
          about: typeof body.profile.about === 'string' ? body.profile.about.slice(0, 500) : '',
          email: typeof body.profile.email === 'string' ? body.profile.email.slice(0, 254) : '',
          theme: typeof body.profile.theme === 'string' ? body.profile.theme.slice(0, 40) : '',
          fontSize: typeof body.profile.fontSize === 'string' ? body.profile.fontSize.slice(0, 20) : '',
          customBg: typeof body.profile.customBg === 'string' ? body.profile.customBg.slice(0, 3 * 1024 * 1024) : '', // ~3MB data URL cap
          customBgDark: typeof body.profile.customBgDark === 'boolean' ? body.profile.customBgDark : false,
          streak: typeof body.profile.streak === 'number' ? Math.max(0, Math.min(body.profile.streak, 10000)) : 0,
          // IANA timezone string (e.g. "America/Chicago"). Used by reminder cron to know when "today" is for this user.
          timezone: typeof body.profile.timezone === 'string' ? body.profile.timezone.slice(0, 64) : '',
          // Opt-in flag for morning email reminders. Defaults false — user must explicitly enable.
          reminderOptIn: typeof body.profile.reminderOptIn === 'boolean' ? body.profile.reminderOptIn : false,
          // Hour of day (0-23) in user's local timezone to send reminders. Default 8am.
          reminderHour: typeof body.profile.reminderHour === 'number' ? Math.max(0, Math.min(23, Math.floor(body.profile.reminderHour))) : 8,
        } : null,
        updatedAt: Date.now(),
      };

      // GUARD: If incoming payload is completely empty but existing stored has data, refuse overwrite.
      // This is a server-side safety net for client bugs or malicious empty-push.
      const incomingIsEmpty = payload.activeTasks.length===0 && payload.allTasks.length===0
        && payload.dumpItems.length===0 && payload.deferred.length===0 && payload.doneTasks.length===0;
      if (incomingIsEmpty) {
        try {
          const existingRaw = await kv.get(key);
          if (existingRaw) {
            const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
            const existingHasData = existing && (
              (existing.activeTasks||[]).length > 0 ||
              (existing.allTasks||[]).length > 0 ||
              (existing.dumpItems||[]).length > 0 ||
              (existing.deferred||[]).length > 0
            );
            if (existingHasData) {
              console.warn(`[tasks] Refused empty overwrite for ${code} — existing has data`);
              // Still accept profile updates if provided
              if (payload.profile) {
                const merged = { ...existing, profile: payload.profile, updatedAt: Date.now() };
                await kv.set(key, JSON.stringify(merged), { ex: TTL_SECONDS });
              }
              res.status(200).json({ ok: true, skipped: 'empty-guard', updatedAt: existing.updatedAt || Date.now() });
              return;
            }
          }
        } catch (err) {
          console.error('[tasks] guard check failed:', err?.message);
        }
      }

      // Keep a rolling backup of the last non-empty snapshot (for disaster recovery)
      if (!incomingIsEmpty) {
        try {
          const existingRaw = await kv.get(key);
          if (existingRaw) {
            const backupKey = `steddi:tasks:${code}:backup`;
            await kv.set(backupKey, existingRaw, { ex: TTL_SECONDS });
          }
        } catch (err) {
          // Backup failure shouldn't block the save
        }
      }

      const serialized = JSON.stringify(payload);
      if (serialized.length > MAX_BODY_SIZE) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      await kv.set(key, serialized, { ex: TTL_SECONDS });

      // Maintain a device index so the reminder cron can enumerate users.
      // Format: "code:abc" or "user:hashedid" — prefix tells the cron which key to read.
      // Safe to call every write — Redis SADD is idempotent.
      try {
        const indexEntry = scope === 'user' ? `user:${identifier}` : `code:${identifier}`;
        await kv.sadd('steddi:devices', indexEntry);
      } catch (err) {
        // Index failure shouldn't block the save
      }

      res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
    } catch (err) {
      console.error('[tasks] POST failed:', err?.message);
      res.status(500).json({ error: 'Failed to save tasks' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
