// api/family.js — hardened version
// Public read-only endpoint for family board and widget
import { kv } from './_kv.js';

const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 60; // higher for read — boards refresh every 15s

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function setCORS(res) { Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); }
function safeError(res, status, msg) { return res.status(status).json({ error: msg }); }

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  return c.length >= 3 ? c : null;
}

// Strip internal fields before returning to client
function sanitizeForPublic(session) {
  return {
    activeTasks: (session.activeTasks || []).map(t=>({ text:t.text, priority:t.priority, recur:t.recur||null, duration:t.duration||null })),
    allTasks:    (session.allTasks || []).map(t=>({ text:t.text, priority:t.priority })),
    doneTasks:   (session.doneTasks || []).map(t=>({ text:t.text, priority:t.priority })),
    deferred:    (session.deferred || []).map(t=>({ text:t.text, priority:t.priority, date:t.date, time:t.time||null })),
    energy:      session.energy || null,
    intention:   session.intention ? String(session.intention).slice(0,500) : null,
    streak:      typeof session.streak === 'number' ? Math.min(session.streak, 9999) : 0,
  };
}

async function checkRateLimit(ip) {
  const key = `steddi:rate:fam:${ip}`;
  try {
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MAX;
  } catch { return true; }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return safeError(res, 405, 'Method not allowed');

  // Rate limit by IP for read endpoint
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!await checkRateLimit(ip)) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
    return safeError(res, 429, 'Too many requests');
  }

  const code = sanitizeCode(req.query.code);
  if (!code) return safeError(res, 400, 'Missing or invalid ?code= parameter (min 3 alphanumeric characters)');

  try {
    // Try BOTH storage locations in parallel:
    //  - steddi:tasks:{code}    (new, written by /api/tasks — current main app)
    //  - steddi:{code}          (legacy, written by /api/sync — old family-share flow)
    //  - steddi:history:{code}  (history, written by /api/history if ever called)
    //  - steddi:events:{code}   (calendar events written by /api/events from calendar.html)
    // Prefer the newer one when both exist. This keeps widget.html, family.html, and
    // calendar.html reading current data without requiring any migration.
    const [tasksRaw, legacyRaw, historyRaw, eventsRaw] = await Promise.all([
      kv.get(`steddi:tasks:${code}`),
      kv.get(`steddi:${code}`),
      kv.get(`steddi:history:${code}`),
      kv.get(`steddi:events:${code}`),
    ]);

    // Parse — kv may return string or object depending on client version
    const parse = (raw) => {
      if (!raw) return null;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    };
    const tasks  = parse(tasksRaw);
    const legacy = parse(legacyRaw);
    const history = Array.isArray(historyRaw) ? historyRaw : parse(historyRaw);
    const events  = Array.isArray(eventsRaw)  ? eventsRaw  : parse(eventsRaw);

    // Pick the newer source between tasks and legacy. Compare updatedAt / _synced.
    const tasksTs  = tasks?.updatedAt || 0;
    const legacyTs = legacy?._synced ? new Date(legacy._synced).getTime() : 0;
    const primary = (tasks && tasksTs >= legacyTs) ? tasks : (legacy || tasks);

    if (!primary) {
      return res.status(404).json({ ok: false, error: 'No data found for this code' });
    }

    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');

    // Normalize the shape. /api/tasks stores `dumpItems` but family shape doesn't return it —
    // backlog is private. Energy/intention live on legacy but not on tasks payload, so preserve
    // legacy fields where they exist, overlay with tasks data where newer.
    const session = {
      activeTasks: primary.activeTasks || [],
      allTasks:    primary.allTasks    || [],
      doneTasks:   primary.doneTasks   || [],
      deferred:    primary.deferred    || [],
      energy:      primary.energy      || legacy?.energy      || null,
      intention:   primary.intention   || legacy?.intention   || null,
      streak:      primary.profile?.streak || legacy?.streak  || 0,
      _synced:     primary.updatedAt ? new Date(primary.updatedAt).toISOString() : (legacy?._synced || null),
    };

    // History can come from either: /api/tasks payload (array on primary.history) OR /api/history key
    const mergedHistory = Array.isArray(primary.history) && primary.history.length > 0
      ? primary.history
      : (Array.isArray(history) ? history : []);

    return res.status(200).json({
      ok: true,
      synced: session._synced,
      ...sanitizeForPublic(session),
      history: mergedHistory.slice(0,30).map(e=>({
        date: e.date,
        dateRaw: e.dateRaw,
        done: (e.done||[]).map(t=>({ text:t.text })),
        deferred: (e.deferred||[]).map(t=>({ text:t.text, date:t.date })),
      })),
      events: Array.isArray(events) ? events.slice(0, 200) : [],
    });
  } catch (err) {
    console.error('[family] error:', err?.message);
    return safeError(res, 500, 'Storage unavailable');
  }
}
