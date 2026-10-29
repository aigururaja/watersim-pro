/**
 * SafeCrit — P&ID reader
 *
 * Reads a picture of a P&ID with Claude (vision) and proposes a flowsheet:
 * the process equipment as unit blocks the solver can run, the lines between
 * them, and the items it deliberately left out (valves, instruments, control
 * loops — they do not change a steady-state mass balance).
 *
 * The model reports through one strict tool, `report_flowsheet`, and
 * `normalizeProposal()` then checks every part of the answer against what the
 * canvas and solver accept before anything reaches the user. The proposal is
 * only a proposal: the canvas shows it for review and the user creates it.
 *
 * Two providers read the picture. Claude answers through the tool; a local
 * vision model on Ollama (usually reached through an ngrok tunnel to the PC
 * that runs it) answers with JSON constrained to the same schema. Either way
 * the answer goes through normalizeProposal().
 *
 * Configuration (backend/.env):
 *   PID_READER_PROVIDER optional, "anthropic" or "ollama"; default ollama when
 *                       OLLAMA_BASE_URL is set, otherwise anthropic
 *   ANTHROPIC_API_KEY   needed for anthropic — without it the route answers 503
 *   OLLAMA_BASE_URL     needed for ollama, e.g. https://<name>.ngrok-free.dev
 *   OLLAMA_AUTH         optional "user:password" for the tunnel's basic auth
 *   PID_READER_MODEL    optional, default claude-opus-5 / qwen2.5vl:7b
 *   PID_READER_TIMEOUT_MS optional, default 600000 for ollama (CPU inference is slow)
 */
'use strict';

const http = require('http');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, PALETTE_TYPE_MAP } = require('../simulation/solver');

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:7b';
const OLLAMA_MAX_TOKENS = 2500;
const TOOL_NAME = 'report_flowsheet';

/**
 * The unit blocks the reader may propose, with the hint the model uses to
 * match a drawn symbol to a block. Every type must be one the solver resolves
 * (checked at load below), so a proposal can always be simulated.
 */
const UNIT_CATALOGUE = [
  ['inlet',                 'Feed entering the drawing: an inlet arrow or incoming line for water or wastewater'],
  ['outlet',                'Stream leaving the drawing: an outlet arrow, discharge, "to ..." or product line (gas, oil, water, effluent)'],
  ['pump',                  'Pump (circle with a triangle or centrifugal pump symbol)'],
  ['tank',                  'Storage tank or buffer vessel with no treatment function'],
  ['equalisation_tank',     'Equalisation / balancing tank'],
  ['screening',             'Bar screen or fine screen'],
  ['grit_removal',          'Grit chamber or grit removal'],
  ['oil_grease_trap',       'Oil and grease trap or gravity oil-water interceptor at atmospheric pressure'],
  ['primary_clarifier',     'Primary clarifier / primary settling tank'],
  ['activated_sludge',      'Aeration tank / activated sludge basin'],
  ['sbr_reactor',           'Sequencing batch reactor (SBR)'],
  ['membrane_bioreactor',   'Membrane bioreactor (MBR)'],
  ['secondary_clarifier',   'Secondary / final clarifier'],
  ['anaerobic_digester',    'Anaerobic digester'],
  ['sludge_centrifuge',     'Decanter centrifuge or sludge dewatering'],
  ['chemical_dosing',       'Chemical dosing point or dosing package'],
  ['coagulation',           'Coagulation / flocculation tank'],
  ['sand_filter',           'Sand or granular media filter'],
  ['multigrade_filter',     'Multigrade pressure filter (MGF)'],
  ['activated_carbon_filter', 'Activated carbon filter (ACF)'],
  ['micron_filter',         'Micron cartridge filter'],
  ['water_softener',        'Water softener'],
  ['uf_membrane',           'Ultrafiltration membrane'],
  ['ro_membrane',           'Reverse osmosis membrane'],
  ['uv_disinfection',       'UV disinfection'],
  ['chlorination',          'Chlorination / chlorine contact'],
];

const UNIT_TYPES = UNIT_CATALOGUE.map(([t]) => t);
for (const t of UNIT_TYPES) {
  if (!(t in PALETTE_TYPE_MAP) && !MODELS[t]) {
    throw new Error(`pidReader: unit type "${t}" is not known to the solver`);
  }
}

const REPORT_TOOL = {
  name: TOOL_NAME,
  description: 'Report the process flowsheet read from the P&ID: the unit blocks, the lines between them, and what was left out.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['units', 'connections', 'skipped', 'notes'],
    properties: {
      units: {
        type: 'array',
        description: 'One entry per piece of process equipment or boundary stream that becomes a block.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type', 'label', 'x', 'y', 'params'],
          properties: {
            id:    { type: 'string', description: 'Short unique id you choose, e.g. "u1".' },
            type:  { type: 'string', enum: UNIT_TYPES },
            label: { type: 'string', description: 'The name or tag as written on the drawing, e.g. "Vapor Outlet" or "V-101".' },
            x:     { type: 'number', description: 'Horizontal centre of the item in the image, 0 = left edge, 1 = right edge.' },
            y:     { type: 'number', description: 'Vertical centre of the item in the image, 0 = top edge, 1 = bottom edge.' },
            params: {
              type: 'array',
              description: 'Numbers written on the drawing for this item (flows, sizes, pressures); empty when none are shown.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['key', 'value'],
                properties: {
                  key:   { type: 'string', description: 'Parameter key, e.g. Q, volume_m3, depth_m, diameter_mm, rated_flow_m3_h.' },
                  value: { type: 'number' },
                },
              },
            },
          },
        },
      },
      connections: {
        type: 'array',
        description: 'Process lines between units, in the direction of flow.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', description: 'id of the upstream unit' },
            to:   { type: 'string', description: 'id of the downstream unit' },
          },
        },
      },
      skipped: {
        type: 'array',
        description: 'Items on the drawing that were deliberately not made into blocks.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'reason'],
          properties: {
            label:  { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      notes: { type: 'string', description: 'Anything the user should check: unreadable parts, guesses, missing data. Empty if none.' },
    },
  },
};

const PROMPT_BODY = `You read process and instrumentation diagrams (P&IDs) and turn them into a flowsheet for a steady-state process simulator.

The simulator has these unit blocks:
${UNIT_CATALOGUE.map(([t, d]) => `- ${t}: ${d}`).join('\n')}

How the flowsheet is used: each block computes flows and qualities from what enters it, so what matters is the main process equipment and the process lines between it. Valves (including control valves), bypasses, instruments and transmitters (LT, PT, FT, TT), controllers and control loops (LC, PC, FC), relief valves, drains, vents and utility lines do not change a steady-state mass balance: leave them out and list them under skipped with a short reason. Every stream that enters or leaves the drawing becomes an inlet or an outlet block, so each block has something upstream and downstream. Only use a block type when the drawing actually shows that equipment; when nothing in the catalogue fits a piece of equipment, list it under skipped rather than forcing a match.

Connections follow the direction of flow. Only put numbers in params when they are written on the drawing.`;

const SYSTEM_PROMPT = `${PROMPT_BODY}

For each unit give its position as the centre of the drawn item in the image, as fractions of the image width and height.

Call ${TOOL_NAME} exactly once with the result.`;

// Qwen-VL models locate things as pixel boxes (bbox_2d), which they were
// trained on; asked for fractions they invent an even spacing. So the local
// model reports boxes and boxesToFractions() turns them into x, y.
const OLLAMA_SYSTEM_PROMPT = `${PROMPT_BODY}

Answer with one JSON object and nothing else. It has four keys: "units" (each with id, type, label, bbox_2d, params), "connections" (each with from and to, the ids of two units), "skipped" (each with label and reason) and "notes" (a string). "type" must be one of the block names listed above. bbox_2d is the box around the drawn item as [x1, y1, x2, y2] in pixels of the image. Be brief: ids like "u1", a reason of a few words for each skipped item, params only for numbers actually written next to the item (key Q for a flow), notes empty unless something needs checking.`;

// The report schema with each unit's x, y replaced by a pixel box.
const OLLAMA_SCHEMA = (() => {
  const s = JSON.parse(JSON.stringify(REPORT_TOOL.input_schema));
  const unit = s.properties.units.items;
  delete unit.properties.x;
  delete unit.properties.y;
  unit.properties.bbox_2d = {
    type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4,
    description: 'Box around the drawn item, [x1, y1, x2, y2] in pixels of the image.',
  };
  unit.required = unit.required.filter((k) => k !== 'x' && k !== 'y').concat('bbox_2d');
  return s;
})();

/**
 * Turn each unit's pixel box into the x, y fractions the canvas uses. The
 * model's pixels are in its own resized frame, so the frame is taken from the
 * boxes themselves (the furthest right and lowest edge); only the relative
 * arrangement matters to the canvas. A unit without a usable box keeps no
 * position and normalizeProposal centres it.
 */
function boxesToFractions(raw) {
  const units = Array.isArray(raw?.units) ? raw.units : [];
  const boxes = units.map((u) => {
    const b = Array.isArray(u?.bbox_2d) ? u.bbox_2d.map(Number) : [];
    return b.length === 4 && b.every(Number.isFinite) ? b : null;
  });
  const fx = Math.max(1, ...boxes.filter(Boolean).map((b) => Math.max(b[0], b[2])));
  const fy = Math.max(1, ...boxes.filter(Boolean).map((b) => Math.max(b[1], b[3])));
  return {
    ...raw,
    units: units.map((u, i) => {
      const b = boxes[i];
      if (!b) return u;
      return { ...u, x: (b[0] + b[2]) / 2 / fx, y: (b[1] + b[3]) / 2 / fy };
    }),
  };
}

class PidReadError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'PidReadError';
    this.status = status;
  }
}

/** "ollama" or "anthropic", from PID_READER_PROVIDER or what is configured. */
function provider() {
  const p = (process.env.PID_READER_PROVIDER || '').trim().toLowerCase();
  if (p === 'ollama' || p === 'anthropic') return p;
  return process.env.OLLAMA_BASE_URL ? 'ollama' : 'anthropic';
}

/** True when the chosen provider has what it needs to be called. */
function isConfigured() {
  if (provider() === 'ollama') return !!process.env.OLLAMA_BASE_URL;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** The message the route shows when isConfigured() is false. */
function notConfiguredMessage() {
  return provider() === 'ollama'
    ? 'AI reading is not set up yet. Set OLLAMA_BASE_URL in backend/.env to the local model\'s address (the ngrok URL) and restart the server.'
    : 'AI reading is not set up yet. Add ANTHROPIC_API_KEY to backend/.env and restart the server.';
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: 180_000, maxRetries: 1 });
  return client;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/;

/**
 * Send the picture to Claude and return the normalised proposal.
 * @param {string} imageDataUrl  data:image/png|jpeg|webp;base64,...
 * @param {{signal?: AbortSignal}} [opts]  signal cancels a local-model read
 * @returns {Promise<{units, connections, skipped, notes, warnings, model}>}
 */
async function readPid(imageDataUrl, { signal } = {}) {
  const m = DATA_URL.exec(imageDataUrl || '');
  if (!m) throw new PidReadError('The stored picture is not a PNG, JPEG or WebP image.');
  if (provider() === 'ollama') return readPidOllama(m[2], signal);
  const model = process.env.PID_READER_MODEL || DEFAULT_MODEL;

  const response = await getClient().beta.messages.create({
    model,
    max_tokens: 16000,
    // Claude Opus 5 may decline a request; "default" re-runs it on
    // Anthropic's recommended fallback model instead of failing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: `Read this P&ID and report the flowsheet with ${TOOL_NAME}.` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new PidReadError('The picture could not be read (the request was declined). Try a clearer image of the P&ID.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new PidReadError('The drawing is too large to read in one go. Crop it to the part you want to simulate.');
  }
  const call = response.content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
  if (!call) {
    throw new PidReadError('No flowsheet could be read from this picture. Check that it is a P&ID and is clearly legible.');
  }
  return { ...normalizeProposal(call.input), model: response.model };
}

/**
 * POST to Ollama and hand back the response as a stream. Node's http client
 * is used rather than fetch: on a CPU the first byte can take minutes, and
 * fetch gives up on a response whose headers have not arrived within 300 s.
 * Kept on an object so the tests can replace it.
 */
const ollamaIo = {
  post(url, headers, body, signal) {
    const lib = url.startsWith('https:') ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        signal,
      }, (res) => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        body: res,
        text: async () => { let s = ''; for await (const c of res) s += c; return s; },
      }));
      req.on('error', reject);
      req.end(body);
    });
  },
};

// The local model reads one drawing at a time (a CPU runs one request at a
// time anyway); a second read while one runs would only queue behind it.
let ollamaBusy = false;

/**
 * Read the picture with a vision model on Ollama (/api/chat), the output
 * held to the report schema by Ollama's structured outputs.
 * @param {string} base64  the image bytes, base64
 * @param {AbortSignal} [signal]  aborts the read, e.g. when the browser leaves
 */
async function readPidOllama(base64, signal) {
  if (ollamaBusy) {
    throw new PidReadError('The local model is already reading a drawing. Wait for it to finish (a few minutes) and try again.', 409);
  }
  ollamaBusy = true;
  try {
    return await callOllama(base64, signal);
  } finally {
    ollamaBusy = false;
  }
}

async function callOllama(base64, signal) {
  const model = process.env.PID_READER_MODEL || DEFAULT_OLLAMA_MODEL;
  const base = process.env.OLLAMA_BASE_URL.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' };
  if (process.env.OLLAMA_AUTH) {
    headers.Authorization = `Basic ${Buffer.from(process.env.OLLAMA_AUTH).toString('base64')}`;
  }
  const timer = AbortSignal.timeout(Number(process.env.PID_READER_TIMEOUT_MS) || 600_000);
  const abort = signal ? AbortSignal.any([timer, signal]) : timer;
  const failed = (err, whileReading) => {
    if (err instanceof PidReadError) return err;
    if (timer.aborted) {
      return new PidReadError('The local model took too long to read this drawing. Crop it to the part you want to simulate and try again.', 504);
    }
    if (signal?.aborted) return new PidReadError('The read was cancelled.', 499);
    return whileReading
      ? new PidReadError('The connection to the local model broke off while it was reading. Try again.', 502)
      : new PidReadError('The local model could not be reached. Check that Ollama and the ngrok tunnel are running.', 503);
  };

  let res;
  try {
    res = await ollamaIo.post(`${base}/api/chat`, headers, JSON.stringify({
      model,
      stream: true,
      format: OLLAMA_SCHEMA,
      // num_predict stops a model that loops on its JSON; a plant answer is
      // well under 1000 tokens.
      options: { temperature: 0, num_ctx: 8192, num_predict: OLLAMA_MAX_TOKENS },
      messages: [
        { role: 'system', content: OLLAMA_SYSTEM_PROMPT },
        { role: 'user', content: 'Read this P&ID and report the flowsheet as JSON.', images: [base64] },
      ],
    }), abort);
  } catch (err) {
    throw failed(err, false);
  }
  if (res.status === 401 || res.status === 403) {
    throw new PidReadError('The local model refused the credentials. Check OLLAMA_AUTH against the ngrok tunnel.', 503);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    if (/not found/i.test(body)) {
      throw new PidReadError(`The local model "${model}" is not installed. Run: ollama pull ${model}`, 503);
    }
    throw new PidReadError(`The local model answered with an error (${res.status}). Check that Ollama and the ngrok tunnel are running.`, 502);
  }

  // One JSON object per line; the content arrives in pieces, the last line
  // carries done_reason and the model name.
  let content = '';
  let last = {};
  try {
    const decoder = new TextDecoder();
    let buf = '';
    const take = (line) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new PidReadError(`The local model failed: ${String(chunk.error).slice(0, 200)}`, 502);
      content += chunk.message?.content || '';
      last = chunk;
    };
    for await (const part of res.body) {
      buf += decoder.decode(part, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(take);
    }
    take(buf);
  } catch (err) {
    throw failed(err, true);
  }

  if (last.done_reason === 'length') {
    throw new PidReadError('The local model ran past its answer length on this drawing. Crop it to the part you want to simulate and try again.');
  }
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new PidReadError('No flowsheet could be read from this picture. Check that it is a P&ID and is clearly legible.');
  }
  return { ...normalizeProposal(boxesToFractions(raw)), model: last.model || model };
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Check a raw `report_flowsheet` input against what the canvas accepts:
 * known unit types, unique ids, positions inside the image, connections
 * between real units.
 * Anything dropped is explained in `warnings`.
 */
function normalizeProposal(raw) {
  const warnings = [];
  const units = [];
  const ids = new Set();

  for (const u of Array.isArray(raw?.units) ? raw.units : []) {
    const id = text(u?.id, 40);
    const label = text(u?.label, 80) || u?.type;
    if (!UNIT_TYPES.includes(u?.type)) {
      warnings.push(`"${label || id}" has a block type the simulator does not have (${u?.type}) — left out`);
      continue;
    }
    if (!id || ids.has(id)) {
      warnings.push(`"${label}" had a missing or repeated id — left out`);
      continue;
    }
    ids.add(id);
    const params = {};
    for (const p of Array.isArray(u.params) ? u.params : []) {
      const key = text(p?.key, 40);
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && Number.isFinite(p?.value)) params[key] = p.value;
    }
    units.push({ id, type: u.type, label, x: clamp01(u.x), y: clamp01(u.y), params });
  }

  const connections = [];
  const seen = new Set();
  for (const c of Array.isArray(raw?.connections) ? raw.connections : []) {
    const from = text(c?.from, 40);
    const to = text(c?.to, 40);
    if (!ids.has(from) || !ids.has(to) || from === to) {
      warnings.push(`A line between "${from}" and "${to}" does not join two blocks — left out`);
      continue;
    }
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    connections.push({ from, to });
  }

  const skipped = (Array.isArray(raw?.skipped) ? raw.skipped : [])
    .map((s) => ({ label: text(s?.label, 80), reason: text(s?.reason, 160) }))
    .filter((s) => s.label);

  if (!units.length) warnings.push('No equipment the simulator knows was found on this drawing.');

  return { units, connections, skipped, notes: text(raw?.notes, 1000), warnings };
}

module.exports = {
  readPid, normalizeProposal, boxesToFractions, isConfigured, notConfiguredMessage, provider, ollamaIo,
  PidReadError, UNIT_TYPES, REPORT_TOOL, SYSTEM_PROMPT,
};
