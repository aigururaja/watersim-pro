/**
 * WaterSim Pro — Preview (live-mode) simulation tests
 *
 * Covers:
 *  - preview: true runs the solver but creates NO simulation_runs row
 *  - preview responses carry run_id: null and preview: true
 *  - inline canvasData is honored for previews (unsaved edits simulate)
 *  - changed nodeParams change the previewed results (live-mode contract)
 *  - a normal (non-preview) run still persists exactly one run row
 */

'use strict';

const { request, app, createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { pool } = require('../db/pool');

const LINEAR_CANVAS = {
  nodes: [
    { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',            params: {} } },
    { id: 'n_as',  type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'n_as',  data: { streamType: 'stream' } },
    { id: 'e2', source: 'n_as', target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let agent, projectId, flowsheetId;

const simUrl = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`;

const runCount = async () => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM simulation_runs WHERE flowsheet_id = $1',
    [flowsheetId]
  );
  return rows[0].n;
};

beforeAll(async () => {
  const user = await createTestUser('preview@test.example', 'Preview123!', 'admin');
  agent = await loginAs(user);
  const project = await makeProject(agent, 'Preview Project');
  projectId = project.id;
  const fs = await makeFlowsheet(agent, projectId, 'Preview Flowsheet');
  flowsheetId = fs.id;
  await agent
    .patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
    .send({ canvasData: LINEAR_CANVAS });
});

afterAll(async () => {
  await pool.end().catch(() => {});
});

describe('POST /simulate — preview mode', () => {
  it('runs the solver without creating a run row', async () => {
    const before = await runCount();
    const res = await agent.post(simUrl()).send({ mode: 'steady_state', preview: true });
    expect(res.status).toBe(201);
    expect(res.body.preview).toBe(true);
    expect(res.body.run_id).toBeNull();
    expect(res.body.status).toBe('completed');
    expect(res.body.quality).toBeDefined();
    expect(res.body.results.streamResults).toBeDefined();
    expect(await runCount()).toBe(before);
  });

  it('changed nodeParams change the previewed results (live contract)', async () => {
    const lo = await agent.post(simUrl()).send({
      preview: true,
      nodeParams: { n_in: { Q: 10000 } },
    });
    const hi = await agent.post(simUrl()).send({
      preview: true,
      nodeParams: { n_in: { Q: 20000 } },
    });
    expect(lo.status).toBe(201);
    expect(hi.status).toBe(201);
    const qLo = lo.body.results.streamResults.e1.Q;
    const qHi = hi.body.results.streamResults.e1.Q;
    expect(qHi).toBeGreaterThan(qLo);
  });

  it('honors inline canvasData so unsaved edits can be previewed', async () => {
    // Inline canvas replaces the activated-sludge unit with a bare
    // inlet → outlet pass-through: the edge set differs from the stored canvas.
    const inline = {
      nodes: [
        { id: 'p_in',  type: 'unitOp', data: { opType: 'inlet',  params: { Q: 5000 } } },
        { id: 'p_out', type: 'unitOp', data: { opType: 'outlet', params: {} } },
      ],
      edges: [{ id: 'pe1', source: 'p_in', target: 'p_out', data: { streamType: 'stream' } }],
    };
    const res = await agent.post(simUrl()).send({ preview: true, canvasData: inline });
    expect(res.status).toBe(201);
    expect(res.body.results.streamResults.pe1).toBeDefined();
    expect(res.body.results.streamResults.e1).toBeUndefined();
    expect(await runCount()).toBe(0);
  });

  it('a normal run still persists exactly one run row', async () => {
    const before = await runCount();
    const res = await agent.post(simUrl()).send({ mode: 'steady_state' });
    expect(res.status).toBe(201);
    expect(res.body.run_id).toEqual(expect.any(String));
    expect(res.body.preview).toBeUndefined();
    expect(await runCount()).toBe(before + 1);
  });

  it('rejects a non-boolean preview flag', async () => {
    const res = await agent.post(simUrl()).send({ preview: 'yes-please' });
    expect(res.status).toBe(422);
  });
});
