// api/ical.js — iCal feed fetcher with caching + GameChanger support
import { kv, kvDiag } from './_kv.js';

const MAX_FEEDS = 10;
const MAX_EVENTS_PER_FEED = 500;
const TTL = 30 * 24 * 60 * 60;
const CACHE_TTL = 3600; // Cache each feed for 1 hour (like Skylight)
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Steddi-Code',
  'Content-Type': 'application/json',
};

function setCORS(res) { Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); }
function safeError(res, status, msg) { return res.status(status).json({ error: msg }); }
function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  return c.length >= 3 ? c : null;
}

// Detect calendar provider for better headers + error messages
function detectProvider(url) {
  if (url.includes('gc.com') || url.includes('gamechanger')) return 'gamechanger';
  if (url.includes('teamsnap')) return 'teamsnap';
  if (url.includes('google.com/calendar')) return 'google';
  if (url.includes('icloud.com') || url.includes('apple.com')) return 'apple';
  if (url.includes('outlook') || url.includes('office365')) return 'outlook';
  return 'generic';
}

// Headers that mimic a real calendar app — helps with providers that block bots
function fetchHeaders(provider) {
  const base = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    'Accept': 'text/calendar, application/ics, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };
  if (provider === 'google') base['Referer'] = 'https://calendar.google.com/';
  if (provider === 'teamsnap') base['Referer'] = 'https://www.teamsnap.com/';
  return base;
}

function userFriendlyError(provider, status) {
  if (provider === 'gamechanger') {
    return 'GameChanger requires a special setup. In GameChanger app: Team → Schedule → Share → "Export to Calendar" → this adds it to iPhone Calendar. Then share THAT calendar\'s iCal link instead. GameChanger\'s direct links expire every 24 hours.';
  }
  if (status === 401 || status === 403) return 'This calendar requires login — it\'s not a public link. Look for a "Public" or "Share" option in your calendar settings.';
  if (status === 404) return 'Calendar not found. The link may have changed — try getting a fresh link.';
  if (status === 429) return 'Calendar provider is rate-limiting requests. Try again in a few minutes.';
  return 'Could not load this calendar. Make sure the URL is a public .ics link.';
}

// Minimal iCal parser
function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/\n[ \t]/g,'').split('\n');
  let inEvent = false, current = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent=true; current={}; continue; }
    if (line === 'END:VEVENT') {
      inEvent=false;
      if (current.summary && (current.dtstart || current.dtstart_date)) {
        events.push(current);
        if (events.length >= MAX_EVENTS_PER_FEED) break;
      }
      continue;
    }
    if (!inEvent) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const rawKey = line.substring(0, colonIdx);
    const value = line.substring(colonIdx+1).trim();
    const key = rawKey.split(';')[0].toLowerCase();
    const params = rawKey.toLowerCase();
    if (key==='summary') current.summary = value.slice(0,300);
    else if (key==='description') current.description = value.replace(/\\n/g,' ').slice(0,500);
    else if (key==='location') current.location = value.slice(0,200);
    else if (key==='uid') current.uid = value.slice(0,100);
    else if (key==='url') current.url = value.slice(0,300);
    else if (key==='dtstart') {
      if (params.includes('value=date') || value.length===8) {
        current.allDay=true; current.dtstart_date=value.slice(0,8);
      } else { current.dtstart=value; }
    }
    else if (key==='dtend') {
      if (params.includes('value=date') || value.length===8) current.dtend_date=value.slice(0,8);
      else current.dtend=value;
    }
    else if (key==='rrule') current.rrule=value.slice(0,200);
    else if (key==='status') current.status=value;
  }
  return events;
}

function parseICalDate(s) {
  if (!s) return null;
  try {
    const isUtc = s.endsWith('Z');
    const clean = s.replace('Z','');
    if (clean.length===8) return new Date(clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T00:00:00Z');
    return new Date(clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T'+clean.slice(9,11)+':'+clean.slice(11,13)+':'+clean.slice(13,15)+(isUtc?'Z':''));
  } catch { return null; }
}

function eventToJson(e, feedName, memberColor) {
  const start = parseICalDate(e.dtstart || e.dtstart_date);
  const end = parseICalDate(e.dtend || e.dtend_date);
  if (!start || isNaN(start.getTime())) return null;
  if (e.status === 'CANCELLED') return null;
  return {
    uid: e.uid || Math.random().toString(36).slice(2),
    title: e.summary || 'Untitled',
    description: e.description || null,
    location: e.location || null,
    url: e.url || null,
    start: start.toISOString(),
    end: end ? end.toISOString() : null,
    allDay: !!e.allDay,
    rrule: e.rrule || null,
    source: feedName,
    color: memberColor || null,
    _from: 'ical',
  };
}

async function fetchFeedWithCache(feed, cacheKey) {
  // Try cache first
  try {
    const cached = await kv.get(cacheKey);
    if (cached && cached.events && cached.fetchedAt) {
      const age = Date.now() - cached.fetchedAt;
      if (age < CACHE_TTL * 1000) {
        return { events: cached.events, fromCache: true, error: null };
      }
    }
  } catch {}

  // Fetch fresh
  const provider = detectProvider(feed.url);
  let url = feed.url.replace(/^webcal:/i, 'https:');

  try {
    const r = await fetch(url, {
      headers: fetchHeaders(provider),
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!r.ok) {
      // Fall back to cache even if stale
      try {
        const stale = await kv.get(cacheKey);
        if (stale?.events) return { events: stale.events, fromCache: true, stale: true, error: userFriendlyError(provider, r.status) };
      } catch {}
      return { events: [], fromCache: false, error: userFriendlyError(provider, r.status) };
    }

    const text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR') && !text.includes('BEGIN:VEVENT')) {
      return { events: [], fromCache: false, error: 'This URL does not appear to be a valid iCal feed. Make sure it ends with .ics or is a calendar subscription link.' };
    }

    const parsed = parseICal(text);
    const events = parsed.map(e => eventToJson(e, feed.name, feed.color)).filter(Boolean);

    // Cache successful fetch
    try { await kv.set(cacheKey, { events, fetchedAt: Date.now() }, { ex: TTL }); } catch {}

    return { events, fromCache: false, error: null };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
    // Fall back to stale cache
    try {
      const stale = await kv.get(cacheKey);
      if (stale?.events) return { events: stale.events, fromCache: true, stale: true, error: isTimeout ? 'Calendar took too long to load — showing cached data.' : null };
    } catch {}
    return { events: [], fromCache: false, error: isTimeout ? 'Calendar timed out. It may be temporarily unavailable.' : 'Failed to load calendar: '+err.message?.slice(0,100) };
  }
}

async function rateLimit(code) {
  const key = `steddi:rate:ical:${code}`;
  try { const n=await kv.incr(key); if(n===1)await kv.expire(key,RATE_LIMIT_WINDOW); return n<=RATE_LIMIT_MAX; } catch { return true; }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // DIAGNOSTIC: ?debug=1 returns env var detection without requiring family code
  if (req.method === 'GET' && req.query.debug === '1') {
    // Also try a real KV operation to see if the client works
    let kvPingResult = null;
    let kvPingError = null;
    try {
      await kv.set('steddi:diag:ping', { ts: Date.now() }, { ex: 60 });
      kvPingResult = await kv.get('steddi:diag:ping');
    } catch (err) {
      kvPingError = err?.message || String(err);
    }
    return res.status(200).json({
      ok: true,
      env: kvDiag,
      kvPingResult,
      kvPingError,
      node: process.version,
    });
  }

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.query.code);
  if (!code) return safeError(res, 400, 'Missing family code');
  if (!await rateLimit(code)) { res.setHeader('Retry-After','60'); return safeError(res, 429, 'Too many requests'); }

  const feedsKey = `steddi:ical:feeds:${code}`;
  const eventsKey = `steddi:ical:events:${code}`;

  try {
    if (req.method === 'GET') {
      const [feeds, events] = await Promise.all([kv.get(feedsKey), kv.get(eventsKey)]);
      return res.status(200).json({ ok: true, feeds: feeds||[], events: events||[] });
    }

    if (req.method === 'POST') {
      const { action, url, name, color } = req.body || {};

      if (action === 'add' || action === 'refresh') {
        const feeds = await kv.get(feedsKey) || [];

        if (action === 'add') {
          if (!url || typeof url !== 'string') return safeError(res, 400, 'Missing URL');
          const cleanUrl = url.trim().replace(/^webcal:/i,'https:');
          if (!cleanUrl.startsWith('http')) return safeError(res, 400, 'URL must start with http or webcal://');
          if (feeds.length >= MAX_FEEDS) return safeError(res, 400, 'Maximum of '+MAX_FEEDS+' calendars reached');
          if (!feeds.find(f=>f.url===url)) {
            feeds.push({ url, name:(name||'Calendar').slice(0,50), color:color||null, added:new Date().toISOString() });
            await kv.set(feedsKey, feeds, { ex: TTL });
          }
        }

        // Fetch all feeds in parallel with caching
        const results = await Promise.all(feeds.map(async (feed, i) => {
          const cacheKey = `steddi:ical:cache:${code}:${i}`;
          return fetchFeedWithCache(feed, cacheKey);
        }));

        const allEvents = results.flatMap(r => r.events);
        const feedErrors = results.map((r,i) => r.error ? { feed: feeds[i]?.name, error: r.error } : null).filter(Boolean);

        await kv.set(eventsKey, allEvents.slice(0, 2000), { ex: TTL });
        return res.status(200).json({
          ok: true,
          count: allEvents.length,
          feeds,
          errors: feedErrors,
          cached: results.filter(r=>r.fromCache).length,
        });
      }

      if (action === 'remove') {
        const { feedUrl } = req.body;
        const feeds = (await kv.get(feedsKey)||[]).filter(f=>f.url!==feedUrl);
        await kv.set(feedsKey, feeds, { ex: TTL });
        return res.status(200).json({ ok: true, feeds });
      }

      return safeError(res, 400, 'Unknown action');
    }

    return safeError(res, 405, 'Method not allowed');
  } catch(err) {
    console.error('[ical] error:', err?.message);
    // DIAGNOSTIC: include the real error message so we can see what's wrong
    return res.status(500).json({ error: err?.message || 'Error processing request', env: kvDiag });
  }
}
