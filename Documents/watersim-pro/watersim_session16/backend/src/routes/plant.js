/**
 * WaterSim Pro — Plant definition API
 *
 * Mounted at: /api/v1/plant
 *
 *   GET /plant                  — identity, process areas and headline counts
 *   GET /plant/io-schedule      — every wired signal, filterable, with totals
 *   GET /plant/io-schedule.csv  — the same list as a panel-builder CSV
 *   GET /plant/narrative        — the control narrative as structured sequences
 *   GET /plant/costing          — every quoted total, recomputed from line items
 *   GET /plant/review           — every discrepancy found in the proposal
 *   GET /plant/flowsheet        — the plant schematic as canvas_data
 *   GET /plant/flow-diagram     — the PFD layout model, stream table and mermaid
 *   GET /plant/flow-diagram.svg — the PFD as one standalone SVG sheet
 *   POST /plant/instantiate     — create the plant as a project + flowsheet the
 *                                 caller can open on the canvas (engineer+)
 *
 * The GET routes are STATIC — the plant definition is the proposal, transcribed,
 * and it does not vary by organisation. So they read no database, take no
 * organisation scope, and are cached hard. They still require authentication:
 * the commercial tables are a client's pricing.
 *
 * POST /instantiate is the exception: it writes the same definition into the
 * caller's own organisation as an ordinary project and flowsheet.
 */
'use strict';

const express = require('express');
const { body, query: qv, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/pool');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');
const plant = require('../plants/itcStp');
const { runSteadyState } = require('../simulation/solver');
const { createHash } = require('crypto');

const router = express.Router();
router.use(authenticate);

const userId = (req) => req.user.sub || req.user.id;
const orgId = (req) => req.user.org || req.user.organisationId;

/** The definition never changes between deploys, so let clients hold it. */
const CACHE = 'private, max-age=3600';

// ── Static-payload cache ─────────────────────────────────────────────────────
//
// Every response on this router is a pure function of files on disk: the plant
// definition is a transcribed document, not org-scoped data, so nothing here can
// differ between two requests in the same process. Recomputing it per request
// costs 0.2–3.4 ms of solver and serialisation work, plus a 138 KB string
// allocation on the I/O schedule, to arrive at a byte-identical answer.
//
// So each distinct payload is built ONCE, kept as its already-serialised string,
// and given an ETag derived from that string. Repeat requests never touch the
// solver, never re-serialise, and — when the client already holds the version —
// return 304 with no body at all.
//
// The cache is per process and never invalidated, which is correct precisely
// because the inputs are code: a change to the plant ships as a deploy, and a
// deploy is a new process. The key space is bounded by the handful of query
// variants the validators allow, and capped so a malformed key space cannot grow
// it without bound.
const MAX_CACHE_ENTRIES = 64;
const payloadCache = new Map();

function cachedPayload(key, build) {
  const hit = payloadCache.get(key);
  if (hit) return hit;
  const { body, type } = build();
  const entry = {
    body,
    type,
    etag: `"${createHash('sha1').update(body).digest('base64')}"`,
  };
  if (payloadCache.size >= MAX_CACHE_ENTRIES) {
    payloadCache.delete(payloadCache.keys().next().value);
  }
  payloadCache.set(key, entry);
  return entry;
}

/**
 * Send a cached payload, honouring If-None-Match.
 *
 * `res.send` on a string would make Express hash the body itself on every
 * request; the ETag is already known here, so it is set explicitly and the
 * conditional check is done before any body is written.
 */
function sendCached(req, res, key, build) {
  const entry = cachedPayload(key, build);
  res.set('Cache-Control', CACHE).set('ETag', entry.etag).type(entry.type);
  if (req.headers['if-none-match'] === entry.etag) {
    res.status(304).end();
    return;
  }
  res.send(entry.body);
}

/** Serialise once, at cache-fill time. */
const asJson = (value) => ({ body: JSON.stringify(value), type: 'application/json' });

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    res.status(422).json({ error: 'Validation failed', details: e.array() });
    return true;
  }
  return false;
}

// ── GET /plant ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => sendCached(req, res, 'plant', () => {
  const totals = plant.ioSchedule.plantTotals();
  const counts = plant.ioSchedule.deviceCounts();
  return asJson({
    identity: plant.IDENTITY,
    reuseCriteria: plant.REUSE_CRITERIA,
    processes: plant.processes.PROCESSES.map((p) => ({
      no: p.no,
      id: p.id,
      name: p.name,
      system: p.system,
      area: p.area,
      slide: p.slide,
      inputs: p.inputs,
      outputs: p.outputs,
      spec: p.spec,
      deviceCount: p.devices.reduce((a, d) => a + d.qty, 0),
      devices: p.devices,
      totals: plant.ioSchedule.processTotals(p),
    })),
    io: { totals, deviceCounts: counts, capacityHeadroom: plant.ioSchedule.capacityHeadroom() },
    reviewSummary: plant.reviewSummary(),
  });
}));

// ── GET /plant/io-schedule ───────────────────────────────────────────────────
router.get(
  '/io-schedule',
  [
    qv('type').optional().isIn(['DI', 'DO', 'AI', 'AO']).withMessage('type must be DI, DO, AI or AO'),
    qv('area').optional().isString().trim().isLength({ max: 20 }),
    qv('process').optional().isString().trim().isLength({ max: 40 }),
  ],
  (req, res) => {
    if (vErr(req, res)) return;
    const { type = '', area = '', process: proc = '' } = req.query;
    sendCached(req, res, `io:${type}:${area}:${proc}`, () => {
      let rows = plant.ioSchedule.buildTagList();
      if (type) rows = rows.filter((r) => r.type === type);
      if (area) rows = rows.filter((r) => r.area === area);
      if (proc) rows = rows.filter((r) => r.processId === proc);
      return asJson({
        total: rows.length,
        rows,
        totals: plant.ioSchedule.plantTotals(),
        perProcess: plant.processes.PROCESSES.map(plant.ioSchedule.processTotals),
        nodeLoading: plant.ioSchedule.nodeLoading(),
        capacityHeadroom: plant.ioSchedule.capacityHeadroom(),
      });
    });
  }
);

// ── GET /plant/io-schedule.csv ───────────────────────────────────────────────
const CSV_COLUMNS = [
  ['tag', 'Tag'],
  ['type', 'Signal type'],
  ['signal', 'Signal'],
  ['device', 'Device'],
  ['kindLabel', 'Device type'],
  ['area', 'Area'],
  ['processName', 'Process'],
  ['node', 'PLC node'],
  ['description', 'Description'],
];

/** RFC 4180 quoting — a field with a comma, quote or newline is quoted. */
const csvCell = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/io-schedule.csv', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="itc-stp-io-schedule.csv"');
  sendCached(req, res, 'io.csv', () => {
  const rows = plant.ioSchedule.buildTagList();
  const lines = [CSV_COLUMNS.map(([, header]) => csvCell(header)).join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(([key]) => csvCell(row[key])).join(','));
  }
  // A UTF-8 BOM, written as an escape rather than a literal: Excel needs it to
  // read the ° and ³ in the descriptions, and a literal BOM in source is an
  // invisible character nobody can see when it goes wrong.
  const BOM = '\uFEFF';
  return { body: `${BOM}${lines.join('\r\n')}\r\n`, type: 'text/csv; charset=utf-8' };
  });
});

// ── GET /plant/narrative ─────────────────────────────────────────────────────
router.get('/narrative', (req, res) => sendCached(req, res, 'narrative', () => asJson({
    sections: plant.narrative.SECTIONS.map((s) => plant.narrative.timeline(s.id)),
    cycleAnalysis: plant.narrative.cycleAnalysis(),
    sbrCycle: plant.narrative.SBR_CYCLE,
    ufCycle: plant.narrative.UF_CYCLE,
    findings: plant.narrative.narrativeFindings(),
  })));

// ── GET /plant/costing ───────────────────────────────────────────────────────
router.get('/costing', (req, res) => sendCached(req, res, 'costing', () => asJson({
    monitoring: plant.costing.monitoringCost(),
    valveOptions: plant.costing.valveControlOptions(),
    pumpControl: plant.costing.pumpControl(),
    architectures: plant.costing.architectures(),
    scenarios: plant.costing.scenarioGrid(),
    addOns: plant.costing.addOns(),
    overallOptions: plant.proposal.OVERALL_OPTIONS,
    icmesFeatures: plant.proposal.ICMES_FEATURES,
    pricedQuantities: plant.proposal.PRICED_QUANTITIES,
    derivedQuantities: plant.ioSchedule.deviceCounts().byFamily,
    findings: plant.costing.costFindings(),
  })));

// ── GET /plant/review ────────────────────────────────────────────────────────
router.get('/review', (req, res) => sendCached(req, res, 'review', () => asJson({
    summary: plant.reviewSummary(),
    findings: plant.review(),
  })));

// ── GET /plant/flowsheet ─────────────────────────────────────────────────────
router.get('/flowsheet', (req, res) => sendCached(req, res, 'flowsheet', () => asJson({
    canvasData: plant.flowsheet.buildFlowsheet(),
    nodeParams: plant.flowsheet.buildNodeParams(),
  })));

// ── POST /plant/instantiate ──────────────────────────────────────────────────
//
// Everything above this line is read-only reference. This is the one route that
// WRITES, and it exists because the plant was otherwise reachable on a canvas
// only through `npm run db:seed` — which creates its own organisation, cannot be
// run per user, and is a developer command rather than a product feature.
//
// It creates a project and a flowsheet in the CALLER'S organisation from the
// same definition every other route serves, so what lands on the canvas is the
// plant the review, the I/O schedule and the PFD all describe. From there it is
// an ordinary flowsheet: editable, simulable, and a target for alarm rules and
// PLC bindings.
//
// Both inserts run in ONE transaction. A project with no flowsheet is a worse
// outcome than a clean failure — the user would have to notice the empty project
// and delete it before trying again.
router.post(
  '/instantiate',
  requireRole('engineer'),
  [
    body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('flowsheetName').optional().trim().isLength({ min: 1, max: 200 }),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;

    const canvasData = plant.flowsheet.buildFlowsheet();
    const projectName = req.body.name || `${plant.IDENTITY.name} — Monitoring & Control`;
    const flowsheetName = req.body.flowsheetName || 'ITC STP — Full plant';

    try {
      const { project, flowsheet } = await withTransaction(async (client) => {
        const { rows: [project] } = await client.query(
          `INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags)
           VALUES ($1,$2,$3,$4,'wastewater',ARRAY['itc','stp','sbr','reuse'])
           RETURNING id, name`,
          [
            orgId(req), userId(req), projectName,
            `${plant.IDENTITY.objective}. Client ${plant.IDENTITY.client}, contractor `
              + `${plant.IDENTITY.contractor}, sub-contractor ${plant.IDENTITY.subContractor}. `
              + `Design flow ${plant.IDENTITY.designFlowKld} KLD. Generated from `
              + `${plant.IDENTITY.sourceDocument}.`,
          ]
        );

        const { rows: [flowsheet] } = await client.query(
          `INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, name`,
          [
            project.id, userId(req), flowsheetName,
            'Every unit operation, valve group, instrument and return line from the '
              + 'proposal schematic, with the control narrative\'s cycle times on the reactors.',
            JSON.stringify(canvasData),
          ]
        );
        return { project, flowsheet };
      });

      auditLog(req, 'plant.instantiate', 'flowsheet', flowsheet.id, {
        plant: plant.PLANT_ID,
        projectId: project.id,
        nodes: canvasData.nodes.length,
        edges: canvasData.edges.length,
      });
      logger.info('ITC plant instantiated', {
        projectId: project.id, flowsheetId: flowsheet.id, userId: userId(req),
      });

      res.status(201).json({
        project,
        flowsheet,
        nodes: canvasData.nodes.length,
        edges: canvasData.edges.length,
        canvasUrl: `/projects/${project.id}/flowsheets/${flowsheet.id}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Process flow diagram ─────────────────────────────────────────────────────
//
// The sheet carries the flow on each stream, so it is solved before it is drawn.
// That is a direct `runSteadyState` rather than the worker-pool `runSimulation`
// used for user flowsheets: this graph is fixed at 55 nodes and solves in about
// 15 ms, so a worker round-trip would cost more than the solve. If the plant
// ever grows past that, move it behind the pool.
function diagramModel({ detail, balanced }) {
  const canvas = plant.flowsheet.buildFlowsheet();
  const results = balanced
    ? runSteadyState(canvas, { nodeParams: plant.flowsheet.buildNodeParams() })
    : null;
  return plant.diagram.buildDiagram({ detail, results });
}

const diagramQuery = [
  qv('detail').optional().isIn(['pfd', 'full']).withMessage("detail must be 'pfd' or 'full'"),
  qv('balanced').optional().isIn(['0', '1', 'true', 'false']),
];

const readDiagramOpts = (req) => ({
  detail: req.query.detail === 'full' ? 'full' : 'pfd',
  balanced: !(req.query.balanced === '0' || req.query.balanced === 'false'),
});

// GET /plant/flow-diagram — the layout model, the stream table and a mermaid form
router.get('/flow-diagram', diagramQuery, (req, res) => {
  if (vErr(req, res)) return;
  const opts = readDiagramOpts(req);
  sendCached(req, res, `fd:${opts.detail}:${opts.balanced}`, () => {
    const model = diagramModel(opts);
    return asJson({
      model,
      streamTable: plant.diagram.streamTable(model),
      mermaid: plant.diagram.toMermaid(model),
    });
  });
});

// GET /plant/flow-diagram.svg — one standalone sheet, inline by default
router.get('/flow-diagram.svg', diagramQuery, (req, res) => {
  if (vErr(req, res)) return;
  const opts = readDiagramOpts(req);
  // The disposition varies with ?download but the BYTES do not, so it is set
  // outside the cache and the same sheet serves both.
  res.set(
    'Content-Disposition',
    `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="itc-stp-process-flow-diagram.svg"`
  );
  sendCached(req, res, `svg:${opts.detail}:${opts.balanced}`, () => ({
    body: plant.diagram.toSvg(diagramModel(opts)),
    type: 'image/svg+xml; charset=utf-8',
  }));
});

module.exports = router;
