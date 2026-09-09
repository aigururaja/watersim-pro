/**
 * SafeKrit — Live plant API (Phase 3)
 *
 * Mounted at: /api/v1/live
 *
 *   GET /live/snapshot — everything the live plant screen draws, in one call:
 *     areas[]      process areas with their bound points and active alarms
 *     tags[]       every PLC-bound registry tag with its last value and quality
 *     equipment[]  drives and valves assembled from their DI/DO signals
 *                  (run status, trip, limit switches, and the run command's
 *                  binding when there is one to write to)
 *     alarms       active events, newest first, with counts by severity
 *     comms        each PLC connection's status and its bindings' quality
 *     tasks        open / overdue / awaiting-approval counts
 *
 * The screen then keeps itself current from the organisation WebSocket room
 * (/ws/org): plc:update, alarm:event, task:event and notification messages.
 * This endpoint is the cold start and the once-a-minute reconciliation.
 *
 * Measured beats modelled: nothing here comes from a simulation. A pump is
 * "running" because its XS contact says so.
 */
'use strict';

const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { processes } = require('../plants/itcStp');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('ops.view'));

const orgId = (req) => req.user.org || req.user.organisationId;

/** Area names: the vessels the schedule names by code, then the ITC process list (which wins). */
const AREA_NAMES = {
  OGT: 'Oil & grease trap', EQT: 'Equalisation tank', INT: 'Intermediate water tank', IRR: 'Irrigation water tank',
  SNT: 'Sintex tank', SOF: 'Water softener', SWT: 'Soft water tank', FWT: 'Flush water tank', HWT: 'Horticulture water tank',
  ACF: 'ACF / MGF filters', UF: 'Ultrafiltration', R: 'SBR reactors', SHT: 'Sludge handling', RFP: 'Reactor feed pumps',
  ELP: 'Feed water lift pumps', FFP: 'Filter feed pumps', SFP: 'Softener feed pumps',
  ...Object.fromEntries((processes.PROCESSES || []).map((p) => [p.area, p.name])),
};

/** Registry kind → the canvas symbol that draws it on the screen. */
const OP_TYPE_OF_KIND = {
  pump: 'pump', dosing_pump: 'chemical_dosing', decanter_vfd: 'pump', air_blower: 'blower',
  butterfly_valve: 'valve', ball_valve: 'valve', air_valve: 'valve',
};

const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

const val = (v) => (v == null ? null : Number(v));

function fmtTag(r) {
  return {
    id: r.id, tag: r.tag, loopTag: r.loop_tag, unit: r.unit, fn: r.fn, name: r.name, area: r.area, kind: r.kind,
    signalType: r.signal_type, signal: r.signal, engUnit: r.eng_unit, rangeMin: val(r.range_min), rangeMax: val(r.range_max),
    bindingId: r.binding_id, direction: r.direction, value: val(r.last_value), quality: r.quality, at: r.last_read_at,
    flowsheetId: r.flowsheet_id, projectId: r.project_id, nodeId: r.node_id, paramKey: r.param_key, connectionId: r.connection_id,
  };
}

/**
 * Everything the live plant screen draws, for one organisation. Shared with
 * the role dashboards (routes/dashboard.js), which summarise the same picture.
 */
async function buildSnapshot(org) {
    const [bound, nodeAreas, alarms, conns, taskRows] = await Promise.all([
      query(
        `SELECT t.id, t.tag, t.loop_tag, t.unit, t.fn, t.name, t.area, t.kind, t.signal_type, t.signal, t.eng_unit,
                t.range_min, t.range_max,
                b.id AS binding_id, b.direction, b.quality, b.last_value, b.last_read_at, b.flowsheet_id,
                b.node_id, b.param_key, b.connection_id, f.project_id
           FROM tags t
           JOIN plc_bindings b ON b.tag_id = t.id AND b.enabled = TRUE
           JOIN flowsheets f ON f.id = b.flowsheet_id
          WHERE t.organisation_id = $1
          ORDER BY t.area, t.loop_tag, t.unit NULLS FIRST, t.fn`,
        [org]
      ),
      query(`SELECT DISTINCT node_id, area FROM tags WHERE organisation_id = $1 AND node_id IS NOT NULL`, [org]),
      query(
        `SELECT e.id, e.severity, e.message, e.value, e.triggered_at, e.last_seen_at, e.acknowledged, e.flowsheet_id, e.source,
                r.name AS rule_name, r.node_id, r.param_key, r.kind, r.tag_id, tg.area AS tag_area,
                f.name AS flowsheet_name, f.project_id
           FROM alarm_events e
           JOIN alarm_rules r ON r.id = e.rule_id
           LEFT JOIN tags tg ON tg.id = r.tag_id
           LEFT JOIN flowsheets f ON f.id = e.flowsheet_id
          WHERE e.organisation_id = $1 AND e.state = 'active'
          ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.triggered_at DESC
          LIMIT 200`,
        [org]
      ),
      query(
        `SELECT c.id, c.name, c.protocol, c.status, c.last_seen, c.last_error, c.enabled,
                COUNT(b.id)::int AS bindings,
                COUNT(b.id) FILTER (WHERE b.quality = 'good')::int  AS good,
                COUNT(b.id) FILTER (WHERE b.quality = 'stale')::int AS stale,
                COUNT(b.id) FILTER (WHERE b.quality = 'bad')::int   AS bad,
                MAX(b.last_read_at) AS last_read_at
           FROM plc_connections c
           LEFT JOIN plc_bindings b ON b.connection_id = c.id AND b.enabled = TRUE
          WHERE c.organisation_id = $1
          GROUP BY c.id ORDER BY c.name`,
        [org]
      ),
      query(
        `SELECT state, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE due_at < NOW() AND closed_at IS NULL)::int AS overdue
           FROM maintenance_tasks WHERE organisation_id = $1 GROUP BY state`,
        [org]
      ),
    ]);

    const tags = bound.rows.map(fmtTag);
    const areaOfNode = new Map(nodeAreas.rows.map((r) => [r.node_id, r.area]));

    // ── Equipment: one card per (loop, unit) that has a status or a command ──
    const equipment = new Map();
    for (const t of tags) {
      const opType = OP_TYPE_OF_KIND[t.kind];
      if (!opType) continue;
      const key = `${t.loopTag}${t.unit ? `/${t.unit}` : ''}`;
      if (!equipment.has(key)) {
        equipment.set(key, {
          key, loopTag: t.loopTag, unit: t.unit, name: t.name, area: t.area, kind: t.kind, opType,
          flowsheetId: t.flowsheetId, projectId: t.projectId, nodeId: t.nodeId,
          running: null, tripped: null, opened: null, closed: null, command: null, quality: 'unknown', at: null,
        });
      }
      const e = equipment.get(key);
      const bit = t.value == null ? null : t.value >= 0.5;
      const sig = { tagId: t.id, tag: t.tag, value: t.value, quality: t.quality, at: t.at, bindingId: t.bindingId };
      if (t.signalType === 'DI') {
        if (t.fn === 'XS') { e.running = bit; e.status = sig; }
        else if (t.fn === 'XA') { e.tripped = bit; e.trip = sig; }
        else if (t.fn === 'ZSO') { e.opened = bit; e.openSwitch = sig; }
        else if (t.fn === 'ZSC') { e.closed = bit; e.closeSwitch = sig; }
        if (t.quality && (e.quality === 'unknown' || t.quality !== 'good')) e.quality = t.quality;
        if (t.at && (!e.at || new Date(t.at) > new Date(e.at))) e.at = t.at;
      } else if (t.signalType === 'DO' && ['XY', 'XV'].includes(t.fn) && ['write', 'read_write'].includes(t.direction)) {
        e.command = { bindingId: t.bindingId, tag: t.tag, flowsheetId: t.flowsheetId, projectId: t.projectId, lastValue: t.value };
      }
    }

    // ── Areas ──
    const areas = new Map();
    const areaFor = (code) => {
      if (!areas.has(code)) areas.set(code, { code, name: AREA_NAMES[code] || code, points: 0, good: 0, alarms: 0, critical: 0, equipment: 0, analog: 0 });
      return areas.get(code);
    };
    for (const t of tags) {
      const a = areaFor(t.area);
      a.points += 1;
      if (t.quality === 'good') a.good += 1;
      if (t.signalType === 'AI') a.analog += 1;
    }
    for (const e of equipment.values()) areaFor(e.area).equipment += 1;
    const active = alarms.rows.map((a) => {
      const area = a.tag_area || (a.node_id ? areaOfNode.get(a.node_id) : null) || null;
      if (area) { const ar = areaFor(area); ar.alarms += 1; if (a.severity === 'critical') ar.critical += 1; }
      return {
        id: a.id, severity: a.severity, message: a.message, value: val(a.value), triggeredAt: a.triggered_at,
        lastSeenAt: a.last_seen_at, acknowledged: a.acknowledged, source: a.source, ruleName: a.rule_name,
        kind: a.kind, nodeId: a.node_id, paramKey: a.param_key, area,
        flowsheetId: a.flowsheet_id, flowsheetName: a.flowsheet_name, projectId: a.project_id,
      };
    });
    active.sort((x, y) => (SEV_ORDER[x.severity] ?? 3) - (SEV_ORDER[y.severity] ?? 3) || new Date(y.triggeredAt) - new Date(x.triggeredAt));

    const bindingCounts = conns.rows.reduce((acc, c) => {
      acc.total += c.bindings; acc.good += c.good; acc.stale += c.stale; acc.bad += c.bad; return acc;
    }, { total: 0, good: 0, stale: 0, bad: 0 });
    bindingCounts.unknown = Math.max(0, bindingCounts.total - bindingCounts.good - bindingCounts.stale - bindingCounts.bad);

    const taskCounts = Object.fromEntries(taskRows.rows.map((r) => [r.state, r.n]));
    const overdue = taskRows.rows.reduce((n, r) => n + r.overdue, 0);

    // The flowsheets that have bound points, for the schematic view (the
    // sheet with the most bound points is the plant to draw first).
    const fsMap = new Map();
    for (const t of tags) {
      if (!t.flowsheetId) continue;
      if (!fsMap.has(t.flowsheetId)) fsMap.set(t.flowsheetId, { id: t.flowsheetId, projectId: t.projectId, bound: 0 });
      fsMap.get(t.flowsheetId).bound += 1;
    }
    let flowsheets = [];
    if (fsMap.size) {
      const names = await query(`SELECT id, name FROM flowsheets WHERE id = ANY($1::uuid[])`, [[...fsMap.keys()]]);
      flowsheets = [...fsMap.values()].map((f) => ({ ...f, name: names.rows.find((n) => n.id === f.id)?.name || 'Flowsheet' })).sort((a, b) => b.bound - a.bound);
    }

    return {
      at: new Date().toISOString(),
      flowsheets,
      areas: [...areas.values()].sort((a, b) => a.code.localeCompare(b.code)),
      tags,
      equipment: [...equipment.values()],
      alarms: {
        active,
        counts: {
          critical: active.filter((a) => a.severity === 'critical').length,
          warning: active.filter((a) => a.severity === 'warning').length,
          info: active.filter((a) => a.severity === 'info').length,
          unacknowledged: active.filter((a) => !a.acknowledged).length,
        },
      },
      comms: {
        connections: conns.rows.map((c) => ({
          id: c.id, name: c.name, protocol: c.protocol, status: c.status, enabled: c.enabled,
          lastSeen: c.last_seen, lastError: c.last_error, lastReadAt: c.last_read_at,
          bindings: c.bindings, good: c.good, stale: c.stale, bad: c.bad,
        })),
        bindings: bindingCounts,
      },
      tasks: {
        counts: taskCounts,
        open: ['open', 'assigned', 'in_progress', 'rejected'].reduce((n, s) => n + (taskCounts[s] || 0), 0),
        awaitingApproval: taskCounts.completed || 0,
        overdue,
      },
    };
}

router.get('/snapshot', async (req, res, next) => {
  try { res.json(await buildSnapshot(orgId(req))); } catch (err) { next(err); }
});

module.exports = router;
module.exports.buildSnapshot = buildSnapshot;
