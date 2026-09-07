/**
 * WaterSim Pro — Outbox worker
 *
 * Drains notification_outbox: claims due rows with SKIP LOCKED (so a second
 * process could run alongside), hands each to its channel adapter, and marks
 * it sent — or schedules a retry with exponential backoff (30 s, 60 s, 2 min
 * … capped at 1 h) up to MAX_ATTEMPTS, after which the row is 'dead' and
 * visible as such on the settings page, where a manager can retry it once
 * the provider is fixed. A permanent error (bad address, channel not
 * configured) goes straight to 'dead': retrying cannot help.
 *
 * In-process on the reaper pattern; no-op under NODE_ENV=test unless forced.
 */
'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');
const email = require('./adapters/email');
const whatsapp = require('./adapters/whatsapp');
const webhook = require('./adapters/webhook');

const ADAPTERS = { email, whatsapp, webhook };
const INTERVAL_MS = Math.max(1000, parseInt(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS || '5000', 10) || 5000);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.NOTIFICATIONS_MAX_ATTEMPTS || '8', 10) || 8);
const BATCH = 25;
const DUE_SLACK_MS = 1000;

let timer = null;
let running = false;

const backoffMs = (attempt) => Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
const asObject = (p) => (p && typeof p === 'object' ? p : (() => { try { return JSON.parse(p || '{}'); } catch { return {}; } })());

/**
 * Claim due rows (or one specific row) and mark them 'sending'.
 * A row is due when EITHER clock says so: the database's NOW() — the clock
 * that stamps DEFAULT next_attempt_at and a manual retry — or this process's,
 * with a second of slack. The two are not the same clock on SQLite (a default
 * can round a millisecond ahead of Date.now(); a monotonic NOW() can run ahead
 * of wall time after a burst of writes), and judging by one alone left a row
 * inserted and drained in the same instant unclaimed, silently. On Postgres
 * NOW() is the server's time, the same clock as the default.
 */
async function claim({ onlyId = null, limit = BATCH } = {}) {
  const due = new Date(Date.now() + DUE_SLACK_MS);
  const { rows } = await query(
    `UPDATE notification_outbox AS o SET state = 'sending', attempts = o.attempts + 1
      WHERE o.id IN (
        SELECT id FROM notification_outbox
         WHERE state IN ('pending', 'failed') AND (next_attempt_at <= NOW() OR next_attempt_at <= $2) ${onlyId ? 'AND id = $3' : ''}
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    onlyId ? [limit, due, onlyId] : [limit, due]
  );
  return rows;
}

async function deliver(row) {
  const adapter = ADAPTERS[row.channel];
  if (!adapter) {
    await query(`UPDATE notification_outbox SET state = 'dead', last_error = $2 WHERE id = $1`, [row.id, `No adapter for channel ${row.channel}`]);
    return 'dead';
  }
  try {
    const result = await adapter.send({
      address: row.address, subject: row.subject, body: row.body, payload: row.payload,
      eventType: row.event_type, template: row.template, id: row.id, endpointId: row.endpoint_id || null,
    });
    const { providerId, provider, kind, waTemplate } = result || {};
    // Merged here, not in SQL, so the statement reads the same on Postgres and SQLite.
    const payload = { ...asObject(row.payload), providerId, ...(provider ? { provider } : {}), ...(kind ? { kind } : {}), ...(waTemplate ? { waTemplate } : {}) };
    await query(
      `UPDATE notification_outbox SET state = 'sent', sent_at = NOW(), last_error = NULL, payload = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify(payload)]
    );
    return 'sent';
  } catch (err) {
    const dead = err.permanent || row.attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE notification_outbox SET state = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1`,
      [row.id, dead ? 'dead' : 'failed', String(err.message).slice(0, 1000), new Date(Date.now() + backoffMs(row.attempts))]
    );
    if (dead) logger.warn('Notification dead', { id: row.id, channel: row.channel, err: err.message });
    return dead ? 'dead' : 'failed';
  }
}

/** One pass. Returns counts. Exported for tests and for the settings page's "send test". */
async function drain(opts = {}) {
  const out = { claimed: 0, sent: 0, failed: 0, dead: 0 };
  let rows;
  try { rows = await claim(opts); } catch (err) { logger.warn('Outbox claim failed', { err: err.message }); return out; }
  out.claimed = rows.length;
  for (const row of rows) {
    const r = await deliver(row);
    out[r] += 1;
  }
  return out;
}

/** Reset a dead/failed row so the next pass retries it now. */
async function retry(id, orgId) {
  const { rows } = await query(
    `UPDATE notification_outbox SET state = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
      WHERE id = $1 AND organisation_id = $2 AND state IN ('failed', 'dead') RETURNING id`,
    [id, orgId]
  );
  return !!rows[0];
}

function providerStatus() {
  return {
    email: email.configured(),
    whatsapp: whatsapp.configured(),
    webhook: webhook.configured(),
    dryRun: String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true',
  };
}

function startNotificationWorker({ force = false, intervalMs = INTERVAL_MS } = {}) {
  if (timer) return;
  if (process.env.NODE_ENV === 'test' && !force) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await drain(); } catch (err) { logger.error('Outbox worker failed', { error: err.message }); } finally { running = false; }
  }, intervalMs);
  timer.unref();
  logger.info('Notification worker started', { intervalMs, providers: providerStatus() });
}

function stopNotificationWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { drain, retry, providerStatus, startNotificationWorker, stopNotificationWorker, ADAPTERS, MAX_ATTEMPTS, _backoffMs: backoffMs };
