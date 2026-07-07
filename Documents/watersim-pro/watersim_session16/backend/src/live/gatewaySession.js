/**
 * Gateway session — continuously polls a flowsheet's live parameter bindings
 * and injects the (scaled) values into the running live simulation, reusing
 * the same override path as OPC (liveSimRunner.updateNodeParams).
 *
 * One session per flowsheet. Each binding polls on its own interval.
 */
'use strict';

const { readBinding, writeBinding } = require('./gateway');
const { updateNodeParams, getParamValue } = require('../simulation/liveSimRunner');
const logger = require('../utils/logger');

const sessions = new Map(); // flowsheetId -> session

const clampInterval = (ms) => Math.max(250, Math.min(60_000, Number(ms) || 1000));
const keyOf = (b) => `${b.mode === 'write' ? 'w' : 'r'}:${b.nodeId}::${b.paramKey}`;

function pollOne(flowsheetId, b, session) {
  const key = keyOf(b);
  const isWrite = b.mode === 'write';
  const tick = async () => {
    if (session.stopped) return;
    try {
      if (isWrite) {
        // simulation → device: write the current parameter value
        const cur = getParamValue(flowsheetId, b.nodeId, b.paramKey);
        if (cur == null) {
          session.latest[key] = { nodeId: b.nodeId, paramKey: b.paramKey, protocol: b.protocol, mode: 'write', ok: false, error: 'waiting for simulation value', at: Date.now() };
        } else {
          const r = await writeBinding(b, cur);
          session.latest[key] = { nodeId: b.nodeId, paramKey: b.paramKey, protocol: b.protocol, mode: 'write', value: r.wrote, raw: r.raw, ok: true, at: Date.now() };
        }
      } else {
        // device → simulation: read and inject
        const r = await readBinding(b);
        session.latest[key] = { nodeId: b.nodeId, paramKey: b.paramKey, protocol: b.protocol, mode: 'read', value: r.value, raw: r.raw, ok: true, at: Date.now() };
        updateNodeParams(flowsheetId, { nodeId: b.nodeId, params: { [b.paramKey]: r.value } });
      }
    } catch (e) {
      session.latest[key] = { nodeId: b.nodeId, paramKey: b.paramKey, protocol: b.protocol, mode: isWrite ? 'write' : 'read', ok: false, error: e.message, at: Date.now() };
    }
    if (!session.stopped) session.timers[key] = setTimeout(tick, clampInterval(b.poll_ms));
  };
  tick(); // fire immediately
}

function start(flowsheetId, bindings) {
  stop(flowsheetId);
  const session = { bindings, timers: {}, latest: {}, stopped: false, startedAt: Date.now() };
  sessions.set(flowsheetId, session);
  for (const b of bindings) pollOne(flowsheetId, b, session);
  logger.info('Live gateway session started', { flowsheetId, bindings: bindings.length });
  return { active: true, count: bindings.length };
}

function stop(flowsheetId) {
  const s = sessions.get(flowsheetId);
  if (!s) return false;
  s.stopped = true;
  Object.values(s.timers).forEach((t) => clearTimeout(t));
  sessions.delete(flowsheetId);
  logger.info('Live gateway session stopped', { flowsheetId });
  return true;
}

function status(flowsheetId) {
  const s = sessions.get(flowsheetId);
  if (!s) return { active: false, values: [] };
  return { active: true, startedAt: s.startedAt, count: s.bindings.length, values: Object.values(s.latest) };
}

module.exports = { start, stop, status };
