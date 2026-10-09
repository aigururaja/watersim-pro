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
 * Configuration (backend/.env):
 *   ANTHROPIC_API_KEY   required — without it the route answers 503
 *   PID_READER_MODEL    optional, default claude-opus-5
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, PALETTE_TYPE_MAP } = require('../simulation/solver');

const DEFAULT_MODEL = 'claude-opus-5';
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

const SYSTEM_PROMPT = `You read process and instrumentation diagrams (P&IDs) and turn them into a flowsheet for a steady-state process simulator.

The simulator has these unit blocks:
${UNIT_CATALOGUE.map(([t, d]) => `- ${t}: ${d}`).join('\n')}

How the flowsheet is used: each block computes flows and qualities from what enters it, so what matters is the main process equipment and the process lines between it. Valves (including control valves), bypasses, instruments and transmitters (LT, PT, FT, TT), controllers and control loops (LC, PC, FC), relief valves, drains, vents and utility lines do not change a steady-state mass balance: leave them out and list them under skipped with a short reason. Every stream that enters or leaves the drawing becomes an inlet or an outlet block, so each block has something upstream and downstream. Only use a block type when the drawing actually shows that equipment; when nothing in the catalogue fits a piece of equipment, list it under skipped rather than forcing a match.

For each unit give its position as the centre of the drawn item in the image, as fractions of the image width and height. Connections follow the direction of flow. Only put numbers in params when they are written on the drawing.

Call ${TOOL_NAME} exactly once with the result.`;

class PidReadError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'PidReadError';
    this.status = status;
  }
}

/** True when a credential is configured for the SDK to use. */
function isConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
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
 * @returns {Promise<{units, connections, skipped, notes, warnings, model}>}
 */
async function readPid(imageDataUrl) {
  const m = DATA_URL.exec(imageDataUrl || '');
  if (!m) throw new PidReadError('The stored picture is not a PNG, JPEG or WebP image.');
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

module.exports = { readPid, normalizeProposal, isConfigured, PidReadError, UNIT_TYPES, REPORT_TOOL, SYSTEM_PROMPT };
