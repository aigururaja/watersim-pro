/**
 * alarmState — pure helpers for configured alarm rules and their events.
 *
 * The sibling of `components/plc/plcState.js`: everything here is a pure
 * function over API payloads, so the canvas, the right-hand panel, the node
 * state machine and the org-wide page all agree without any of them owning
 * the logic.
 *
 * ── THE TWO PAYLOAD SHAPES ───────────────────────────────────────────────────
 * The backend serves alarm data in two casings, and both reach this module:
 *
 *   snake_case  GET /projects/:p/flowsheets/:f/alarms       (raw alarm_rules rows)
 *               GET /projects/:p/flowsheets/:f/alarm-events (raw alarm_events rows
 *                                                            + joined rule_name)
 *   camelCase   GET /alarms/events                          (formatEvent)
 *               WS  alarm:event                             (serializeEvent)
 *               POST simulate (preview)  → `alarms: [...]`  (previewAlarmBreaches)
 *
 * Every reader here accepts BOTH, and `normalizeEvent` converts to the camelCase
 * shape once so nothing downstream has to ask which endpoint an event came from.
 *
 * ── WHAT NEVER HAPPENS HERE ──────────────────────────────────────────────────
 * Nothing in this module is ever written into `node.data` or `params`.
 * `node.data` is saved to the DB, JSON.stringify'd by the collab `sendEvent`
 * and hashed by `liveSignature` — an alarm severity stashed there would be
 * persisted, broadcast, and would retrigger the simulation on every event.
 * Configured-alarm severity reaches the cards through `NodeAlarmContext`
 * (nodeReadouts.js) instead, exactly like the AlarmFloodContext flag.
 */

import { Info, AlertTriangle, AlertOctagon } from 'lucide-react';

const EMPTY_ARR = Object.freeze([]);

// ═══════════════════════════════════════════════════════════════════════════
// 1. SEVERITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The three severities the backend accepts, with the tokens every alarm
 * affordance paints from. `rank` is the ONLY ordering — never array position.
 *
 * The colours deliberately reuse the canvas state tokens: a critical alarm is
 * the same red as the card ring (`--ws-alarm`) and a warning the same amber as
 * the watch ring (`--ws-watch`), so a rule breaching on the canvas and the same
 * rule listed in a table read as one thing.
 */
export const SEVERITY = Object.freeze({
  info: Object.freeze({
    key: 'info', label: 'Info', rank: 1, icon: Info,
    color: '#0369A1', bg: '#E0F2FE', border: '#7DD3FC',
  }),
  warning: Object.freeze({
    key: 'warning', label: 'Warning', rank: 2, icon: AlertTriangle,
    color: 'var(--ws-watch, #D97706)', bg: '#FEF3C7', border: '#FCD34D',
  }),
  critical: Object.freeze({
    key: 'critical', label: 'Critical', rank: 3, icon: AlertOctagon,
    color: 'var(--ws-alarm, #DC2626)', bg: '#FEE2E2', border: '#FCA5A5',
  }),
});

/** Ascending by rank — the order the severity <select> and the filters use. */
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

/** Meta for a severity string; unknown/missing falls back to `warning` (the API default). */
export const severityMeta = (s) => SEVERITY[s] || SEVERITY.warning;

/** @returns {number} 0 for an unknown severity, so it never outranks a real one. */
export const severityRank = (s) => (SEVERITY[s] ? SEVERITY[s].rank : 0);

/** The worse of two severities (either may be null/unknown). */
export function worseSeverity(a, b) {
  if (!SEVERITY[a]) return SEVERITY[b] ? b : null;
  if (!SEVERITY[b]) return a;
  return severityRank(a) >= severityRank(b) ? a : b;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. TARGET IDENTITY — how a rule and a target recognise each other
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `${targetType}|${nodeId ?? ''}|${paramKey}`.
 *
 * An `effluent` rule carries node_id NULL (a schema constraint), and a target
 * from GET /alarm-targets carries `nodeId: null` for the same rows — both
 * collapse to the empty segment, so the two sides match without either having
 * to know how the other spells "no node".
 *
 * Accepts either casing so a target (camelCase) and a rule row (snake_case)
 * produce the same string.
 */
export function targetKey(t) {
  if (!t) return '';
  const type = t.targetType ?? t.target_type ?? '';
  const node = t.nodeId ?? t.node_id ?? '';
  const param = t.paramKey ?? t.param_key ?? '';
  return `${type}|${node ?? ''}|${param}`;
}

/** The same key for an alarm_rules row. `ruleKey(rule) === targetKey(target)` matches them. */
export const ruleKey = targetKey;

/** Rules keyed by their target, so a param row can ask "is there a rule on me?" in O(1). */
export function rulesByTarget(rules) {
  const out = new Map();
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r) out.set(ruleKey(r), r);
  }
  return out;
}

/** Rules keyed by id — the join an event needs to find its node. */
export function rulesById(rules) {
  const out = new Map();
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r && r.id != null) out.set(String(r.id), r);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DESCRIBING A RULE IN WORDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Units for the Stream quality fields (src/simulation/stream.js). Only the
 * quality targets have a knowable unit — a `param` target is a model parameter
 * whose unit lives in the param definition, not in the rule, so describeRule
 * prints no unit for those rather than guessing a wrong one.
 */
const STREAM_UNITS = Object.freeze({
  Q: 'm³/d', TSS: 'mg/L', BOD: 'mg/L', COD: 'mg/L', TN: 'mg/L', NH4: 'mg/L',
  NO3: 'mg/L', NO2: 'mg/L', TP: 'mg/L', DO: 'mg/L', pH: '', temp: '°C',
});

/** Compact human number — 52.1 stays "52.1", 3.14159265 → "3.14159" (mirrors the backend). */
export function fmtLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return String(Number(n.toPrecision(6)));
}

/**
 * The subject half of a rule sentence — deliberately IDENTICAL to the backend's
 * `buildMessage()` subject, so "Effluent TN above 10 mg/L" (the rule) and
 * "Effluent TN 52.1 exceeded max 10" (its event) name the same thing the
 * same way.
 */
export function describeTarget(rule, nodeLabels) {
  if (!rule) return '';
  const type = rule.targetType ?? rule.target_type;
  const nodeId = rule.nodeId ?? rule.node_id;
  const param = rule.paramKey ?? rule.param_key ?? '';
  const label = (nodeLabels && (nodeLabels.get ? nodeLabels.get(nodeId) : nodeLabels[nodeId])) || nodeId;
  if (type === 'effluent') return `Effluent ${param}`;
  if (type === 'node_output') return `${label} outflow ${param}`;
  return `${label} ${param}`;
}

/**
 * A rule as one readable sentence: "Effluent TN above 10 mg/L".
 *
 * @param {object} rule       alarm_rules row (either casing)
 * @param {Map|object} [nodeLabels] nodeId → label; falls back to the raw id
 * @returns {string}
 */
export function describeRule(rule, nodeLabels) {
  if (!rule) return '';
  const subject = describeTarget(rule, nodeLabels);
  const param = rule.paramKey ?? rule.param_key ?? '';
  const type = rule.targetType ?? rule.target_type;
  const min = rule.minValue ?? rule.min_value;
  const max = rule.maxValue ?? rule.max_value;
  const unit = type === 'param' ? '' : (STREAM_UNITS[param] ?? '');
  const suffix = unit ? ` ${unit}` : '';

  const hasMin = min != null && Number.isFinite(Number(min));
  const hasMax = max != null && Number.isFinite(Number(max));

  if (hasMin && hasMax) return `${subject} outside ${fmtLimit(min)}–${fmtLimit(max)}${suffix}`;
  if (hasMax) return `${subject} above ${fmtLimit(max)}${suffix}`;
  if (hasMin) return `${subject} below ${fmtLimit(min)}${suffix}`;
  // The API refuses to store a rule with neither limit; this is the shape of a
  // half-typed draft in the dialog, not of anything the server ever returns.
  return `${subject} — no limit set`;
}

/**
 * The footer chip text for a card carrying a configured alarm. The chip is a
 * 9px mono badge with room for about fourteen characters, so a long rule name
 * is truncated rather than allowed to break the 168 x 116 card geometry — the
 * full name still rides along as `reason` for the title attribute.
 */
export function ruleChip(name, max = 14) {
  const s = String(name ?? '').trim().toUpperCase();
  if (!s) return 'ALARM';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. EVENTS
// ═══════════════════════════════════════════════════════════════════════════

const firstDefined = (...vals) => {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
};

/**
 * One event shape from any of the four producers (see the header).
 * Unknown extra fields are preserved so a caller that knows more than this
 * module does (the org-wide page reads projectName) is never truncated.
 */
export function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const id = firstDefined(e.id);
  if (id == null) return null;
  return {
    ...e,
    id: String(id),
    ruleId: firstDefined(e.ruleId, e.rule_id) ?? null,
    ruleName: firstDefined(e.ruleName, e.rule_name) ?? null,
    flowsheetId: firstDefined(e.flowsheetId, e.flowsheet_id) ?? null,
    runId: firstDefined(e.runId, e.run_id) ?? null,
    source: e.source ?? null,
    state: e.state ?? 'active',
    severity: e.severity ?? 'warning',
    message: e.message ?? '',
    value: firstDefined(e.value) ?? null,
    limitMin: firstDefined(e.limitMin, e.limit_min) ?? null,
    limitMax: firstDefined(e.limitMax, e.limit_max) ?? null,
    triggeredAt: firstDefined(e.triggeredAt, e.triggered_at) ?? null,
    lastSeenAt: firstDefined(e.lastSeenAt, e.last_seen_at) ?? null,
    clearedAt: firstDefined(e.clearedAt, e.cleared_at) ?? null,
    acknowledged: firstDefined(e.acknowledged) ?? false,
    acknowledgedAt: firstDefined(e.acknowledgedAt, e.acknowledged_at) ?? null,
    acknowledgedByName: firstDefined(e.acknowledgedByName, e.acknowledged_by_name) ?? null,
  };
}

/** ms since epoch for sorting; a missing/unparsable timestamp sorts oldest. */
const stamp = (v) => {
  if (v == null) return 0;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/**
 * An event carries a ruleId but never a nodeId — which node lit up is a
 * property of the RULE. This copies the target across so the node state
 * machine can key by node without re-joining on every render.
 */
function withTarget(event, byId) {
  if (!event) return event;
  if (event.nodeId !== undefined && event.targetType !== undefined) return event;
  const rule = byId && event.ruleId != null ? byId.get(String(event.ruleId)) : null;
  if (!rule) return event;
  return {
    ...event,
    nodeId: event.nodeId ?? rule.node_id ?? rule.nodeId ?? null,
    targetType: event.targetType ?? rule.target_type ?? rule.targetType ?? null,
    paramKey: event.paramKey ?? rule.param_key ?? rule.paramKey ?? null,
    ruleName: event.ruleName ?? rule.name ?? null,
  };
}

/** Default cap on the in-memory live feed — old events fall off the bottom. */
export const EVENT_FEED_CAP = 200;

/**
 * The live-feed reducer for `alarm:event` (and for seeding from a GET).
 *
 *   raised  — inserts the event, or REPLACES the row with the same id when the
 *             evaluator refreshes one that is still breaching
 *   cleared — updates the matching row's state/clearedAt in place; an unseen
 *             cleared event is still inserted, because a client that joined
 *             late must not be told an alarm is active by its absence
 *
 * Newest first by triggeredAt, capped, and — like `mergePlcValues` — returns
 * `existing` UNCHANGED (same reference) when nothing merged, so a no-op
 * websocket frame never re-renders the canvas.
 *
 * @param {Array}  existing     current feed (normalized)
 * @param {Array|object} incoming  event(s), each either a raw event or an
 *                                 `{ event, transition }` envelope
 * @param {object} [opts]
 * @param {number} [opts.cap]      max rows kept (default EVENT_FEED_CAP)
 * @param {Map}    [opts.rulesById] rule lookup used to attach the target
 * @returns {Array}
 */
export function mergeAlarmEvents(existing, incoming, { cap = EVENT_FEED_CAP, rulesById: byId } = {}) {
  const base = Array.isArray(existing) ? existing : EMPTY_ARR;
  const list = Array.isArray(incoming) ? incoming : (incoming ? [incoming] : EMPTY_ARR);
  if (!list.length) return base;

  let next = null;          // copied lazily — no change, no new reference
  const indexOf = (id) => (next || base).findIndex((e) => e && e.id === id);

  for (const raw of list) {
    if (!raw) continue;
    // Accept both the WS envelope and a bare event row.
    const envelope = raw.event && typeof raw.event === 'object' ? raw : null;
    const event = normalizeEvent(envelope ? envelope.event : raw);
    if (!event) continue;

    const transition = envelope?.transition;
    // An explicit `cleared` transition wins over whatever state the row carries,
    // so a race between the UPDATE and its broadcast can't resurrect an alarm.
    const merged = withTarget(
      transition === 'cleared'
        ? { ...event, state: 'cleared', clearedAt: event.clearedAt ?? new Date().toISOString() }
        : event,
      byId
    );

    const at = indexOf(merged.id);
    if (at >= 0) {
      const prev = (next || base)[at];
      // Nothing actually moved — don't dirty the array for a duplicate frame.
      if (prev.state === merged.state
        && prev.severity === merged.severity
        && prev.acknowledged === merged.acknowledged
        && prev.lastSeenAt === merged.lastSeenAt
        && prev.clearedAt === merged.clearedAt) continue;
      if (!next) next = base.slice();
      next[at] = { ...prev, ...merged };
    } else {
      if (!next) next = base.slice();
      next.unshift(merged);
    }
  }

  if (!next) return base;
  next.sort((a, b) => stamp(b.triggeredAt) - stamp(a.triggeredAt));
  return next.length > cap ? next.slice(0, cap) : next;
}

/** True for an event that has not cleared. */
export const isActiveEvent = (e) => !!e && e.state !== 'cleared';

/**
 * The newest ACTIVE event per rule — what the per-parameter bell and the rule
 * list both read to decide whether a rule is currently breaching.
 * @returns {Map<string, object>} ruleId → event
 */
export function activeByRuleId(events) {
  const out = new Map();
  for (const e of Array.isArray(events) ? events : EMPTY_ARR) {
    if (!isActiveEvent(e) || e.ruleId == null) continue;
    const key = String(e.ruleId);
    const prev = out.get(key);
    if (!prev || stamp(e.triggeredAt) > stamp(prev.triggeredAt)) out.set(key, e);
  }
  return out;
}

/** How many rules are currently breaching (not how many event rows exist). */
export const activeAlarmCount = (events) => activeByRuleId(events).size;

/**
 * Worst ACTIVE severity per node — the input the card state machine takes.
 *
 * Cleared events are ignored entirely: a plant that fixed its nitrogen an hour
 * ago must not still be painted red, and the event history keeps the record.
 * Plant-effluent rules carry no node and are therefore absent from the map by
 * construction (the outlet node's own `permit_violations` already covers that
 * card intrinsically).
 *
 * @param {Array} events   normalized events (nodeId attached, or resolvable)
 * @param {Map}   [byId]   rulesById lookup, when the events lack their target
 * @returns {Map<string, {severity: string, ruleName: string, eventId: string}>}
 */
export function worstSeverityByNode(events, byId) {
  const out = new Map();
  for (const raw of Array.isArray(events) ? events : EMPTY_ARR) {
    if (!isActiveEvent(raw)) continue;
    const e = withTarget(raw, byId);
    const nodeId = e.nodeId;
    if (nodeId == null || nodeId === '') continue;
    const prev = out.get(nodeId);
    if (!prev || severityRank(e.severity) > severityRank(prev.severity)) {
      out.set(nodeId, {
        severity: SEVERITY[e.severity] ? e.severity : 'warning',
        ruleName: e.ruleName || 'Alarm',
        eventId: e.id,
      });
    }
  }
  return out;
}

/**
 * The same map for the PREVIEW breaches a simulate response carries
 * (`data.alarms`). These have never been persisted — they are what WOULD fire
 * on the values currently on screen — so they are kept in their own map and
 * never merged into the event feed.
 * @returns {Map<string, object>} ruleId → preview breach
 */
export function previewByRuleId(alarms) {
  const out = new Map();
  for (const a of Array.isArray(alarms) ? alarms : EMPTY_ARR) {
    if (a && a.ruleId != null) out.set(String(a.ruleId), a);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. TIME
// ═══════════════════════════════════════════════════════════════════════════

/** Compact relative time — 'just now', '3m ago', '2h ago', else a date. */
export function relTime(ts, now = Date.now()) {
  if (ts == null) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';           // clock skew must not print "-4s ago"
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Full local timestamp for the title attribute beside the relative one. */
export function absTime(ts) {
  if (ts == null) return '—';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. CLIENT-SIDE LIMIT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The SAME check `limitError()` runs in backend/src/routes/alarms.js, so the
 * dialog can refuse an impossible rule before the round trip. The server stays
 * the authority — its message is still surfaced verbatim when it disagrees.
 *
 * @returns {string|null} the reason it is unusable, or null when it is fine
 */
export function limitError(minValue, maxValue) {
  const hasMin = minValue != null && minValue !== '' && Number.isFinite(Number(minValue));
  const hasMax = maxValue != null && maxValue !== '' && Number.isFinite(Number(maxValue));
  if (!hasMin && !hasMax) return 'At least one of minValue / maxValue must be a finite number';
  if (hasMin && hasMax && Number(minValue) >= Number(maxValue)) return 'minValue must be less than maxValue';
  return null;
}

/**
 * The verbatim server message for a rejected save.
 *
 * The 422 body is `{ error: 'Validation failed', details: [{ msg, path }] }` and
 * the useful sentence is in `details[].msg` — "'chamberType' is not a numeric
 * parameter of a Grit Chamber (valid: HRT_min)". These messages are written to
 * be read by users, so they are shown as-is and never replaced with a generic
 * "save failed".
 */
export function serverErrorMessage(err, fallback = 'Save failed') {
  const data = err?.response?.data;
  if (data) {
    if (Array.isArray(data.details) && data.details.length) {
      const msgs = data.details.map((d) => d?.msg).filter(Boolean);
      if (msgs.length) return msgs.join(' · ');
    }
    if (typeof data.error === 'string' && data.error) return data.error;
  }
  return err?.message || fallback;
}
