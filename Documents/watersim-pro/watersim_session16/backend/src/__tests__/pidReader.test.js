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

// The Claude tests run on the anthropic provider whatever the dev .env
// selects (it is loaded later, with the app); the Ollama tests set their own.
beforeEach(() => {
  process.env.PID_READER_PROVIDER = 'anthropic';
  delete process.env.PID_READER_MODEL;
});

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

describe('readPid on Ollama', () => {
  const saved = { ...process.env };
  const realPost = pidReader.ollamaIo.post;
  beforeEach(() => {
    process.env.PID_READER_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'https://example.ngrok-free.dev/';
    process.env.OLLAMA_AUTH = 'safecrit:secret';
    delete process.env.PID_READER_MODEL;
    pidReader.ollamaIo.post = jest.fn();
  });
  afterEach(() => {
    for (const k of ['PID_READER_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_AUTH', 'PID_READER_MODEL']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    pidReader.ollamaIo.post = realPost;
  });
  const reply = (body, status = 200) => ({
    ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
  });
  // A streamed answer: the content split over several lines, cut mid-line
  // between network chunks, and a closing line with done_reason.
  const streamed = (content) => {
    const half = Math.floor(content.length / 2);
    const ndjson = [
      { message: { content: content.slice(0, half) }, done: false },
      { message: { content: content.slice(half) }, done: false },
      { model: 'qwen2.5vl:7b', message: { content: '' }, done: true, done_reason: 'stop' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    const bytes = new TextEncoder().encode(ndjson);
    const cut = Math.floor(bytes.length / 3);
    return { ok: true, status: 200, body: [bytes.slice(0, cut), bytes.slice(cut)] };
  };

  it('sends the picture with the schema as format and checks the answer', async () => {
    pidReader.ollamaIo.post.mockResolvedValue(streamed(JSON.stringify(PLANT_REPORT)));
    const p = await readPid(PNG);
    expect(p.units).toHaveLength(5);
    expect(p.model).toBe('qwen2.5vl:7b');
    expect(mockCreate).not.toHaveBeenCalled();

    const [url, headers, sent] = pidReader.ollamaIo.post.mock.calls[0];
    expect(url).toBe('https://example.ngrok-free.dev/api/chat');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('safecrit:secret').toString('base64')}`);
    const body = JSON.parse(sent);
    expect(body).toMatchObject({ model: 'qwen2.5vl:7b', stream: true });
    expect(body.format.required).toEqual(['units', 'connections', 'skipped', 'notes']);
    expect(body.messages[1].images[0]).not.toMatch(/^data:/);
  });

  it('explains an unreachable tunnel, bad credentials, a missing model and unreadable output', async () => {
    pidReader.ollamaIo.post.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(readPid(PNG)).rejects.toThrow(/could not be reached/);
    pidReader.ollamaIo.post.mockResolvedValueOnce(reply({}, 401));
    await expect(readPid(PNG)).rejects.toThrow(/OLLAMA_AUTH/);
    pidReader.ollamaIo.post.mockResolvedValueOnce(reply({ error: 'model "qwen2.5vl:7b" not found, try pulling it first' }, 404));
    await expect(readPid(PNG)).rejects.toThrow(/ollama pull qwen2.5vl:7b/);
    pidReader.ollamaIo.post.mockResolvedValueOnce(streamed('not json'));
    await expect(readPid(PNG)).rejects.toThrow(/No flowsheet could be read/);
  });

  it('reads one drawing at a time and caps the answer length', async () => {
    let finish;
    pidReader.ollamaIo.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const first = readPid(PNG);
    await expect(readPid(PNG)).rejects.toMatchObject({ status: 409 });
    finish(streamed(JSON.stringify(PLANT_REPORT)));
    await expect(first).resolves.toMatchObject({ model: 'qwen2.5vl:7b' });
    const body = JSON.parse(pidReader.ollamaIo.post.mock.calls[0][2]);
    expect(body.options.num_predict).toBeGreaterThan(0);
    // the guard is released after a read
    pidReader.ollamaIo.post.mockResolvedValueOnce(streamed(JSON.stringify(PLANT_REPORT)));
    await expect(readPid(PNG)).resolves.toBeTruthy();
  });

  it('passes the cancel signal on and reports a cancelled read', async () => {
    const gone = new AbortController();
    pidReader.ollamaIo.post.mockImplementationOnce((url, h, b, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const read = readPid(PNG, { signal: gone.signal });
    gone.abort();
    await expect(read).rejects.toMatchObject({ status: 499 });
  });

  it('asks for pixel boxes and turns them into positions', async () => {
    const boxed = {
      ...PLANT_REPORT,
      units: PLANT_REPORT.units.map(({ x: _x, y: _y, ...u }, i) => ({ ...u, bbox_2d: [i * 200, 100, i * 200 + 100, 200] })),
    };
    pidReader.ollamaIo.post.mockResolvedValue(streamed(JSON.stringify(boxed)));
    const p = await readPid(PNG);
    const body = JSON.parse(pidReader.ollamaIo.post.mock.calls[0][2]);
    const unit = body.format.properties.units.items;
    expect(unit.required).toContain('bbox_2d');
    expect(unit.properties.x).toBeUndefined();
    // frame is the furthest edge (900, 200): centres 50/900 .. 850/900, 150/200
    expect(p.units[0].x).toBeCloseTo(50 / 900);
    expect(p.units[4].x).toBeCloseTo(850 / 900);
    expect(p.units.every((u) => u.y === 0.75)).toBe(true);
  });

  it('is configured by OLLAMA_BASE_URL alone', () => {
    delete process.env.PID_READER_PROVIDER;
    expect(pidReader.provider()).toBe('ollama');
    expect(pidReader.isConfigured()).toBe(true);
    delete process.env.OLLAMA_BASE_URL;
    expect(pidReader.provider()).toBe('anthropic');
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
