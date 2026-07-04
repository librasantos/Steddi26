// api/email.js — sends emails via Resend.com
// Setup: get free API key at resend.com → add RESEND_API_KEY to Vercel env vars
// Free tier: 100 emails/day, 3,000/month

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Steddi-Code',
  'Content-Type': 'application/json',
};

function safeError(res, status, msg) {
  return res.status(status).json({ error: msg });
}

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  return c.length >= 3 ? c : null;
}

function sanitizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.slice(0, 200) : null;
}

function sanitizeText(s, max = 500) {
  return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').slice(0, max).trim() : '';
}

// Email templates
function taskInviteEmail({ fromName, toName, taskText, taskDesc, dueDate, appUrl, code }) {
  const dueLine = dueDate
    ? `<p style="margin:0 0 8px;color:#666;font-size:14px;">📅 Due: <strong>${dueDate}</strong></p>`
    : '';
  const descLine = taskDesc
    ? `<div style="background:#F8F5F1;border-radius:10px;padding:12px 16px;margin:12px 0;font-size:14px;color:#444;line-height:1.7;white-space:pre-wrap;">${taskDesc}</div>`
    : '';

  return {
    subject: `${fromName} invited you to a task on Steddi 🐬`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FBF7F2;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#E07840;padding:28px 32px;text-align:center;">
      <div style="font-size:40px;margin-bottom:8px;">🐬</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:white;font-weight:400;">steddi</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px;">One thing at a time.</div>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 20px;font-size:17px;color:#1A1612;">Hey ${toName || 'there'}! 👋</p>
      <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
        <strong>${fromName}</strong> invited you to work on:
      </p>
      <div style="background:#FDF6F0;border-left:4px solid #E07840;border-radius:0 12px 12px 0;padding:16px 20px;margin:0 0 16px;">
        <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:18px;color:#1A1612;font-weight:400;">${taskText}</p>
        ${dueLine}
      </div>
      ${descLine}
      <a href="${appUrl}" style="display:inline-block;background:#E07840;color:white;text-decoration:none;padding:14px 28px;border-radius:50px;font-size:15px;font-weight:700;margin:20px 0;">Open Steddi →</a>
      ${code ? `<p style="margin:16px 0 0;font-size:13px;color:#999;">Family code: <strong style="color:#E07840;letter-spacing:2px;">${code.toUpperCase()}</strong></p>` : ''}
    </div>
    <div style="background:#F8F5F1;padding:16px 32px;text-align:center;font-size:12px;color:#AAA;">
      Sent from Steddi · <a href="${appUrl}" style="color:#E07840;text-decoration:none;">steddi app</a>
    </div>
  </div>
</body>
</html>`,
    text: `Hey ${toName || 'there'}!\n\n${fromName} invited you to work on:\n"${taskText}"${dueDate ? '\nDue: '+dueDate : ''}\n\nOpen Steddi: ${appUrl}\nFamily code: ${code ? code.toUpperCase() : ''}`,
  };
}

function activityEmail({ toEmail, toName, actorName, action, taskText, appUrl }) {
  return {
    subject: `${actorName} ${action} on Steddi`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FBF7F2;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#E07840;padding:24px 32px;text-align:center;">
      <div style="font-size:32px;">🐬</div>
      <div style="font-family:Georgia,serif;font-size:18px;color:white;">steddi</div>
    </div>
    <div style="padding:28px 32px;">
      <p style="margin:0 0 16px;font-size:16px;color:#1A1612;">
        <strong>${actorName}</strong> ${action}
        ${taskText ? `<br/><span style="color:#666;font-size:14px;">"${taskText}"</span>` : ''}
      </p>
      <a href="${appUrl}" style="display:inline-block;background:#E07840;color:white;text-decoration:none;padding:12px 24px;border-radius:50px;font-size:14px;font-weight:700;">View in Steddi →</a>
    </div>
  </div>
</body>
</html>`,
    text: `${actorName} ${action}${taskText ? '\n"'+taskText+'"' : ''}\n\nOpen Steddi: ${appUrl}`,
  };
}

// Morning reminder email — sent by the cron when user has scheduled tasks due today
function reminderEmail({ toName, tasks, intention, dateLabel, appUrl }) {
  const greeting = toName ? `Good morning, ${toName}` : 'Good morning';
  const taskList = tasks.map(t => {
    const timeBadge = t.time
      ? `<span style="font-size:12px;color:#E07840;font-weight:600;margin-right:8px;">${t.time}</span>`
      : '';
    const priorityColor = t.priority === 'must' ? '#E05C5C'
      : t.priority === 'should' ? '#E8A84A'
      : t.priority === 'nice' ? '#6BAA8E'
      : '#C4B6A0';
    return `<div style="padding:12px 16px;margin-bottom:8px;background:#FBF7F2;border-radius:12px;border-left:3px solid ${priorityColor};">
      ${timeBadge}<span style="font-size:15px;color:#1A1612;">${t.text}</span>
      ${t.description ? `<div style="font-size:12px;color:#8A7A6A;margin-top:6px;line-height:1.5;">${t.description}</div>` : ''}
    </div>`;
  }).join('');

  const taskPlain = tasks.map(t => `  • ${t.time ? t.time + ' — ' : ''}${t.text}`).join('\n');
  const intentionBlock = intention
    ? `<div style="background:#FDF6F0;border-left:4px solid #E07840;border-radius:0 12px 12px 0;padding:14px 18px;margin:0 0 20px;">
        <div style="font-size:11px;color:#E07840;font-weight:700;letterSpacing:1px;text-transform:uppercase;margin-bottom:4px;">Your intention</div>
        <div style="font-family:Georgia,serif;font-size:16px;color:#1A1612;font-style:italic;">"${intention}"</div>
      </div>`
    : '';

  return {
    subject: `Today on Steddi — ${tasks.length} scheduled ${tasks.length === 1 ? 'task' : 'tasks'} 🐬`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FBF7F2;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#E07840;padding:28px 32px;text-align:center;">
      <div style="font-size:40px;margin-bottom:8px;">🐬</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:white;font-weight:400;">${greeting}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px;">${dateLabel}</div>
    </div>
    <div style="padding:28px 32px;">
      ${intentionBlock}
      <div style="font-size:13px;color:#8A7A6A;margin-bottom:12px;letter-spacing:1px;text-transform:uppercase;font-weight:600;">On your plate today</div>
      ${taskList}
      <div style="text-align:center;margin-top:24px;">
        <a href="${appUrl}" style="display:inline-block;background:#E07840;color:white;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;">Open Steddi →</a>
      </div>
      <p style="font-size:12px;color:#AAA;margin:24px 0 0;text-align:center;line-height:1.6;">
        One thing at a time. You've got this. 🌿
      </p>
    </div>
    <div style="background:#F8F5F1;padding:14px 32px;text-align:center;font-size:11px;color:#AAA;">
      You're getting this because morning reminders are on.<br/>
      Turn them off anytime in Steddi Settings → Your data.
    </div>
  </div>
</body>
</html>`,
    text: `${greeting} — ${dateLabel}\n\n${intention ? 'Your intention: "' + intention + '"\n\n' : ''}On your plate today:\n${taskPlain}\n\nOpen Steddi: ${appUrl}\n\nTo stop these, visit Settings → Your data in Steddi.`,
  };
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return safeError(res, 405, 'Method not allowed');

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    // Return graceful degradation — app works without email
    return res.status(200).json({ ok: false, reason: 'Email not configured. Add RESEND_API_KEY to Vercel environment variables.' });
  }

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.body?.code);
  const { type, toEmail, toName, fromName, taskText, taskDesc, dueDate } = req.body || {};

  const to = sanitizeEmail(toEmail);
  if (!to) return safeError(res, 400, 'Invalid or missing email address');

  const appUrl = `https://${req.headers.host || 'steddi.app'}`;

  let emailData;
  if (type === 'invite') {
    emailData = taskInviteEmail({
      fromName: sanitizeText(fromName, 50) || 'Someone',
      toName: sanitizeText(toName, 50),
      taskText: sanitizeText(taskText, 200),
      taskDesc: sanitizeText(taskDesc, 500),
      dueDate: sanitizeText(dueDate, 30),
      appUrl,
      code,
    });
  } else if (type === 'activity') {
    emailData = activityEmail({
      toEmail: to,
      toName: sanitizeText(toName, 50),
      actorName: sanitizeText(fromName, 50) || 'Someone',
      action: sanitizeText(req.body?.action, 100),
      taskText: sanitizeText(taskText, 200),
      appUrl,
    });
  } else if (type === 'reminder') {
    emailData = reminderEmail({
      toName: sanitizeText(toName, 50),
      tasks: Array.isArray(req.body?.tasks) ? req.body.tasks.slice(0, 20) : [],
      intention: sanitizeText(req.body?.intention, 300),
      dateLabel: sanitizeText(req.body?.dateLabel, 60) || new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }),
      appUrl,
    });
  } else {
    return safeError(res, 400, 'Unknown email type');
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Steddi <onboarding@resend.dev>',
        to: [to],
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      }),
    });

    const json = await r.json();
    if (!r.ok) {
      console.error('[email] Resend error:', json);
      return safeError(res, 502, 'Email delivery failed');
    }

    return res.status(200).json({ ok: true, id: json.id });
  } catch (err) {
    console.error('[email] fetch error:', err?.message);
    return safeError(res, 500, 'Email service unavailable');
  }
}

// Server-to-server send — used by the reminder cron. Skips the HTTP layer.
// Returns { ok: true, id } on success, { ok: false, reason } on failure.
export async function sendReminderDirect({ toEmail, toName, tasks, intention, dateLabel, appUrl }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return { ok: false, reason: 'RESEND_API_KEY not set' };
  const to = sanitizeEmail(toEmail);
  if (!to) return { ok: false, reason: 'Invalid email' };
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, reason: 'No tasks to remind about' };

  const emailData = reminderEmail({
    toName: sanitizeText(toName, 50),
    tasks,
    intention: sanitizeText(intention, 300),
    dateLabel: dateLabel || new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }),
    appUrl: appUrl || 'https://steddi-olie.vercel.app',
  });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Steddi <onboarding@resend.dev>',
        to: [to],
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      }),
    });
    const json = await r.json();
    if (!r.ok) return { ok: false, reason: json?.message || 'Resend rejected' };
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Network error' };
  }
}
