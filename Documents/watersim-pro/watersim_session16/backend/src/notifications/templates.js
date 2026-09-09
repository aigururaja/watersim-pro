/**
 * SafeKrit — Notification templates
 *
 * One function per event type, returning { subject, text, html }. `text` is
 * what WhatsApp and the in-app toast carry, so it must stand alone; `html` is
 * the same words in a light wrapper for email. No template ever reads a
 * field that might not be there — a missing task or alarm renders a shorter
 * message, not a crash in the outbox worker.
 */
'use strict';

const EVENT_TYPES = Object.freeze({
  'alarm.raised':      { label: 'Alarm raised',          hasSeverity: true,  desc: 'A limit was breached or a PLC point went quiet' },
  'alarm.cleared':     { label: 'Alarm cleared',         hasSeverity: true,  desc: 'The breach ended' },
  'task.created':      { label: 'Task created',          hasSeverity: true,  desc: 'A maintenance task was raised (by a rule or a person)' },
  'task.assigned':     { label: 'Task assigned',         hasSeverity: true,  desc: 'A task was assigned or reassigned — the assignee always hears this' },
  'task.completed':    { label: 'Task completed',        hasSeverity: true,  desc: 'The assignee finished; a manager may need to approve' },
  'task.approved':     { label: 'Task approved',         hasSeverity: true,  desc: 'A manager signed the work off' },
  'task.rejected':     { label: 'Task rejected',         hasSeverity: true,  desc: 'A manager sent the work back' },
  'task.acknowledged': { label: 'Critical task acknowledged', hasSeverity: true, desc: 'A manager acknowledged a critical alarm’s task' },
  'task.cancelled':    { label: 'Task cancelled',        hasSeverity: true,  desc: 'A task was cancelled' },
  'twin.drift':        { label: 'Twin drift',            hasSeverity: true,  desc: 'The model and the plant disagree beyond the threshold (Phase 4)' },
  'equipment.counters.daily': { label: 'Daily equipment counters', hasSeverity: false, desc: 'Run hours, starts and trips per drive for the day just ended (webhooks / CMMS)' },
  'notification.test': { label: 'Test message',          hasSeverity: false, desc: 'Sent from the notification settings page' },
});

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const SEV_WORD = { info: 'Info', warning: 'Warning', critical: 'CRITICAL' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { timeZone: process.env.NOTIFY_TZ || 'Asia/Kolkata', hour12: false }) : '');

function wrapHtml(title, lines, footer) {
  return `<!doctype html><html><body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111827;margin:0;padding:16px;background:#f9fafb">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px">
<div style="font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">SafeKrit</div>
<h2 style="margin:0 0 12px;font-size:17px;color:#1e40af">${esc(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 8px;line-height:1.45">${l}</p>`).join('\n')}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
<div style="font-size:12px;color:#6b7280">${esc(footer)}</div>
</div></body></html>`;
}

/**
 * @param {string} eventType
 * @param {object} ctx  { orgName, appUrl, severity, subject, payload }
 */
function render(eventType, ctx = {}) {
  const { orgName = 'SafeKrit', appUrl = '', severity = 'info', payload = {} } = ctx;
  const t = payload.task || null;
  const a = payload.alarm || null;
  const sev = SEV_WORD[severity] || 'Info';
  const footer = `${orgName} · sent by SafeKrit${appUrl ? ` · ${appUrl}` : ''}`;
  const taskLink = t && appUrl ? `${appUrl}/tasks?open=${t.id}` : null;

  const taskLines = () => [
    t ? `${t.number} · ${t.title}` : null,
    t?.priority ? `Priority: ${t.priority}${t.dueAt ? ` · due ${when(t.dueAt)}` : ''}` : null,
    t?.assignedToName ? `Assigned to: ${t.assignedToName}` : null,
    t?.description ? t.description : null,
    payload.note ? `Note: ${payload.note}` : null,
    taskLink ? `Open: ${taskLink}` : null,
  ].filter(Boolean);

  let subject; let lines;
  switch (eventType) {
    case 'alarm.raised':
      subject = `[${sev}] Alarm: ${a?.ruleName || a?.message || 'limit breached'}`;
      lines = [a?.message, a?.flowsheetName ? `Flowsheet: ${a.flowsheetName}` : null,
        a?.value != null ? `Value: ${a.value}` : null, `Raised: ${when(a?.triggeredAt || Date.now())}`,
        a?.source === 'plc' ? 'Source: live PLC data' : a?.source ? 'Source: simulation' : null].filter(Boolean);
      break;
    case 'alarm.cleared':
      subject = `[Cleared] ${a?.ruleName || a?.message || 'alarm'}`;
      lines = [a?.message, a?.flowsheetName ? `Flowsheet: ${a.flowsheetName}` : null, `Cleared: ${when(a?.clearedAt || Date.now())}`].filter(Boolean);
      break;
    case 'task.created':
      subject = `[${sev}] New task ${t?.number || ''}: ${t?.title || ''}`.trim();
      lines = taskLines();
      break;
    case 'task.assigned':
      subject = `Task ${t?.number || ''} assigned to you: ${t?.title || ''}`.trim();
      lines = taskLines();
      break;
    case 'task.completed':
      subject = `Task ${t?.number || ''} completed — approval needed: ${t?.title || ''}`.trim();
      lines = [...taskLines(), t?.completionNote ? `Completion note: ${t.completionNote}` : null].filter(Boolean);
      break;
    case 'task.approved':
      subject = `Task ${t?.number || ''} approved: ${t?.title || ''}`.trim();
      lines = [...taskLines(), t?.approvedByName ? `Approved by: ${t.approvedByName}` : null].filter(Boolean);
      break;
    case 'task.rejected':
      subject = `Task ${t?.number || ''} rejected — back to work: ${t?.title || ''}`.trim();
      lines = [...taskLines(), t?.rejectedReason ? `Reason: ${t.rejectedReason}` : null].filter(Boolean);
      break;
    case 'task.acknowledged':
      subject = `Critical alarm acknowledged by ${t?.acknowledgedByName || 'a manager'}: ${t?.title || ''}`.trim();
      lines = taskLines();
      break;
    case 'task.cancelled':
      subject = `Task ${t?.number || ''} cancelled: ${t?.title || ''}`.trim();
      lines = taskLines();
      break;
    case 'twin.drift':
      subject = `[${sev}] Twin drift on ${payload.tag || 'a tag'}`;
      lines = [payload.message, payload.residual != null ? `Residual ${payload.residual} (z ${payload.z})` : null].filter(Boolean);
      break;
    case 'notification.test':
      subject = 'SafeKrit test message';
      lines = [`This is a test from ${orgName}. If you can read it, this channel works.`, `Sent ${when(Date.now())}.`];
      break;
    default:
      subject = ctx.subject || eventType;
      lines = [payload.message || ''].filter(Boolean);
  }
  if (ctx.subject && !['alarm.raised', 'alarm.cleared', 'notification.test'].includes(eventType)) subject = `${subject}`; // keep computed
  const text = [subject, '', ...lines, '', footer].join('\n');
  const html = wrapHtml(subject, lines.map(esc), footer);
  return { subject, text, html };
}

module.exports = { render, EVENT_TYPES, SEVERITY_RANK };
