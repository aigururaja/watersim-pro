/**
 * alarmState — the pure layer under every alarm affordance.
 *
 * These are the invariants the canvas, the panel, the bells and the org-wide
 * page all lean on. Two in particular are load-bearing and easy to break later:
 *
 *   · targetKey(target) === ruleKey(rule) for the same target, ACROSS the two
 *     casings the backend serves (camelCase targets, snake_case rule rows). If
 *     that ever stops holding, every bell silently goes back to "no rule" and a
 *     user creates duplicates until the server 409s.
 *   · worstSeverityByNode ignores CLEARED events. If it stops, a plant that was
 *     fixed an hour ago stays painted red for the rest of the session.
 */
import { describe, it, expect } from 'vitest';
import {
  SEVERITY, SEVERITIES, severityMeta, severityRank, worseSeverity,
  targetKey, ruleKey, rulesByTarget, rulesById,
  describeRule, describeTarget, ruleChip, fmtLimit,
  normalizeEvent, mergeAlarmEvents, EVENT_FEED_CAP,
  activeByRuleId, activeAlarmCount, previewByRuleId, worstSeverityByNode,
  relTime, absTime, limitError, serverErrorMessage, isActiveEvent,
} from '../components/alarms/alarmState';

// ── Fixtures, in the exact shapes the API serves ─────────────────────────────

/** GET /alarm-targets row (camelCase). */
const target = (over = {}) => ({
  targetType: 'param', nodeId: 'n2', nodeLabel: 'Grit Chamber',
  paramKey: 'HRT_min', label: 'Grit Chamber · HRT_min', kind: 'parameter', ...over,
});

/** alarm_rules row (snake_case, as GET /alarms returns it). */
const rule = (over = {}) => ({
  id: 'r1', name: 'Effluent nitrogen over permit',
  target_type: 'effluent', node_id: null, param_key: 'TN',
  min_value: null, max_value: 10, severity: 'critical', enabled: true, ...over,
});

/** alarm_events row from the WS / org endpoint (camelCase). */
const event = (over = {}) => ({
  id: 'e1', ruleId: 'r1', ruleName: 'Effluent nitrogen over permit',
  flowsheetId: 'f1', source: 'simulation', state: 'active', severity: 'critical',
  message: 'Effluent TN 52.85 exceeded max 10', value: 53.07,
  limitMin: null, limitMax: 10,
  triggeredAt: '2026-09-04T03:31:30.785Z', lastSeenAt: '2026-09-04T04:18:03.155Z',
  clearedAt: null, acknowledged: false, ...over,
});

// ── Severity ────────────────────────────────────────────────────────────────

describe('severity meta', () => {
  it('exposes the three server severities in ascending rank', () => {
    expect(SEVERITIES).toEqual(['info', 'warning', 'critical']);
    expect(SEVERITIES.map(severityRank)).toEqual([1, 2, 3]);
    expect(Object.keys(SEVERITY)).toEqual(['info', 'warning', 'critical']);
  });

  it('gives every severity a label, colours and an icon', () => {
    for (const s of SEVERITIES) {
      const m = severityMeta(s);
      expect(m.label).toBeTruthy();
      expect(m.color).toBeTruthy();
      expect(m.bg).toBeTruthy();
      expect(m.icon).toBeTruthy();
    }
  });

  it('falls back to warning (the API default) for an unknown severity', () => {
    expect(severityMeta('meltdown').key).toBe('warning');
    expect(severityMeta(undefined).key).toBe('warning');
    // …but an unknown severity never OUTRANKS a real one.
    expect(severityRank('meltdown')).toBe(0);
  });

  it('worseSeverity picks the higher rank and tolerates nulls', () => {
    expect(worseSeverity('info', 'critical')).toBe('critical');
    expect(worseSeverity('critical', 'warning')).toBe('critical');
    expect(worseSeverity(null, 'info')).toBe('info');
    expect(worseSeverity('warning', null)).toBe('warning');
    expect(worseSeverity(null, null)).toBe(null);
  });
});

// ── Target identity ─────────────────────────────────────────────────────────

describe('targetKey / ruleKey', () => {
  it('matches a camelCase target to the snake_case rule on it', () => {
    const t = target();
    const r = rule({ target_type: 'param', node_id: 'n2', param_key: 'HRT_min' });
    expect(targetKey(t)).toBe('param|n2|HRT_min');
    expect(ruleKey(r)).toBe(targetKey(t));
  });

  it('collapses a null node to the same empty segment on both sides', () => {
    // An effluent rule carries node_id NULL (a schema constraint); the matching
    // target row carries nodeId: null. Neither side has to know how the other
    // spells "no node".
    expect(targetKey({ targetType: 'effluent', nodeId: null, paramKey: 'TN' }))
      .toBe(ruleKey(rule()));
    expect(ruleKey(rule())).toBe('effluent||TN');
  });

  it('keeps the three target types apart on the same node and param', () => {
    const keys = ['param', 'node_output'].map(tt =>
      targetKey({ targetType: tt, nodeId: 'n1', paramKey: 'Q' }));
    keys.push(targetKey({ targetType: 'effluent', nodeId: null, paramKey: 'Q' }));
    expect(new Set(keys).size).toBe(3);
  });

  it('rulesByTarget / rulesById index the same rows two ways', () => {
    const rows = [rule(), rule({ id: 'r2', target_type: 'param', node_id: 'n2', param_key: 'HRT_min' })];
    const byTarget = rulesByTarget(rows);
    const byId = rulesById(rows);
    expect(byTarget.get('effluent||TN').id).toBe('r1');
    expect(byTarget.get(targetKey(target())).id).toBe('r2');
    expect(byId.get('r1').name).toBe('Effluent nitrogen over permit');
    expect(byId.size).toBe(2);
  });

  it('survives a null/garbage input without throwing', () => {
    expect(targetKey(null)).toBe('');
    expect(rulesByTarget(null).size).toBe(0);
    expect(rulesById(undefined).size).toBe(0);
  });
});

// ── describeRule ────────────────────────────────────────────────────────────

describe('describeRule', () => {
  it('reads as an English sentence with the stream unit', () => {
    expect(describeRule(rule())).toBe('Effluent TN above 10 mg/L');
  });

  it('says "below" for a min-only rule and names the window for both', () => {
    expect(describeRule(rule({ max_value: null, min_value: 6.5, param_key: 'pH' })))
      .toBe('Effluent pH below 6.5');           // pH is unitless — no trailing unit
    expect(describeRule(rule({ min_value: 6.5, max_value: 8, param_key: 'pH' })))
      .toBe('Effluent pH outside 6.5–8');
  });

  it('names the node for node-scoped targets, using the label map', () => {
    const labels = { n3: 'Aeration Basin' };
    expect(describeRule(
      rule({ target_type: 'node_output', node_id: 'n3', param_key: 'NH4', max_value: 5 }), labels
    )).toBe('Aeration Basin outflow NH4 above 5 mg/L');
    expect(describeRule(
      rule({ target_type: 'param', node_id: 'n3', param_key: 'SRT_d', max_value: 20 }), labels
    )).toBe('Aeration Basin SRT_d above 20');    // a model param has no known unit
  });

  it('falls back to the raw node id when no label is known', () => {
    expect(describeRule(rule({ target_type: 'param', node_id: 'n9', param_key: 'SRT_d', max_value: 5 })))
      .toBe('n9 SRT_d above 5');
  });

  it('accepts camelCase rules too (a POST response, a draft in the dialog)', () => {
    expect(describeRule({ targetType: 'effluent', paramKey: 'TSS', maxValue: 30 }))
      .toBe('Effluent TSS above 30 mg/L');
  });

  it('describeTarget matches the backend message subject exactly', () => {
    // buildMessage() in backend/src/alarms/evaluator.js builds
    // "Effluent TN 52.85 exceeded max 10" from this same subject.
    expect(describeTarget(rule())).toBe('Effluent TN');
    expect(event().message.startsWith(describeTarget(rule()))).toBe(true);
  });

  it('says so rather than lying when neither limit is set', () => {
    expect(describeRule(rule({ min_value: null, max_value: null })))
      .toBe('Effluent TN — no limit set');
    expect(describeRule(null)).toBe('');
  });

  it('fmtLimit keeps a readable number', () => {
    expect(fmtLimit(52.1)).toBe('52.1');
    expect(fmtLimit(3.14159265)).toBe('3.14159');
    expect(fmtLimit(10)).toBe('10');
  });

  it('ruleChip uppercases and truncates to the 22px footer', () => {
    expect(ruleChip('TN high')).toBe('TN HIGH');
    expect(ruleChip('Effluent nitrogen over permit')).toHaveLength(14);
    expect(ruleChip('Effluent nitrogen over permit')).toMatch(/…$/);
    expect(ruleChip('')).toBe('ALARM');
  });
});

// ── normalizeEvent ──────────────────────────────────────────────────────────

describe('normalizeEvent', () => {
  it('reads the snake_case flowsheet endpoint into the camelCase shape', () => {
    const n = normalizeEvent({
      id: 'e9', rule_id: 'r1', rule_name: 'TN', flowsheet_id: 'f1',
      state: 'cleared', severity: 'warning', message: 'm',
      limit_min: 1, limit_max: 2, triggered_at: 'T1', cleared_at: 'T2',
      acknowledged: true, acknowledged_at: 'T3', acknowledged_by_name: 'Eddie',
    });
    expect(n).toMatchObject({
      id: 'e9', ruleId: 'r1', ruleName: 'TN', flowsheetId: 'f1',
      limitMin: 1, limitMax: 2, triggeredAt: 'T1', clearedAt: 'T2',
      acknowledged: true, acknowledgedAt: 'T3', acknowledgedByName: 'Eddie',
    });
  });

  it('leaves an already-camelCase event alone and drops a row with no id', () => {
    expect(normalizeEvent(event()).ruleId).toBe('r1');
    expect(normalizeEvent({ ruleId: 'r1' })).toBeNull();
    expect(normalizeEvent(null)).toBeNull();
  });

  it('preserves fields this module does not know about', () => {
    expect(normalizeEvent({ ...event(), projectName: 'Demo' }).projectName).toBe('Demo');
  });
});

// ── mergeAlarmEvents ────────────────────────────────────────────────────────

describe('mergeAlarmEvents', () => {
  it('inserts a raised event', () => {
    const next = mergeAlarmEvents([], { event: event(), transition: 'raised' });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('e1');
    expect(next[0].state).toBe('active');
  });

  it('replaces — never duplicates — a refresh of the same event', () => {
    const first = mergeAlarmEvents([], { event: event(), transition: 'raised' });
    const again = mergeAlarmEvents(first, {
      event: event({ lastSeenAt: '2026-09-04T05:00:00.000Z', value: 61 }),
      transition: 'raised',
    });
    expect(again).toHaveLength(1);
    expect(again[0].value).toBe(61);
  });

  it('a cleared transition flips the state in place, keeping the row', () => {
    const active = mergeAlarmEvents([], { event: event(), transition: 'raised' });
    const cleared = mergeAlarmEvents(active, {
      event: event({ state: 'cleared', clearedAt: '2026-09-04T06:00:00.000Z' }),
      transition: 'cleared',
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].state).toBe('cleared');
    expect(isActiveEvent(cleared[0])).toBe(false);
  });

  it("trusts an explicit 'cleared' transition over the row's own state", () => {
    // The UPDATE and its broadcast can race; the transition is the truth.
    const active = mergeAlarmEvents([], event());
    const cleared = mergeAlarmEvents(active, { event: event({ state: 'active' }), transition: 'cleared' });
    expect(cleared[0].state).toBe('cleared');
    expect(cleared[0].clearedAt).toBeTruthy();
  });

  it('keeps the feed newest-first however events arrive', () => {
    const older = event({ id: 'old', triggeredAt: '2026-09-01T00:00:00.000Z' });
    const newer = event({ id: 'new', triggeredAt: '2026-09-05T00:00:00.000Z' });
    const mid   = event({ id: 'mid', triggeredAt: '2026-09-03T00:00:00.000Z' });
    const feed = mergeAlarmEvents([], [older, newer, mid]);
    expect(feed.map(e => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('caps the feed, dropping the OLDEST rows', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      event({ id: `e${i}`, triggeredAt: `2026-09-0${(i % 9) + 1}T00:00:0${i % 10}.000Z` }));
    const feed = mergeAlarmEvents([], many, { cap: 5 });
    expect(feed).toHaveLength(5);
    // Newest first, and every survivor is newer than every dropped one.
    const kept = feed.map(e => Date.parse(e.triggeredAt));
    expect([...kept].sort((a, b) => b - a)).toEqual(kept);
    expect(EVENT_FEED_CAP).toBeGreaterThan(0);
  });

  it('returns the SAME reference when nothing merged (no spurious re-render)', () => {
    const feed = mergeAlarmEvents([], event());
    expect(mergeAlarmEvents(feed, [])).toBe(feed);
    expect(mergeAlarmEvents(feed, undefined)).toBe(feed);
    expect(mergeAlarmEvents(feed, [null])).toBe(feed);
    // A byte-identical duplicate frame is also a no-op.
    expect(mergeAlarmEvents(feed, { event: event(), transition: 'raised' })).toBe(feed);
  });

  it('accepts a bare event row as well as the { event, transition } envelope', () => {
    const feed = mergeAlarmEvents([], [event({ id: 'a' }), { event: event({ id: 'b' }), transition: 'raised' }]);
    expect(feed.map(e => e.id).sort()).toEqual(['a', 'b']);
  });

  it('attaches the rule target so the node map can be built later', () => {
    const byId = rulesById([rule({ id: 'r1', target_type: 'param', node_id: 'n7', param_key: 'SRT_d' })]);
    const feed = mergeAlarmEvents([], event(), { rulesById: byId });
    expect(feed[0].nodeId).toBe('n7');
    expect(feed[0].targetType).toBe('param');
    expect(feed[0].paramKey).toBe('SRT_d');
  });
});

// ── Active / preview indexes ────────────────────────────────────────────────

describe('activeByRuleId / previewByRuleId', () => {
  it('indexes only open events, newest per rule', () => {
    const feed = [
      event({ id: 'e2', triggeredAt: '2026-09-05T00:00:00.000Z' }),
      event({ id: 'e1', triggeredAt: '2026-09-01T00:00:00.000Z' }),
      event({ id: 'e0', ruleId: 'r2', state: 'cleared' }),
    ];
    const active = activeByRuleId(feed);
    expect(active.size).toBe(1);
    expect(active.get('r1').id).toBe('e2');
    expect(active.has('r2')).toBe(false);
    expect(activeAlarmCount(feed)).toBe(1);
  });

  it('previewByRuleId indexes a simulate response\'s alarms[] by rule', () => {
    const m = previewByRuleId([
      { ruleId: 'r1', ruleName: 'TN', severity: 'critical', value: 12 },
      { severity: 'info' },   // no ruleId — ignored
    ]);
    expect(m.size).toBe(1);
    expect(m.get('r1').value).toBe(12);
    expect(previewByRuleId(undefined).size).toBe(0);
  });
});

// ── worstSeverityByNode ─────────────────────────────────────────────────────

describe('worstSeverityByNode', () => {
  const nodeEvent = (over) => event({ nodeId: 'n1', targetType: 'param', ...over });

  it('keeps the WORST active severity per node', () => {
    const map = worstSeverityByNode([
      nodeEvent({ id: 'a', severity: 'info' }),
      nodeEvent({ id: 'b', severity: 'critical', ruleName: 'SRT collapse' }),
      nodeEvent({ id: 'c', severity: 'warning' }),
    ]);
    expect(map.get('n1')).toMatchObject({ severity: 'critical', ruleName: 'SRT collapse' });
  });

  it('IGNORES cleared events entirely', () => {
    const map = worstSeverityByNode([
      nodeEvent({ id: 'a', severity: 'critical', state: 'cleared', clearedAt: 'T' }),
      nodeEvent({ id: 'b', severity: 'warning' }),
    ]);
    // The critical one is history — it must not still paint the card red.
    expect(map.get('n1').severity).toBe('warning');

    const allCleared = worstSeverityByNode([nodeEvent({ severity: 'critical', state: 'cleared' })]);
    expect(allCleared.size).toBe(0);
  });

  it('resolves the node through the rules when the event carries none', () => {
    const byId = rulesById([rule({ id: 'r1', target_type: 'param', node_id: 'n4', param_key: 'SRT_d' })]);
    const map = worstSeverityByNode([event()], byId);
    expect(map.get('n4').severity).toBe('critical');
  });

  it('omits plant-effluent alarms — they belong to no node', () => {
    const byId = rulesById([rule()]);              // effluent, node_id null
    expect(worstSeverityByNode([event()], byId).size).toBe(0);
  });

  it('keeps a node out of the map rather than guessing when the rule is unknown', () => {
    expect(worstSeverityByNode([event()]).size).toBe(0);
    expect(worstSeverityByNode(null).size).toBe(0);
  });
});

// ── Time, validation, error messages ────────────────────────────────────────

describe('time helpers', () => {
  const now = Date.parse('2026-09-04T12:00:00.000Z');
  it('renders compact relative times', () => {
    expect(relTime(now - 2_000, now)).toBe('just now');
    expect(relTime(now - 30_000, now)).toBe('30s ago');
    expect(relTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relTime(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(relTime(now - 2 * 86400_000, now)).toBe('2d ago');
  });
  it('never prints a negative age when the clocks disagree', () => {
    expect(relTime(now + 60_000, now)).toBe('just now');
  });
  it('returns empty / em-dash for missing timestamps', () => {
    expect(relTime(null)).toBe('');
    expect(relTime('not a date')).toBe('');
    expect(absTime(null)).toBe('—');
  });
});

describe('limitError — the same rule the server applies', () => {
  it('refuses a rule with neither limit', () => {
    expect(limitError(null, null)).toMatch(/At least one/);
    expect(limitError('', '')).toMatch(/At least one/);
  });
  it('refuses an inverted window', () => {
    expect(limitError(10, 5)).toBe('minValue must be less than maxValue');
    expect(limitError(10, 10)).toBe('minValue must be less than maxValue');
  });
  it('accepts either limit alone, or a valid window', () => {
    expect(limitError(null, 10)).toBeNull();
    expect(limitError(0, null)).toBeNull();     // zero is a limit, not "unset"
    expect(limitError(5, 10)).toBeNull();
  });
});

describe('serverErrorMessage', () => {
  it('surfaces a 422 detail message VERBATIM', () => {
    const msg = "'chamberType' is not a numeric parameter of a Grit Chamber (valid: HRT_min)";
    expect(serverErrorMessage({
      response: { status: 422, data: { error: 'Validation failed', details: [{ msg, path: 'target' }] } },
    })).toBe(msg);
  });
  it('surfaces a 409 error string verbatim', () => {
    expect(serverErrorMessage({
      response: { status: 409, data: { error: 'An alarm rule already exists for this target' } },
    })).toBe('An alarm rule already exists for this target');
  });
  it('falls back to the axios message, then the caller default', () => {
    expect(serverErrorMessage({ message: 'Network Error' })).toBe('Network Error');
    expect(serverErrorMessage({}, 'Save failed')).toBe('Save failed');
  });
});
