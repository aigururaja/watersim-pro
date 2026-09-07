/**
 * Live plant (Phase 3): the snapshot and the organisation room.
 *
 * Real database. What is pinned: bound tags appear with their last value and
 * quality; a drive is assembled from its XS/XA contacts and carries its run
 * command's binding; areas count their points; a comms row per connection;
 * nothing leaks across organisations; the org room broadcast is a no-op with
 * nobody listening; a viewer may look but not write.
 */
'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { query } = require('../db/pool');
const { backfillBindingTags } = require('../historian');
const { broadcastToOrg, roomSizes, orgRoomKey } = require('../collab/wsServer');

const PW = 'LivePlant123!';
const CANVAS = {
  nodes: [
    { id: 'n_in', type: 'unitOp', data: { opType: 'inlet',      label: 'Inlet',   params: {} } },
    { id: 'p1',   type: 'unitOp', data: { opType: 'pump',       label: 'P-201',   params: {} } },
    { id: 'ft',   type: 'unitOp', data: { opType: 'instrument', label: 'FT-201',  params: { measurement: 'flow' } } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',    label: 'Outlet',  params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'p1', data: { streamType: 'stream' } },
    { id: 'e2', source: 'p1', target: 'ft', data: { streamType: 'stream' } },
    { id: 'e3', source: 'ft', target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let admin, viewer, other, projectId, flowsheetId, orgId, connectionId;
const base = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`;

async function tag(body) {
  const r = await admin.post('/api/v1/tags').send({ flowsheetId, ...body });
  if (r.status !== 201) throw new Error(`tag ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function bind(body) {
  const r = await admin.post(`${base()}/plc-bindings`).send({ connectionId, ...body });
  if (r.status !== 201) throw new Error(`bind ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

beforeAll(async () => {
  const a = await createTestUser('live.admin@test.example', PW, 'admin');
  admin = await loginAs(a);
  const project = await makeProject(admin, 'Live Project');
  projectId = project.id;
  orgId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [projectId])).rows[0].organisation_id;
  const fs = await makeFlowsheet(admin, projectId, 'Live FS');
  flowsheetId = fs.id;
  expect((await admin.patch(base()).send({ canvasData: CANVAS })).status).toBe(200);

  const vEmail = `live.viewer.${Date.now()}@test.example`;
  expect((await admin.post('/api/v1/admin/members').send({ email: vEmail, firstName: 'V', lastName: 'W', role: 'viewer', password: PW })).status).toBe(201);
  viewer = await loginAs({ email: vEmail, password: PW, orgSlug: a.orgSlug });
  other = await loginAs(await createTestUser('live.other@test.example', PW, 'admin'));

  const conn = await admin.post('/api/v1/plc/connections').send({ name: 'Live Sim', protocol: 'simulator', config: {} });
  connectionId = conn.body.id;

  await tag({ tag: 'RFP-P-201/1.XS', name: 'Reactor feed pump 1', signalType: 'DI', kind: 'pump', signal: 'Run status', nodeId: 'p1', paramKey: 'running' });
  await tag({ tag: 'RFP-P-201/1.XA', name: 'Reactor feed pump 1', signalType: 'DI', kind: 'pump', signal: 'Trip', nodeId: 'p1', paramKey: 'tripped' });
  await tag({ tag: 'RFP-P-201/1.XY', name: 'Reactor feed pump 1', signalType: 'DO', kind: 'pump', signal: 'Run command', nodeId: 'p1', paramKey: 'run_cmd' });
  await tag({ tag: 'RFP-FT-201.FT', name: 'Reactor feed flow', signalType: 'AI', kind: 'flow_meter', signal: 'Flow', nodeId: 'ft', paramKey: 'measured', engUnit: 'm3/d', rangeMin: 0, rangeMax: 800 });

  await bind({ nodeId: 'p1', paramKey: 'running', address: 'mem:p1.run' });
  await bind({ nodeId: 'p1', paramKey: 'tripped', address: 'const:0' });
  await bind({ nodeId: 'p1', paramKey: 'run_cmd', address: 'mem:p1.run', direction: 'write' });
  await bind({ nodeId: 'ft', paramKey: 'measured', address: 'sine:500,700,600' });
  await backfillBindingTags();

  // The poller is off under test: stamp the readings by hand.
  await query(`UPDATE plc_bindings SET last_value = 1, quality = 'good', last_read_at = NOW() WHERE flowsheet_id = $1 AND param_key = 'running'`, [flowsheetId]);
  await query(`UPDATE plc_bindings SET last_value = 0, quality = 'good', last_read_at = NOW() WHERE flowsheet_id = $1 AND param_key = 'tripped'`, [flowsheetId]);
  await query(`UPDATE plc_bindings SET last_value = 612.5, quality = 'stale', last_read_at = NOW() - INTERVAL '2 minutes' WHERE flowsheet_id = $1 AND param_key = 'measured'`, [flowsheetId]);
});

describe('GET /live/snapshot', () => {
  test('bound tags, a drive with its command, areas, comms and task counts', async () => {
    const r = await admin.get('/api/v1/live/snapshot');
    expect(r.status).toBe(200);
    const s = r.body;
    expect(s.tags.map((t) => t.tag).sort()).toEqual(['RFP-FT-201.FT', 'RFP-P-201/1.XA', 'RFP-P-201/1.XS', 'RFP-P-201/1.XY']);
    const ft = s.tags.find((t) => t.tag === 'RFP-FT-201.FT');
    expect(ft.value).toBe(612.5);
    expect(ft.quality).toBe('stale');
    expect(ft.rangeMax).toBe(800);
    expect(ft.projectId).toBe(projectId);

    expect(s.equipment).toHaveLength(1);
    const p = s.equipment[0];
    expect(p.key).toBe('RFP-P-201/1');
    expect(p.opType).toBe('pump');
    expect(p.running).toBe(true);
    expect(p.tripped).toBe(false);
    expect(p.quality).toBe('good');
    expect(p.command).toEqual(expect.objectContaining({ tag: 'RFP-P-201/1.XY', flowsheetId, projectId }));
    expect(p.command.bindingId).toBeTruthy();

    const rfp = s.areas.find((a) => a.code === 'RFP');
    // 4 bound points: running (good), tripped (good), measured (stale), and the
    // run command — a write-only binding that is never read, so never "good".
    expect(rfp).toEqual(expect.objectContaining({ name: 'Reactor Feed Pump Process', points: 4, good: 2, equipment: 1, analog: 1, alarms: 0 }));

    expect(s.comms.connections).toHaveLength(1);
    expect(s.comms.connections[0]).toEqual(expect.objectContaining({ name: 'Live Sim', bindings: 4, good: 2, stale: 1 }));
    expect(s.comms.bindings.total).toBe(4);
    expect(s.alarms.active).toEqual([]);
    expect(s.alarms.counts.critical).toBe(0);
    expect(s.tasks).toEqual(expect.objectContaining({ open: 0, awaitingApproval: 0, overdue: 0 }));
  });

  test('an active alarm lands in its area with its counts', async () => {
    const rule = await admin.post(`${base()}/alarms`).send({ name: 'Flow high', targetType: 'param', nodeId: 'ft', paramKey: 'measured', maxValue: 600, severity: 'critical', createTask: false });
    expect(rule.status).toBe(201);
    await query(
      `INSERT INTO alarm_events (organisation_id, rule_id, flowsheet_id, source, state, severity, message, value, limit_max)
       VALUES ($1, $2, $3, 'plc', 'active', 'critical', 'FT-201 measured 612.5 exceeded max 600', 612.5, 600)`,
      [orgId, rule.body.id, flowsheetId]
    );
    const r = await admin.get('/api/v1/live/snapshot');
    expect(r.body.alarms.counts).toEqual(expect.objectContaining({ critical: 1, unacknowledged: 1 }));
    expect(r.body.alarms.active[0]).toEqual(expect.objectContaining({ area: 'RFP', ruleName: 'Flow high', flowsheetName: 'Live FS' }));
    expect(r.body.areas.find((a) => a.code === 'RFP').alarms).toBe(1);
  });

  test('a viewer can look; another organisation sees an empty plant', async () => {
    const v = await viewer.get('/api/v1/live/snapshot');
    expect(v.status).toBe(200);
    expect(v.body.equipment).toHaveLength(1);
    const o = await other.get('/api/v1/live/snapshot');
    expect(o.status).toBe(200);
    expect(o.body.tags).toEqual([]);
    expect(o.body.equipment).toEqual([]);
    expect(o.body.areas).toEqual([]);
  });

  test('a viewer cannot write to the command binding; an admin can', async () => {
    const s = (await admin.get('/api/v1/live/snapshot')).body;
    const cmd = s.equipment[0].command;
    expect((await viewer.post(`${base()}/plc-bindings/${cmd.bindingId}/write`).send({ value: 1 })).status).toBe(403);
    const w = await admin.post(`${base()}/plc-bindings/${cmd.bindingId}/write`).send({ value: 0 });
    expect(w.status).toBe(200);
    expect(w.body.value).toBe(0);
    // The audit row is written after the response is sent; give it a moment.
    let audit = { rows: [] };
    for (let i = 0; i < 20 && !audit.rows.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      audit = await query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND action = 'plc_binding.write'`, [cmd.bindingId]);
    }
    expect(audit.rows).toHaveLength(1);
  });
});

describe('organisation room', () => {
  test('broadcasting with nobody listening is a counted no-op', () => {
    expect(orgRoomKey(orgId)).toBe(`org:${orgId}`);
    expect(broadcastToOrg(orgId, { type: 'plc:update', payload: { values: [] } })).toBe(0);
    expect(broadcastToOrg(null, { type: 'x' })).toBe(0);
    expect(roomSizes()[orgRoomKey(orgId)]).toBeUndefined();
  });
});
