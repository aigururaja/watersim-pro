/**
 * WaterSim Pro — Alarm evaluator
 *
 * Two layers:
 *
 *   PURE      — evaluateRules(rules, ctx) resolves each rule's current value
 *               from a result context and returns the breaches. No DB, no WS.
 *               Used directly by preview simulations (nothing persisted).
 *
 *   STATEFUL  — processEvaluation(...) runs the event state machine against
 *               alarm_events: a new breach INSERTs an 'active' event (and
 *               broadcasts 'alarm:event' transition 'raised'), a repeat breach
 *               only refreshes value/last_seen_at, and a rule that was
 *               evaluated clean while an active event exists flips it to
 *               'cleared' (broadcast transition 'cleared'). A later re-breach
 *               opens a NEW event.
 *
 * Value resolution (any ctx part may be missing — unresolvable rules are
 * skipped silently, e.g. a rule whose node was deleted from the canvas):
 *   'param'       → ctx.nodeParams[node_id][param_key]
 *   'node_output' → ctx.unitResults[node_id].outputs.effluent[param_key]
 *   'effluent'    → ctx.summary.effluent[param_key]
 *
 * Entry points:
 *   evaluateForRun(...)     — after a persisted simulation run (source 'simulation')
 *   evaluateParamValue(...) — per good PLC sample (source 'plc'); enabled
 *                             'param' rules are cached per flowsheet for ~10s
 *                             so the poller never pays a query per tick, and
 *                             an empty ruleset early-exits before any DB write.
 *
 * Nothing here ever throws out of the hot path — failures are logger.warn'd.
 */
'use strict';

const { query } = require('../db/pool');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const { buildNodeLabels } = require('./validTargets');
const logger = require('../utils/logger');

// ── After a transition: the maintenance workflow and the notification fan-out.
// Lazily required and fire-and-forget: an evaluation never waits on a task
// insert or an outbox write, and a failure there is logged, not raised.
function afterRaised(row, rule, flowsheetId) {
  setImmediate(async () => {
    try {
      const { emit } = require('../notifications');
      let task = null;
      if (rule.create_task) {
        const { createTaskFromEvent } = require('../maintenance/tasks');
        const r = await createTaskFromEvent(row, rule, { source: 'evaluator' });
        task = r.task;
      }
      await emit('alarm.raised', {
        orgId: row.organisation_id, severity: row.severity, flowsheetId,
        payload: { alarm: { id: row.id, ruleId: rule.id, ruleName: rule.name, kind: rule.kind, severity: row.severity, message: row.message, value: row.value, limitMin: row.limit_min, limitMax: row.limit_max, source: row.source, triggeredAt: row.triggered_at, nodeId: rule.node_id, paramKey: rule.param_key, tagId: rule.tag_id || null }, task },
        dedupeKey: `alarm.raised|${row.id}`,
      });
    } catch (err) {
      logger.warn('Post-raise hook failed', { eventId: row.id, err: err.message });
    }
  });
}

function afterCleared(row, rule, flowsheetId) {
  setImmediate(async () => {
    try {
      const { emit } = require('../notifications');
      await emit('alarm.cleared', {
        orgId: row.organisation_id, severity: row.severity, flowsheetId,
        payload: { alarm: { id: row.id, ruleName: rule?.name || null, message: row.message, clearedAt: row.cleared_at } },
        dedupeKey: `alarm.cleared|${row.id}`,
      });
    } catch (err) {
      logger.warn('Post-clear hook failed', { eventId: row.id, err: err.message });
    }
  });
}

const RULE_CACHE_TTL_MS = 10_000;

// flowsheetId -> { at, rules, nodeLabels } (enabled 'param' rules only)
const ruleCache = new Map();

// ── Pure layer ───────────────────────────────────────────────────────────────

/** Resolve the current value a rule targets, or undefined. */
function resolveTargetValue(rule, ctx) {
  if (!ctx) return undefined;
  switch (rule.target_type) {
    case 'param':       return ctx.nodeParams?.[rule.node_id]?.[rule.param_key];
    case 'node_output': return ctx.unitResults?.[rule.node_id]?.outputs?.effluent?.[rule.param_key];
    case 'effluent':    return ctx.summary?.effluent?.[rule.param_key];
    default:            return undefined;
  }
}

/** Breach test: above max or below min (whichever limits are set). */
function isBreach(rule, value) {
  return (rule.max_value != null && value > Number(rule.max_value))
      || (rule.min_value != null && value < Number(rule.min_value));
}

/** Compact human number: 52.1 stays "52.1", 3.14159265 → "3.14159". */
function fmt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : String(v);
}

/** Human message, e.g. "Effluent TN 52.1 exceeded max 10". */
function buildMessage(rule, value, nodeLabels = {}) {
  const subject = rule.target_type === 'effluent'
    ? `Effluent ${rule.param_key}`
    : rule.target_type === 'node_output'
      ? `${nodeLabels[rule.node_id] || rule.node_id} outflow ${rule.param_key}`
      : `${nodeLabels[rule.node_id] || rule.node_id} ${rule.param_key}`;
  if (rule.kind === 'quality') {
    // The value on a comms-loss event is seconds since the last good sample.
    const dark = Number.isFinite(Number(value)) ? `${fmt(value)} s` : 'an unknown time';
    return `${subject} comms lost — no good PLC sample for ${dark} (limit ${fmt(rule.stale_after_s)} s)`;
  }
  if (rule.kind === 'drift') {
    // The value on a drift event is the residual's z against its own history.
    return `${subject} model and plant disagree — residual z = ${fmt(value)} (limit ±${fmt(rule.max_value)})`;
  }
  if (rule.max_value != null && value > Number(rule.max_value)) {
    return `${subject} ${fmt(value)} exceeded max ${fmt(rule.max_value)}`;
  }
  if (rule.min_value != null && value < Number(rule.min_value)) {
    return `${subject} ${fmt(value)} below min ${fmt(rule.min_value)}`;
  }
  return `${subject} ${fmt(value)} outside limits`;
}

/**
 * PURE evaluation: which rules breach against this context?
 * @param {Array}  rules — alarm_rules rows
 * @param {object} ctx   — { nodeParams, unitResults, summary } (any may be missing)
 * @returns {Array<{rule, value}>}
 */
function evaluateRules(rules, ctx) {
  const breaches = [];
  for (const rule of rules || []) {
    const raw = resolveTargetValue(rule, ctx);
    const value = typeof raw === 'number' ? raw
      : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
    if (!Number.isFinite(value)) continue; // missing / orphaned node / non-numeric → skip silently
    if (isBreach(rule, value)) breaches.push({ rule, value });
  }
  return breaches;
}

// ── Stateful layer ───────────────────────────────────────────────────────────

function serializeEvent(row, ruleName = null) {
  return {
    id:           row.id,
    ruleId:       row.rule_id,
    ruleName,
    flowsheetId:  row.flowsheet_id,
    runId:        row.run_id,
    source:       row.source,
    state:        row.state,
    severity:     row.severity,
    message:      row.message,
    value:        row.value,
    limitMin:     row.limit_min,
    limitMax:     row.limit_max,
    triggeredAt:  row.triggered_at,
    lastSeenAt:   row.last_seen_at,
    clearedAt:    row.cleared_at,
    acknowledged: row.acknowledged,
  };
}

function broadcastEvent(flowsheetId, row, ruleName, transition) {
  try {
    const message = { type: 'alarm:event', payload: { event: serializeEvent(row, ruleName), transition } };
    broadcastToRoom(flowsheetId, message);
    broadcastToOrg(row.organisation_id, message);
  } catch (err) {
    logger.warn('Alarm broadcast failed', { flowsheetId, err: err.message });
  }
}

/**
 * Run the event state machine for one evaluation pass.
 *
 * Quality (comms-loss) rules are never part of a value evaluation: the run
 * and PLC entry points below exclude them, because a value pass that found
 * the rule "clean" would clear a comms-loss event that is still real. They
 * arrive here only from alarms/qualitySweep.js, with the seconds-dark as value.
 * @param {string} flowsheetId
 * @param {string} organisationId
 * @param {Array<{rule, value}>} breaches — from evaluateRules
 * @param {Array<string>} allRuleIds — every rule id that WAS evaluated this
 *        pass (a non-breached evaluated rule clears its active event)
 * @param {object} opts — { source: 'simulation'|'plc', runId, nodeLabels, rulesById }
 */
async function processEvaluation(flowsheetId, organisationId, breaches, allRuleIds, opts = {}) {
  const { source, runId = null, nodeLabels = {}, rulesById = {} } = opts;
  try {
    const ruleIds = (allRuleIds || []).map(String);
    if (!ruleIds.length) return;

    const active = await query(
      `SELECT * FROM alarm_events
       WHERE rule_id = ANY($1::uuid[]) AND organisation_id = $2 AND state = 'active'`,
      [ruleIds, organisationId]
    );
    const activeByRule = new Map(active.rows.map((e) => [e.rule_id, e]));

    const breachedRuleIds = new Set();
    for (const { rule, value } of breaches || []) {
      breachedRuleIds.add(rule.id);
      const existing = activeByRule.get(rule.id);
      if (existing) {
        // Still breaching — refresh only; no duplicate event, no broadcast.
        await query(
          `UPDATE alarm_events SET value = $1, last_seen_at = NOW() WHERE id = $2`,
          [value, existing.id]
        );
        continue;
      }
      const ins = await query(
        `INSERT INTO alarm_events
           (organisation_id, rule_id, flowsheet_id, run_id, source, state,
            severity, message, value, limit_min, limit_max)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10)
         ON CONFLICT (rule_id) WHERE state = 'active' DO NOTHING
         RETURNING *`,
        [organisationId, rule.id, flowsheetId, runId, source, rule.severity,
         buildMessage(rule, value, nodeLabels), value,
         rule.min_value != null ? rule.min_value : null,
         rule.max_value != null ? rule.max_value : null]
      );
      // One active event per rule is a database guarantee
      // (uq_alarm_events_one_active): a concurrent pass that raised it first
      // wins, and this pass simply does not broadcast a second 'raised'.
      if (!ins.rows[0]) continue;
      broadcastEvent(flowsheetId, ins.rows[0], rule.name, 'raised');
      afterRaised(ins.rows[0], rule, flowsheetId);
    }

    // Evaluated clean while an active event exists → recovery.
    for (const ruleId of ruleIds) {
      if (breachedRuleIds.has(ruleId)) continue;
      const existing = activeByRule.get(ruleId);
      if (!existing) continue;
      const upd = await query(
        `UPDATE alarm_events SET state = 'cleared', cleared_at = NOW(), last_seen_at = NOW()
         WHERE id = $1 AND state = 'active'
         RETURNING *`,
        [existing.id]
      );
      if (upd.rows[0]) {
        broadcastEvent(flowsheetId, upd.rows[0], rulesById[ruleId]?.name || null, 'cleared');
        afterCleared(upd.rows[0], rulesById[ruleId] || null, flowsheetId);
      }
    }
  } catch (err) {
    logger.warn('Alarm evaluation failed', { flowsheetId, source, err: err.message });
  }
}

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Evaluate every enabled rule of a flowsheet against a completed simulation
 * run's results (source 'simulation'). Fire-and-forget safe: never throws.
 */
async function evaluateForRun(flowsheetId, organisationId, results, config, runId) {
  try {
    const r = await query(
      `SELECT * FROM alarm_rules
       WHERE flowsheet_id = $1 AND organisation_id = $2 AND enabled = TRUE
         AND kind NOT IN ('quality', 'drift')`,
      [flowsheetId, organisationId]
    );
    if (!r.rows.length) return;

    const ctx = {
      nodeParams:  config?.nodeParams,
      unitResults: results?.unitResults,
      summary:     results?.summary,
    };
    const breaches = evaluateRules(r.rows, ctx);

    let nodeLabels = {};
    if (r.rows.some((rule) => rule.node_id)) {
      const f = await query(`SELECT canvas_data FROM flowsheets WHERE id = $1`, [flowsheetId]);
      nodeLabels = buildNodeLabels(f.rows[0]?.canvas_data);
    }

    await processEvaluation(flowsheetId, organisationId, breaches, r.rows.map((x) => x.id), {
      source: 'simulation',
      runId,
      nodeLabels,
      rulesById: Object.fromEntries(r.rows.map((x) => [x.id, x])),
    });
  } catch (err) {
    logger.warn('Alarm run evaluation failed', { flowsheetId, runId, err: err.message });
  }
}

/** Cached enabled 'param' rules (+ node labels) for a flowsheet (~10s TTL). */
async function getParamRules(flowsheetId, organisationId) {
  const hit = ruleCache.get(flowsheetId);
  if (hit && Date.now() - hit.at < RULE_CACHE_TTL_MS) return hit;

  const r = await query(
    `SELECT * FROM alarm_rules
     WHERE flowsheet_id = $1 AND organisation_id = $2 AND enabled = TRUE AND target_type = 'param'
       AND kind NOT IN ('quality', 'drift')`,
    [flowsheetId, organisationId]
  );
  let nodeLabels = {};
  if (r.rows.length) {
    const f = await query(`SELECT canvas_data FROM flowsheets WHERE id = $1`, [flowsheetId]);
    nodeLabels = buildNodeLabels(f.rows[0]?.canvas_data);
  }
  const entry = { at: Date.now(), rules: r.rows, nodeLabels };
  ruleCache.set(flowsheetId, entry);
  return entry;
}

/** Drop the cached ruleset (call after rule mutations); no arg clears all. */
function invalidateRuleCache(flowsheetId) {
  if (flowsheetId) ruleCache.delete(flowsheetId);
  else ruleCache.clear();
}

/**
 * Evaluate one good-quality PLC sample against matching enabled 'param'
 * rules (source 'plc'). An empty cached ruleset early-exits before any DB
 * write. Fire-and-forget safe: never throws.
 *
 * @param {object} binding — { flowsheetId, organisationId, nodeId, paramKey }
 * @param {number} value   — reported engineering-unit value
 */
async function evaluateParamValue(binding, value) {
  try {
    if (!binding || !Number.isFinite(value)) return;
    const { flowsheetId, organisationId, nodeId, paramKey } = binding;
    if (!flowsheetId || !organisationId) return;

    const cached = await getParamRules(flowsheetId, organisationId);
    if (!cached.rules.length) return; // cheap early-exit — nothing to evaluate, nothing written

    const matching = cached.rules.filter((r) => r.node_id === nodeId && r.param_key === paramKey);
    if (!matching.length) return;

    const breaches = matching.filter((r) => isBreach(r, value)).map((r) => ({ rule: r, value }));
    await processEvaluation(flowsheetId, organisationId, breaches, matching.map((r) => r.id), {
      source: 'plc',
      nodeLabels: cached.nodeLabels,
      rulesById: Object.fromEntries(matching.map((r) => [r.id, r])),
    });
  } catch (err) {
    logger.warn('Alarm PLC evaluation failed', { err: err.message });
  }
}

module.exports = {
  evaluateRules,
  buildMessage,
  processEvaluation,
  evaluateForRun,
  evaluateParamValue,
  invalidateRuleCache,
  _isBreach: isBreach,
};
