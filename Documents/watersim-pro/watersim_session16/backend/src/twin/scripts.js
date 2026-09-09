/**
 * SafeKrit — Commissioning scripts (Phase 4)
 *
 * The ITC control narrative's sequences, played against a plant in shadow
 * mode. Each narrative step that acts on equipment (open / close / start /
 * stop) becomes a write of 1 or 0 to the command bindings of every unit of
 * the named loops, and each step's duration is scaled by `speedup` so a
 * 1.5-hour fill can be watched in fifteen seconds.
 *
 * A script refuses to run unless every connection it would write to is in
 * shadow mode: this is virtual commissioning, never remote control.
 * Progress is broadcast as `twin:script` to the flowsheet and organisation
 * rooms; each write goes through the same shadow path as a manual one and is
 * audited as `twin.script.step`.
 */
'use strict';

const { query } = require('../db/pool');
const { narrative } = require('../plants/itcStp');
const { writeShadow } = require('./shadow');
const { auditLog } = require('../utils/audit');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const logger = require('../utils/logger');

const ACTION_VALUE = { open: 1, start: 1, close: 0, stop: 0 };
const MAX_STEP_MS = 60_000;
const runs = new Map(); // runId → { flowsheetId, orgId, sectionId, status, stepNo, steps, startedAt, timer, cancelled }

/** Scripts: the narrative sections that actually act on equipment. */
function listScripts() {
  return narrative.SECTIONS
    .map((s) => narrative.timeline(s.id))
    .filter((s) => s.steps.some((st) => ACTION_VALUE[st.action] !== undefined))
    .map((s) => ({
      id: s.id, title: s.title, numeral: s.numeral, area: s.area, slide: s.slide, totalHours: s.totalHours,
      steps: s.steps.map((st) => ({
        no: st.no, text: st.text, action: st.action, devices: st.devices || [], durationH: st.durationH || 0,
        startHour: st.startHour, endHour: st.endHour, phase: st.phase || null, acts: ACTION_VALUE[st.action] !== undefined,
      })),
      actionableSteps: s.steps.filter((st) => ACTION_VALUE[st.action] !== undefined).length,
    }));
}

/** Command bindings on the flowsheet for the named loop tags, with their connection mode. */
async function commandBindings(flowsheetId, loopTags) {
  if (!loopTags.length) return [];
  const { rows } = await query(
    `SELECT b.*, t.tag, t.loop_tag, t.unit, c.mode, c.name AS connection_name
       FROM plc_bindings b JOIN tags t ON t.id = b.tag_id JOIN plc_connections c ON c.id = b.connection_id
      WHERE b.flowsheet_id = $1 AND b.enabled = TRUE AND b.direction IN ('write', 'read_write')
        AND t.signal_type = 'DO' AND t.loop_tag = ANY($2::text[])`,
    [flowsheetId, loopTags]
  );
  return rows;
}

/**
 * Start a script. Resolves as soon as the run is scheduled with the run id;
 * the steps play on timers. `speedup` = how many narrative seconds pass per
 * real second (default 360: an hour in ten seconds).
 */
async function startScript({ flowsheetId, orgId, sectionId, speedup = 360, req = null }) {
  const script = listScripts().find((s) => s.id === sectionId);
  if (!script) { const e = new Error('No such commissioning script'); e.status = 404; e.isOperational = true; throw e; }

  const loops = [...new Set(script.steps.filter((s) => s.acts).flatMap((s) => s.devices))];
  const bindings = await commandBindings(flowsheetId, loops);
  if (!bindings.length) { const e = new Error('None of the script’s equipment has a bound command point on this flowsheet'); e.status = 422; e.isOperational = true; throw e; }
  const live = bindings.filter((b) => b.mode !== 'shadow');
  if (live.length) {
    const e = new Error(`Refusing to run against a live PLC: put "${live[0].connection_name}" into shadow mode first`);
    e.status = 409; e.isOperational = true; throw e;
  }
  for (const r of runs.values()) if (r.flowsheetId === flowsheetId && r.status === 'running') {
    const e = new Error(`A script (${r.sectionId}) is already running on this flowsheet`); e.status = 409; e.isOperational = true; throw e;
  }

  const runId = `${flowsheetId.slice(0, 8)}-${Date.now().toString(36)}`;
  const run = {
    runId, flowsheetId, orgId, sectionId, status: 'running', stepNo: 0, speedup,
    steps: script.steps.filter((s) => s.acts), startedAt: new Date().toISOString(), timer: null, cancelled: false,
    log: [], actor: req ? (req.user.sub || req.user.id) : null,
  };
  runs.set(runId, run);
  publish(run, 'started');

  const byLoop = new Map();
  for (const b of bindings) { if (!byLoop.has(b.loop_tag)) byLoop.set(b.loop_tag, []); byLoop.get(b.loop_tag).push(b); }

  const play = async (i) => {
    if (run.cancelled) { run.status = 'cancelled'; publish(run, 'cancelled'); return; }
    if (i >= run.steps.length) { run.status = 'completed'; run.finishedAt = new Date().toISOString(); publish(run, 'completed'); return; }
    const step = run.steps[i];
    run.stepNo = i + 1;
    const value = ACTION_VALUE[step.action];
    const written = [];
    for (const loop of step.devices) {
      for (const b of byLoop.get(loop) || []) {
        try {
          const raw = (value - (Number(b.offset_val) || 0)) / (Number(b.scale) || 1);
          const reflected = await writeShadow(b, raw);
          await query(`UPDATE plc_bindings SET last_value = $1, quality = 'good', last_read_at = NOW() WHERE id = $2`, [value, b.id]);
          written.push({ tag: b.tag, value, reflected: reflected.length });
        } catch (err) {
          written.push({ tag: b.tag, error: err.message });
        }
      }
    }
    run.log.push({ no: step.no, action: step.action, devices: step.devices, written, at: new Date().toISOString() });
    if (req) auditLog(req, 'twin.script.step', 'flowsheet', flowsheetId, { runId, script: sectionId, step: step.no, action: step.action, written });
    publish(run, 'step');
    const waitMs = Math.min(MAX_STEP_MS, Math.max(250, (step.durationH * 3600_000) / speedup));
    run.timer = setTimeout(() => play(i + 1).catch((err) => { run.status = 'failed'; run.error = err.message; publish(run, 'failed'); }), waitMs);
    run.timer.unref?.();
  };
  setImmediate(() => play(0).catch((err) => { run.status = 'failed'; run.error = err.message; publish(run, 'failed'); }));
  return snapshot(run);
}

function cancelScript(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return null;
  run.cancelled = true;
  if (run.timer) clearTimeout(run.timer);
  run.status = 'cancelled';
  publish(run, 'cancelled');
  return snapshot(run);
}

function snapshot(run) {
  return {
    runId: run.runId, flowsheetId: run.flowsheetId, sectionId: run.sectionId, status: run.status, stepNo: run.stepNo,
    totalSteps: run.steps.length, speedup: run.speedup, startedAt: run.startedAt, finishedAt: run.finishedAt || null,
    error: run.error || null, log: run.log,
  };
}

function publish(run, event) {
  try {
    const message = { type: 'twin:script', payload: { event, ...snapshot(run) } };
    broadcastToRoom(run.flowsheetId, message);
    broadcastToOrg(run.orgId, message);
  } catch (err) { logger.debug('Script broadcast failed', { err: err.message }); }
}

const listRuns = (flowsheetId) => [...runs.values()].filter((r) => !flowsheetId || r.flowsheetId === flowsheetId).map(snapshot).slice(-20);
const getRun = (runId) => (runs.has(runId) ? snapshot(runs.get(runId)) : null);

module.exports = { listScripts, startScript, cancelScript, listRuns, getRun, ACTION_VALUE };
