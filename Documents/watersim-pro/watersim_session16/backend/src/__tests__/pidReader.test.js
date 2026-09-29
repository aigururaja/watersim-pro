/**
 * P&ID reader — proposal checking, the Claude request, and the read endpoint.
 * The Anthropic SDK is mocked throughout: no request leaves the machine.
 */
'use strict';

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  function MockAnthropic() { return { beta: { messages: { create: mockCreate } } }; }
  Object.assign(MockAnthropic, actual);   // keep the real error classes
  return MockAnthropic;
});

const pidReader = require('../pid/pidReader');
const { normalizeProposal, readPid, PidReadError } = pidReader;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// What Claude reports for a small activated-sludge P&ID.
const PLANT_REPORT = {
  units: [
    { id: 'u1', type: 'inlet', label: 'Raw Sewage', x: 0.05, y: 0.5, params: [{ key: 'Q', value: 675 }] },
    { id: 'u2', type: 'screening', label: 'Bar Screen', x: 0.2, y: 0.5, params: [] },
    { id: 'u3', type: 'activated_sludge', label: 'Aeration Tank', x: 0.5, y: 0.5, params: [] },
    { id: 'u4', type: 'secondary_clarifier', label: 'Clarifier', x: 0.75, y: 0.5, params: [] },
    { id: 'u5', type: 'outlet', label: 'Treated Water', x: 0.95, y: 0.5, params: [] },
  ],
  connections: [
    { from: 'u1', to: 'u2' },
    { from: 'u2', to: 'u3' },
    { from: 'u3', to: 'u4' },
    { from: 'u4', to: 'u5' },
  ],
  skipped: [{ label: 'FT-101', reason: 'flow transmitter' }],
  notes: '',
};

describe('normalizeProposal', () => {
  it('keeps a clean reading as it is', () => {
    const p = normalizeProposal(PLANT_REPORT);
    expect(p.units).toHaveLength(5);
    expect(p.units[0]).toMatchObject({ type: 'inlet', params: { Q: 675 } });
    expect(p.connections).toEqual(PLANT_REPORT.connections);
    expect(p.skipped).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });

  it('drops unknown types, broken lines and bad values, and says why', () => {
    const p = normalizeProposal({
      units: [
        { id: 'a', type: 'inlet', label: 'Feed', x: 7, y: -1, params: [{ key: 'Q', value: 'x' }] },
        { id: 'b', type: 'flare_stack', label: 'Flare', x: 0.5, y: 0.5, params: [] },
        { id: 'a', type: 'outlet', label: 'Duplicate', x: 0.5, y: 0.5, params: [] },
        { id: 'c', type: 'outlet', label: 'Out', x: 0.9, y: 0.5, params: [] },
      ],
      connections: [
        { from: 'a', to: 'c' },
        { from: 'a', to: 'b' },    // b was dropped
        { from: 'a', to: 'c' },    // duplicate of the first
      ],
      skipped: [], notes: '',
    });
    expect(p.units.map(u => u.id)).toEqual(['a', 'c']);
    expect(p.units[0]).toMatchObject({ x: 1, y: 0, params: {} });
    expect(p.connections).toEqual([{ from: 'a', to: 'c' }]);
    expect(p.warnings.join(' ')).toMatch(/flare_stack/);
    expect(p.warnings.join(' ')).toMatch(/repeated id/);
    expect(p.warnings.join(' ')).toMatch(/does not join two blocks/);
  });
});

describe('readPid', () => {
  beforeEach(() => mockCreate.mockReset());

  it('sends the picture with the report tool and returns the checked proposal', async () => {
    mockCreate.mockResolvedValue({
      model: 'claude-opus-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'report_flowsheet', input: PLANT_REPORT }],
    });
    const p = await readPid(PNG);
    expect(p.units).toHaveLength(5);
    expect(p.model).toBe('claude-opus-5');

    const req = mockCreate.mock.calls[0][0];
    expect(req.model).toBe('claude-opus-5');
    expect(req.tools[0]).toMatchObject({ name: 'report_flowsheet', strict: true });
    expect(req.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(req.messages[0].content[0].source.data).not.toMatch(/^data:/);
  });

  it('turns a refusal or a missing tool call into a readable error', async () => {
    mockCreate.mockResolvedValueOnce({ stop_reason: 'refusal', content: [] });
    await expect(readPid(PNG)).rejects.toBeInstanceOf(PidReadError);
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Not a P&ID.' }] });
    await expect(readPid(PNG)).rejects.toThrow(/No flowsheet could be read/);
  });

  it('refuses anything that is not a stored image', async () => {
    await expect(readPid('data:text/plain;base64,aGk=')).rejects.toBeInstanceOf(PidReadError);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── The endpoint ─────────────────────────────────────────────────────────────

const { request, app, registerAndLogin } = require('./helpers');
const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

describe('POST …/background/read', () => {
  if (SKIP) return it.skip('No DB — skipping read endpoint tests');

  let token, base;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    ({ token } = await registerAndLogin({ orgSlug: `pid-read-${Date.now()}`, email: `pid-${Date.now()}@test.example` }));
    const project = await request(app).post('/api/v1/projects').set('Authorization', `Bearer ${token}`)
      .send({ name: 'P&ID read', projectType: 'combined' });
    const fs = await request(app).post(`/api/v1/projects/${project.body.id}/flowsheets`)
      .set('Authorization', `Bearer ${token}`).send({ name: 'Treatment train' });
    base = `/api/v1/projects/${project.body.id}/flowsheets/${fs.body.id}/background`;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  });
  beforeEach(() => mockCreate.mockReset());

  it('answers 503 with a setup message when no API key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const auth = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const res = await request(app).post(`${base}/read`).set('Authorization', `Bearer ${token}`);
    if (auth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = auth;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PID_READER_NOT_CONFIGURED');
  });

  it('asks for a picture first', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const res = await request(app).post(`${base}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns the proposal read from the stored picture', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await request(app).put(base).set('Authorization', `Bearer ${token}`)
      .send({ imageData: PNG, width: 1, height: 1, fileName: 'pid.png' });
    mockCreate.mockResolvedValue({
      model: 'claude-opus-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'report_flowsheet', input: PLANT_REPORT }],
    });
    const res = await request(app).post(`${base}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(5);
    expect(res.body.connections).toHaveLength(4);
  });
});
