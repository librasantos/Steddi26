// api/dump-parse.js — Conversational brain dump processor.
// Two actions:
//   POST /api/dump-parse?action=transcribe — accepts audio, returns text (OpenAI Whisper)
//   POST /api/dump-parse                   — accepts text, returns structured tasks (Claude)
//
// REQUIRED ENV VARS:
//   ANTHROPIC_API_KEY  (always)
//   OPENAI_API_KEY     (only for voice transcription)

const MODEL = 'claude-haiku-4-5-20251001';

export const config = {
  api: { bodyParser: { sizeLimit: '26mb' } },
};

const SYSTEM_PROMPT = `You are Steddi's brain dump parser. Your job is to take messy, conversational input — what someone said out loud or typed in a rush — and extract a clean list of tasks.

RULES:
1. Each distinct task gets its own row. Combine fragments that are clearly the same task; split sentences that contain multiple tasks.
2. Rewrite each task into a clear imperative phrase (e.g. "Email Soma about the AI committee deck" not "I need to email Soma").
3. Keep them short — under ~80 characters per task title when possible. Move details to the notes field.
4. Infer priority based on language:
   - "must", "have to", "urgent", "today", "before X" → priority: "must"
   - default conversational tasks → priority: "should"
   - "would be nice", "someday", "eventually", "maybe" → priority: "nice"
5. Infer effort based on what the task is:
   - quick emails, short calls, picking things up → effort: "easy"
   - complex conversations, drafting documents, multi-step tasks → effort: "hard"
   - if unclear, leave effort as null (don't guess)
6. If the user mentions any context worth keeping (deadline, name, location, feeling about it), put it in the "notes" field.
7. If the input contains things that aren't tasks (reflections, ideas, complaints), include them as task: null in a separate "captures" array — DON'T drop them, just don't force them into the task format.
8. Be charitable. Messy input is the whole point. Don't ask for clarification — make your best inference.

RESPOND ONLY WITH JSON in this exact structure:
{
  "tasks": [
    {
      "text": "Email Soma about AI committee deck",
      "priority": "should",
      "effort": "easy",
      "notes": "quick thing"
    }
  ],
  "captures": [
    {
      "text": "I don't even know how to start the Mark situation",
      "kind": "reflection"
    }
  ]
}

No prose. No markdown. No code fences. Just the JSON.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = String(req.query?.action || 'parse').toLowerCase();

  if (action === 'transcribe') {
    return handleTranscribe(req, res);
  }
  return handleParse(req, res);
}

// ─── TRANSCRIBE (Whisper) ────────────────────────────────────────────
async function handleTranscribe(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Voice transcription not configured. Set OPENAI_API_KEY in Vercel env vars.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { audio, mimeType } = body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'Missing audio data' });
  }

  let audioBuffer;
  try {
    const cleanBase64 = audio.replace(/^data:audio\/\w+;base64,/, '');
    audioBuffer = Buffer.from(cleanBase64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Could not decode audio' });
  }

  if (audioBuffer.length > 25 * 1024 * 1024) {
    return res.status(413).json({ error: 'Audio file too large (max 25MB)' });
  }
  if (audioBuffer.length < 1000) {
    return res.status(400).json({ error: 'Audio is too short or empty' });
  }

  const ext = (() => {
    if (!mimeType) return 'webm';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'mp4';
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('ogg')) return 'ogg';
    return 'webm';
  })();

  try {
    const boundary = '----steddiFormBoundary' + Math.random().toString(36).slice(2);
    const CRLF = '\r\n';
    const head = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}` +
      `Content-Type: ${mimeType || 'audio/webm'}${CRLF}${CRLF}`
    );
    const middle = Buffer.from(
      `${CRLF}--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
      `whisper-1`
    );
    const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const formBody = Buffer.concat([head, audioBuffer, middle, tail]);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(formBody.length),
      },
      body: formBody,
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[transcribe] Whisper error:', j);
      return res.status(502).json({ error: j?.error?.message || 'Transcription service rejected request' });
    }

    return res.status(200).json({ text: j.text || '' });
  } catch (err) {
    console.error('[transcribe] fetch error:', err?.message);
    return res.status(500).json({ error: 'Transcription service unavailable' });
  }
}

// ─── PARSE (Claude) ──────────────────────────────────────────────────
async function handleParse(req, res) {

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY in Vercel env vars.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const text = String(body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 50_000) return res.status(413).json({ error: 'Input too long' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[dump-parse] Anthropic error:', j);
      return res.status(502).json({ error: j?.error?.message || 'AI service rejected request' });
    }

    const rawText = (j.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Strip potential code fences just in case Claude wrapped it
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[dump-parse] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(502).json({ error: 'Could not parse AI response' });
    }

    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({ error: 'Invalid AI response shape' });
    }

    // Sanitize and validate
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 50).map(t => ({
      text: String(t.text || '').slice(0, 280).trim(),
      priority: ['must', 'should', 'nice'].includes(t.priority) ? t.priority : 'should',
      effort: ['easy', 'hard'].includes(t.effort) ? t.effort : null,
      notes: t.notes ? String(t.notes).slice(0, 500).trim() : '',
    })).filter(t => t.text) : [];

    const captures = Array.isArray(parsed.captures) ? parsed.captures.slice(0, 20).map(c => ({
      text: String(c.text || '').slice(0, 500).trim(),
      kind: String(c.kind || 'note').slice(0, 30),
    })).filter(c => c.text) : [];

    return res.status(200).json({ tasks, captures });
  } catch (err) {
    console.error('[dump-parse] fetch error:', err?.message);
    return res.status(500).json({ error: 'AI service unavailable' });
  }
}
