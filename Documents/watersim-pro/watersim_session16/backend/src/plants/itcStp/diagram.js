/**
 * ITC STP — the process flow diagram, generated from the flow.
 *
 * A single sheet showing every major unit operation, the streams between them
 * numbered and classified by service, and a stream table keyed to those numbers.
 *
 * ── WHY IT IS GENERATED AND NOT DRAWN ────────────────────────────────────────
 * A PFD that is drawn by hand drifts from the model the moment either changes,
 * and the drift is invisible: the drawing still looks authoritative. This module
 * derives every block, every line and every number from `flowsheet.js` and
 * `processes.js`, so the diagram cannot say anything the plant model does not.
 * If a stream is not on this sheet, it is not in the flow.
 *
 * ── PFD, NOT P&ID ────────────────────────────────────────────────────────────
 * A process flow diagram shows major equipment and the streams between it. Valves
 * and instruments belong on the P&ID, and drawing 9 valve groups and 7
 * transmitters here would triple the block count for detail that is already fully
 * specified in the I/O schedule. So `detail: 'pfd'` CONTRACTS every `valve` and
 * `instrument` node out of the graph — the stream flows straight from the unit
 * before to the unit after — and records what was folded on the stream itself, so
 * the sheet still tells you "2 actuated valves, FT-201" on the line that has them.
 * Nothing is hidden; it is summarised on the line it belongs to.
 * `detail: 'full'` keeps every node, for anyone who wants the canvas topology.
 *
 * ── WHAT IS MARKED ───────────────────────────────────────────────────────────
 * Blocks whose parameters are an ASSUMPTION rather than a stated duty carry an
 * (A) marker and are listed in the title block. On a drawing an engineer will
 * order equipment from, the difference between "the proposal says 43 m³/hr" and
 * "we assumed 225 m³" has to survive onto the paper.
 *
 * Exports:
 *   buildDiagram({ detail, results })  the layout model — blocks, streams, lanes
 *   toSvg(model)                       one standalone SVG sheet
 *   toMermaid(model)                   a mermaid flowchart, for markdown contexts
 *   streamTable(model)                 rows keyed to the stream numbers on the sheet
 */
'use strict';

const { NODES, EDGES } = require('./flowsheet');
const { PROCESSES } = require('./processes');
const { PARTIES, DESIGN_FLOW_KLD } = require('./proposal');

// ── Presentation constants ───────────────────────────────────────────────────

/** Node types that are P&ID detail, contracted out of the PFD. */
const PFD_HIDDEN = new Set(['valve', 'instrument']);

/** Stream service classes. Colour is the line, dash distinguishes at a glance. */
const SERVICES = Object.freeze({
  raw: { label: 'Raw sewage', color: '#8B5E34', dash: null, order: 1 },
  treated: { label: 'Treated water', color: '#2E75B6', dash: null, order: 2 },
  product: { label: 'Product water (reuse)', color: '#0D9488', dash: null, order: 3 },
  sludge: { label: 'Sludge', color: '#78350F', dash: null, order: 4 },
  return: { label: 'Return to EQT', color: '#B45309', dash: '7 4', order: 5 },
  reject: { label: 'Reject / waste', color: '#9333EA', dash: '2 3', order: 6 },
  chemical: { label: 'Chemical dosing', color: '#7C3AED', dash: '5 3', order: 7 },
  air: { label: 'Process air', color: '#0891B2', dash: '1 3', order: 8 },
});

/** How each block is drawn. */
const BLOCK_KIND = Object.freeze({
  boundary: { stroke: '#475569', fill: '#F1F5F9', weight: 1.4 },
  vessel: { stroke: '#1E293B', fill: '#FFFFFF', weight: 1.8 },
  machine: { stroke: '#1E293B', fill: '#F8FAFC', weight: 1.4 },
  dosing: { stroke: '#7C3AED', fill: '#FAF5FF', weight: 1.2, dash: '4 3' },
});

const KIND_OF_TYPE = Object.freeze({
  inlet: 'boundary', outlet: 'boundary',
  pump: 'machine', blower: 'machine', sludge_centrifuge: 'machine',
  chlorination: 'dosing', polymer_dosing: 'dosing', chemical_dosing: 'dosing',
  coagulant_dosing: 'dosing', ph_adjustment: 'dosing',
});

/**
 * Short equipment tags for blocks whose label carries none.
 * Everything else takes the tag from its own `TAG — Name` label, so this map only
 * covers the boundaries, pump sets and dosing skids the schematic names by function.
 */
const PFD_TAG = Object.freeze({
  in_kitchen: 'IN-K', in_sewage: 'IN-S', in_laundry: 'IN-L',
  blowers: 'B-301', elp_p: 'ELP', rfp_p: 'RFP', stp_p: 'STP', ffp_p: 'FFP',
  sfp_p: 'SFP', uffp: 'UFFP', ufbp: 'UFBP', swtp: 'SWTP', hwtp: 'HWTP', fwtp: 'FWTP',
  poly_dose: 'PD-411', cl_dose: 'CD-501', swt_cl: 'CD-1101',
  centrifuge: 'CFG-421', mf: 'MF', uf: 'UF', sintex: 'SNT',
  solids_out: 'CAKE', reject_out: 'RJT', cooling_tower: 'CLG-TWR',
  irrigation: 'IRR-SYS', flush_out: 'FW-SYS',
});

const GEO = Object.freeze({
  blockW: 184, blockH: 58,
  colPitch: 230, rowPitch: 96,
  marginX: 40, headerH: 96, busGap: 26, legendH: 92,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const nodeById = new Map(NODES.map((n) => [n.id, n]));
const processByArea = new Map(PROCESSES.map((p) => [p.area, p]));

/** Area order on the sheet, following the proposal's own process numbering. */
const AREA_ORDER = new Map(PROCESSES.map((p, i) => [p.area, i]));

/**
 * `TAG — Name` splits into a tag and a name; anything else is all name.
 * A trailing parenthetical duty is dropped from the NAME when the block also
 * prints a duty line — "Decanter centrifuge (1 m³/hr)" would otherwise ellipsis
 * inside the block while the same figure sits legibly on the line beneath it.
 */
function splitLabel(label, { dropParenthetical = false } = {}) {
  const clean = (t) => (dropParenthetical ? t.replace(/\s*\([^)]*\)\s*$/, '').trim() : t.trim());
  const parts = String(label || '').split(' — ');
  if (parts.length >= 2 && parts[0].length <= 12) {
    return { tag: parts[0].trim(), name: clean(parts.slice(1).join(' — ')) };
  }
  return { tag: null, name: clean(String(label || '')) };
}

/** The duty line under a block: the node's own source note, minus the slide prefix. */
function dutyOf(node) {
  const src = node.data.source || '';
  const stripped = src.replace(/^Slide\s+\d+\s+—\s*/i, '').trim();
  return stripped && stripped !== src.trim() ? stripped : (stripped || null);
}

/**
 * The pipe size to print on a stream.
 *
 * The proposal gives pipe sizes PER PROCESS AREA, not per line, so the size has
 * to be attributed to the right area or the sheet prints a confident wrong
 * number. A line belongs to the area of the equipment that moves water through
 * it: EQT → RFP is the reactor feed pump's 100 mm suction, not the 50 mm pipe
 * that fills EQT, even though EQT sits in the ELP area.
 *
 * Precedence:
 *   1. an explicit size on the stream itself — the schematic states a few
 *   2. the TARGET's area, when the target is the pump that draws the line
 *   3. the SOURCE's area, for discharge and gravity lines
 *   4. nothing — an influent from a plant boundary has no stated size, and a
 *      blank is better than a borrowed one
 */
function pipeSizeOf(edge, sourceNode, targetNode) {
  const fromLabel = /(\d+)\s*mm/i.exec(edge.data.label || '');
  if (fromLabel) return `${fromLabel[1]} mm`;
  if (sourceNode.data.opType === 'inlet') return null;

  const drawnByTarget = targetNode
    && targetNode.data.opType === 'pump'
    && sourceNode.data.opType !== 'pump';
  const area = (drawnByTarget ? targetNode.data.area : sourceNode.data.area);

  const proc = processByArea.get(area);
  const spec = proc && proc.spec && proc.spec.pipe;
  if (!spec) return null;
  const first = String(spec).split('·')[0];
  const m = /(\d+)\s*mm/.exec(first);
  return m ? `${m[1]} mm` : null;
}

const DOSING_TYPES = new Set(['chlorination', 'polymer_dosing', 'chemical_dosing', 'coagulant_dosing', 'ph_adjustment']);
const SLUDGE_NODES = new Set(['stp_v_in', 'stp_p', 'sht', 'poly_dose', 'centrifuge']);
const RAW_AREAS = new Set(['ELP', 'RFP']);

/** Which service class a stream belongs to. Order of tests is the precedence. */
function classifyService(edge, src, tgt) {
  const role = edge.data.role;
  if (src.data.opType === 'blower' || tgt.data.opType === 'blower') return 'air';
  if (role === 'concentrate') return 'reject';
  if (edge.data.isRecycle) return 'return';
  if (role === 'was' || role === 'thickened' || SLUDGE_NODES.has(src.id) || SLUDGE_NODES.has(tgt.id)) return 'sludge';
  if (DOSING_TYPES.has(src.data.opType)) return 'chemical';
  if (tgt.data.opType === 'outlet') {
    const kind = (tgt.data.params && tgt.data.params.discharge_type) || 'water';
    if (kind === 'water') return 'product';
    if (kind === 'solids') return 'sludge';
    return 'reject';
  }
  if (RAW_AREAS.has(src.data.area) && !edge.data.isRecycle) return 'raw';
  return 'treated';
}

// ── Graph contraction ────────────────────────────────────────────────────────

/**
 * Contract the hidden node types out of the graph.
 *
 * Walking forward from a hidden node yields the visible units the stream really
 * reaches, and the hidden ids passed through are recorded so the resulting stream
 * can say what equipment sits on it. A hidden node with several outlets fans out
 * into several contracted streams, which is correct: the valve set downstream of
 * FFP genuinely splits three ways.
 */
function contract(detail) {
  const hide = detail === 'full' ? new Set() : PFD_HIDDEN;
  const visible = NODES.filter((n) => !hide.has(n.data.opType));
  const visibleIds = new Set(visible.map((n) => n.id));

  const outgoing = new Map();
  for (const e of EDGES) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push(e);
  }

  /** Follow a stream through hidden nodes to the visible units it reaches. */
  function reach(startEdge) {
    const results = [];
    const walk = (edge, through, seen) => {
      if (visibleIds.has(edge.target)) {
        results.push({ target: edge.target, through, lastEdge: edge });
        return;
      }
      if (seen.has(edge.target)) return;
      const next = outgoing.get(edge.target) || [];
      for (const e of next) {
        walk(e, [...through, edge.target], new Set([...seen, edge.target]));
      }
    };
    walk(startEdge, [], new Set());
    return results;
  }

  const streams = [];
  for (const e of EDGES) {
    if (!visibleIds.has(e.source)) continue;
    for (const hit of reach(e)) {
      streams.push({
        firstEdgeId: e.id,
        lastEdgeId: hit.lastEdge.id,
        source: e.source,
        target: hit.target,
        through: hit.through,
        role: e.data.role || null,
        recycle: !!e.data.isRecycle,
        label: e.data.label || hit.lastEdge.data.label || null,
      });
    }
  }

  // ── The air header ────────────────────────────────────────────────────────
  // Blowers carry air, not water, so they have no edges in the flowsheet — the
  // solver would otherwise try to route an effluent stream through them. On a
  // PFD an unconnected block reads as a mistake, and the schematic plainly draws
  // a 125 mm SS-304 header from the blowers into both reactors.
  //
  // So the header is DERIVED, not hand-drawn: a blower with no water connection
  // supplies every reactor in its own process area. That is a rule over the
  // plant data, so it cannot drift the way a drawn line would, and the streams
  // are marked `derived` so the table can say where they came from.
  const connected = new Set(streams.flatMap((s) => [s.source, s.target]));
  for (const blower of visible.filter((n) => n.data.opType === 'blower' && !connected.has(n.id))) {
    for (const reactor of visible.filter((n) => n.data.opType === 'sbr_reactor' && n.data.area === blower.data.area)) {
      streams.push({
        firstEdgeId: `air_${blower.id}_${reactor.id}`,
        lastEdgeId: null,
        source: blower.id,
        target: reactor.id,
        through: [],
        role: 'air',
        recycle: false,
        derived: 'Air header — derived from the blower and reactors sharing process area '
          + `${blower.data.area}; it carries air, so it is not a flowsheet stream.`,
        label: '125 mm SS-304 air header',
      });
    }
  }

  return { visible, streams };
}

// ── Layered layout ───────────────────────────────────────────────────────────

/**
 * Longest-path ranking on the acyclic part of the graph, then a barycentre pass
 * to order rows within each rank so the lines cross as little as possible.
 * Recycle streams are excluded from ranking — they are what MAKES it cyclic — and
 * are drawn afterwards on a return bus beneath the sheet.
 */
function layout(visible, streams) {
  const ids = visible.map((n) => n.id);
  const forward = streams.filter((s) => !s.recycle && s.source !== s.target);

  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const s of forward) {
    if (!adj.has(s.source) || !indeg.has(s.target)) continue;
    adj.get(s.source).push(s.target);
    indeg.set(s.target, indeg.get(s.target) + 1);
  }

  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const degree = new Map(indeg);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    for (const v of adj.get(u) || []) {
      rank.set(v, Math.max(rank.get(v), rank.get(u) + 1));
      degree.set(v, degree.get(v) - 1);
      if (degree.get(v) === 0) queue.push(v);
    }
  }

  // Group into ranks, seeded in the proposal's own area order so the first pass
  // already reads top-to-bottom the way the process list does.
  const byRank = new Map();
  for (const n of visible) {
    const r = rank.get(n.id) || 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(n);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    byRank.get(r).sort((a, b) => {
      const ao = AREA_ORDER.get(a.data.area) ?? 99;
      const bo = AREA_ORDER.get(b.data.area) ?? 99;
      return ao !== bo ? ao - bo : a.position.y - b.position.y;
    });
  }

  // Barycentre ordering: three forward-and-back sweeps is plenty at this size.
  const rowOf = new Map();
  const applyRows = () => {
    for (const r of ranks) byRank.get(r).forEach((n, i) => rowOf.set(n.id, i));
  };
  applyRows();
  const predsOf = new Map(ids.map((id) => [id, []]));
  const succsOf = new Map(ids.map((id) => [id, []]));
  for (const s of forward) {
    if (predsOf.has(s.target)) predsOf.get(s.target).push(s.source);
    if (succsOf.has(s.source)) succsOf.get(s.source).push(s.target);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const order = pass % 2 === 0 ? ranks : [...ranks].reverse();
    for (const r of order) {
      const neighbours = pass % 2 === 0 ? predsOf : succsOf;
      const group = byRank.get(r);
      const bary = new Map();
      for (const n of group) {
        const ns = (neighbours.get(n.id) || []).map((id) => rowOf.get(id)).filter((v) => v != null);
        bary.set(n.id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : rowOf.get(n.id));
      }
      group.sort((a, b) => {
        const d = bary.get(a.id) - bary.get(b.id);
        if (d !== 0) return d;
        return (AREA_ORDER.get(a.data.area) ?? 99) - (AREA_ORDER.get(b.data.area) ?? 99);
      });
      applyRows();
    }
  }

  const maxRows = Math.max(...ranks.map((r) => byRank.get(r).length));
  const positions = new Map();
  for (const r of ranks) {
    const group = byRank.get(r);
    // Centre each rank vertically so a sparse column does not hug the top.
    const offset = (maxRows - group.length) / 2;
    group.forEach((n, i) => {
      positions.set(n.id, {
        rank: r,
        row: i,
        x: GEO.marginX + r * GEO.colPitch,
        y: GEO.headerH + (offset + i) * GEO.rowPitch,
      });
    });
  }

  return { positions, ranks, maxRows, rankCount: ranks.length };
}

// ── The model ────────────────────────────────────────────────────────────────

/**
 * @param {{detail?: 'pfd'|'full', results?: object}} opts
 *   results — a runSteadyState() result; when given, every stream carries its
 *   computed flow and the table becomes a real material balance rather than a
 *   topology listing.
 * @returns {object} the layout model
 */
function buildDiagram({ detail = 'pfd', results = null } = {}) {
  const { visible, streams } = contract(detail);
  const { positions, maxRows, rankCount } = layout(visible, streams);

  const blocks = visible.map((n) => {
    const pos = positions.get(n.id);
    const { tag, name } = splitLabel(n.data.label, { dropParenthetical: !!dutyOf(n) });
    return {
      id: n.id,
      tag: PFD_TAG[n.id] || tag || null,
      name,
      opType: n.data.opType,
      kind: KIND_OF_TYPE[n.data.opType] || 'vessel',
      area: n.data.area || null,
      duty: dutyOf(n),
      assumption: n.data.assumption || null,
      note: n.data.note || null,
      tags: n.data.tags || [],
      rank: pos.rank, row: pos.row, x: pos.x, y: pos.y,
      w: GEO.blockW, h: GEO.blockH,
    };
  });
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  // Streams are numbered in reading order — down each column, left to right —
  // so a number on the sheet is findable without hunting.
  const ordered = [...streams].sort((a, b) => {
    const A = blockById.get(a.source);
    const B = blockById.get(b.source);
    if (A.rank !== B.rank) return A.rank - B.rank;
    if (A.row !== B.row) return A.row - B.row;
    return String(a.firstEdgeId).localeCompare(String(b.firstEdgeId));
  });

  const streamOut = ordered.map((s, i) => {
    const src = nodeById.get(s.source);
    const tgt = nodeById.get(s.target);
    const service = classifyService(
      { data: { role: s.role, isRecycle: s.recycle, label: s.label } }, src, tgt
    );
    const flow = results && results.streamResults ? results.streamResults[s.lastEdgeId] : null;
    const folded = s.through
      .map((id) => nodeById.get(id))
      .filter(Boolean)
      .map((n) => splitLabel(n.data.label).name || n.data.label);
    return {
      no: i + 1,
      id: s.firstEdgeId,
      from: s.source,
      fromLabel: blockById.get(s.source).tag || blockById.get(s.source).name,
      to: s.target,
      toLabel: blockById.get(s.target).tag || blockById.get(s.target).name,
      service,
      serviceLabel: SERVICES[service].label,
      size: pipeSizeOf({ data: { label: s.label } }, src, tgt),
      label: s.label || null,
      recycle: s.recycle,
      role: s.role,
      derived: s.derived || null,
      inlineEquipment: folded,
      Q_m3_d: flow && Number.isFinite(flow.Q) ? +flow.Q.toFixed(1) : null,
      quality: flow
        ? { TSS: flow.TSS, BOD: flow.BOD, COD: flow.COD, TN: flow.TN, TP: flow.TP, pH: flow.pH }
        : null,
    };
  });

  const graphBottom = GEO.headerH + maxRows * GEO.rowPitch;
  const returnCount = streamOut.filter((s) => s.recycle).length;
  const width = GEO.marginX * 2 + (rankCount - 1) * GEO.colPitch + GEO.blockW;
  const height = graphBottom + returnCount * GEO.busGap + GEO.legendH;

  const lanes = PROCESSES
    .map((p) => ({
      area: p.area,
      title: p.name,
      no: p.no,
      blocks: blocks.filter((b) => b.area === p.area).map((b) => b.id),
    }))
    .filter((l) => l.blocks.length);

  return {
    title: 'Sewage Treatment Plant — Process Flow Diagram',
    subtitle: `Client ${PARTIES.client} · Contractor ${PARTIES.contractor} · Sub-contractor ${PARTIES.subContractor}`,
    designFlowKld: DESIGN_FLOW_KLD,
    detail,
    generatedFrom: 'backend/src/plants/itcStp/flowsheet.js',
    blocks,
    streams: streamOut,
    lanes,
    services: SERVICES,
    geometry: { ...GEO, width, height, graphBottom, maxRows, rankCount },
    assumptions: blocks.filter((b) => b.assumption).map((b) => ({ tag: b.tag || b.name, text: b.assumption })),
    balanced: !!results,
  };
}

// ── SVG ──────────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Trim to fit a block, with an ellipsis, at roughly 5.6 px per character. */
function fit(text, px) {
  const s = String(text || '');
  const max = Math.floor(px / 5.6);
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Orthogonal polyline from a source block's right edge to a target's left edge. */
function forwardPath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (Math.abs(y1 - y2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`;
}

/** A recycle drops to its own lane on the return bus, runs back, and rises. */
function returnPath(a, b, busY) {
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y + b.h;
  return `M ${x1} ${y1} L ${x1} ${busY} L ${x2} ${busY} L ${x2} ${y2}`;
}

/**
 * One standalone SVG sheet. No external references, no fonts to load — it opens
 * in a browser, imports into a drawing package, and prints.
 */
function toSvg(model) {
  const { geometry: g } = model;
  const blockById = new Map(model.blocks.map((b) => [b.id, b]));
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.width} ${g.height}" ` +
    `width="${g.width}" height="${g.height}" font-family="ui-sans-serif, system-ui, Segoe UI, Helvetica, Arial, sans-serif">`
  );

  // Arrowheads, one per service so the head matches its line.
  parts.push('<defs>');
  for (const [key, s] of Object.entries(model.services)) {
    parts.push(
      `<marker id="ah-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="${s.color}"/></marker>`
    );
  }
  parts.push('</defs>');
  parts.push(`<rect width="${g.width}" height="${g.height}" fill="#FFFFFF"/>`);

  // ── Title block ────────────────────────────────────────────────────────────
  parts.push(`<text x="${g.marginX}" y="34" font-size="20" font-weight="700" fill="#0F172A">${esc(model.title)}</text>`);
  parts.push(`<text x="${g.marginX}" y="54" font-size="12" fill="#475569">${esc(model.subtitle)}</text>`);
  parts.push(
    `<text x="${g.marginX}" y="72" font-size="11" fill="#64748B">` +
    `Design flow ${model.designFlowKld} KLD · ${model.blocks.length} unit operations · ${model.streams.length} streams` +
    `${model.balanced ? ' · flows from the steady-state solution' : ''}` +
    `${model.detail === 'pfd' ? ' · valves and instruments summarised on the line they sit on (see the P&amp;ID schedule)' : ''}</text>`
  );
  parts.push(`<line x1="${g.marginX}" y1="82" x2="${g.width - g.marginX}" y2="82" stroke="#CBD5E1" stroke-width="1"/>`);

  // ── Return bus, drawn first so blocks sit over it ─────────────────────────
  const returns = model.streams.filter((s) => s.recycle);
  returns.forEach((s, i) => {
    const a = blockById.get(s.from);
    const b = blockById.get(s.to);
    if (!a || !b) return;
    const busY = g.graphBottom + (i + 1) * g.busGap - 10;
    const svc = model.services[s.service];
    parts.push(
      `<path d="${returnPath(a, b, busY)}" fill="none" stroke="${svc.color}" stroke-width="1.4" ` +
      `${svc.dash ? `stroke-dasharray="${svc.dash}" ` : ''}marker-end="url(#ah-${s.service})"/>`
    );
    const midX = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
    parts.push(
      `<rect x="${midX - 52}" y="${busY - 8}" width="104" height="14" rx="3" fill="#FFFFFF" opacity="0.92"/>` +
      `<text x="${midX}" y="${busY + 2}" font-size="9" text-anchor="middle" fill="${svc.color}">` +
      `${s.no} · ${esc(fit(s.label || svc.label, 96))}</text>`
    );
  });

  // ── Forward streams ────────────────────────────────────────────────────────
  for (const s of model.streams) {
    if (s.recycle) continue;
    const a = blockById.get(s.from);
    const b = blockById.get(s.to);
    if (!a || !b) continue;
    const svc = model.services[s.service];
    parts.push(
      `<path d="${forwardPath(a, b)}" fill="none" stroke="${svc.color}" stroke-width="1.6" ` +
      `${svc.dash ? `stroke-dasharray="${svc.dash}" ` : ''}marker-end="url(#ah-${s.service})"/>`
    );
    // Stream number in a bubble on the line — the key into the stream table.
    const bx = a.x + a.w + (b.x - (a.x + a.w)) / 2;
    const by = a.y + a.h / 2;
    parts.push(
      `<circle cx="${bx}" cy="${by}" r="9" fill="#FFFFFF" stroke="${svc.color}" stroke-width="1.2"/>` +
      `<text x="${bx}" y="${by + 3.4}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${svc.color}">${s.no}</text>`
    );
    if (s.size) {
      parts.push(
        `<text x="${bx}" y="${by - 13}" font-size="8.5" text-anchor="middle" fill="#94A3B8">${esc(s.size)}</text>`
      );
    }
    if (s.Q_m3_d != null) {
      parts.push(
        `<text x="${bx}" y="${by + 21}" font-size="8.5" text-anchor="middle" fill="#64748B">${s.Q_m3_d} m³/d</text>`
      );
    }
  }

  // ── Blocks ─────────────────────────────────────────────────────────────────
  for (const b of model.blocks) {
    const style = BLOCK_KIND[b.kind];
    parts.push(`<g>`);
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" ` +
      `fill="${style.fill}" stroke="${style.stroke}" stroke-width="${style.weight}" ` +
      `${style.dash ? `stroke-dasharray="${style.dash}"` : ''}/>`
    );
    // Machines get a filled spine so a pump reads differently from a vessel.
    if (b.kind === 'machine') {
      parts.push(`<rect x="${b.x}" y="${b.y}" width="4" height="${b.h}" rx="2" fill="#1E293B"/>`);
    }
    if (b.kind === 'boundary') {
      parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="4" rx="2" fill="#475569"/>`);
    }
    if (b.tag) {
      parts.push(
        `<text x="${b.x + 9}" y="${b.y + 17}" font-size="11" font-weight="700" ` +
        `font-family="ui-monospace, Menlo, Consolas, monospace" fill="#0F172A">${esc(b.tag)}</text>`
      );
    }
    parts.push(
      `<text x="${b.x + 9}" y="${b.tag ? b.y + 32 : b.y + 22}" font-size="10.5" fill="#1E293B">` +
      `${esc(fit(b.name, b.w - 26))}</text>`
    );
    if (b.duty) {
      parts.push(
        `<text x="${b.x + 9}" y="${b.y + b.h - 9}" font-size="8.5" fill="#64748B">` +
        `${esc(fit(b.duty, b.w - 26))}</text>`
      );
    }
    if (b.assumption) {
      parts.push(
        `<circle cx="${b.x + b.w - 11}" cy="${b.y + 12}" r="7" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/>` +
        `<text x="${b.x + b.w - 11}" y="${b.y + 15.5}" font-size="8.5" font-weight="700" text-anchor="middle" fill="#92400E">A</text>`
      );
    }
    parts.push('</g>');
  }

  // ── Legend ─────────────────────────────────────────────────────────────────
  const legendY = g.height - g.legendH + 26;
  parts.push(`<line x1="${g.marginX}" y1="${legendY - 18}" x2="${g.width - g.marginX}" y2="${legendY - 18}" stroke="#CBD5E1"/>`);
  const svcList = Object.entries(model.services).sort((a, b) => a[1].order - b[1].order);
  svcList.forEach(([key, s], i) => {
    const x = g.marginX + (i % 4) * 260;
    const y = legendY + Math.floor(i / 4) * 20;
    parts.push(
      `<line x1="${x}" y1="${y}" x2="${x + 26}" y2="${y}" stroke="${s.color}" stroke-width="2" ` +
      `${s.dash ? `stroke-dasharray="${s.dash}"` : ''} marker-end="url(#ah-${key})"/>` +
      `<text x="${x + 34}" y="${y + 3.5}" font-size="10" fill="#334155">${esc(s.label)}</text>`
    );
  });
  const noteY = legendY + Math.ceil(svcList.length / 4) * 20 + 6;
  parts.push(
    `<circle cx="${g.marginX + 7}" cy="${noteY}" r="7" fill="#FEF3C7" stroke="#D97706"/>` +
    `<text x="${g.marginX + 7}" y="${noteY + 3.5}" font-size="8.5" font-weight="700" text-anchor="middle" fill="#92400E">A</text>` +
    `<text x="${g.marginX + 22}" y="${noteY + 3.5}" font-size="10" fill="#334155">` +
    `Parameter is an assumption, not a stated duty — ${model.assumptions.length} block(s) on this sheet. ` +
    `Circled numbers key into the stream table.</text>`
  );
  parts.push('</svg>');
  return parts.join('\n');
}

// ── Mermaid ──────────────────────────────────────────────────────────────────

const mermaidId = (id) => String(id).replace(/[^A-Za-z0-9_]/g, '_');

/** A mermaid flowchart, for markdown and chat contexts that render it natively. */
function toMermaid(model) {
  const lines = ['flowchart LR'];
  const byArea = new Map();
  for (const b of model.blocks) {
    const key = b.area || 'other';
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(b);
  }
  for (const lane of model.lanes) {
    const blocks = byArea.get(lane.area) || [];
    if (!blocks.length) continue;
    lines.push(`  subgraph ${mermaidId(lane.area)}["${lane.no}. ${lane.title}"]`);
    for (const b of blocks) {
      const text = `${b.tag ? `${b.tag}<br/>` : ''}${b.name}`;
      const shape = b.kind === 'boundary' ? [`([`, `])`]
        : b.kind === 'machine' ? ['[[', ']]']
          : b.kind === 'dosing' ? ['{{', '}}']
            : ['[', ']'];
      lines.push(`    ${mermaidId(b.id)}${shape[0]}"${text}"${shape[1]}`);
    }
    lines.push('  end');
  }
  for (const s of model.streams) {
    const bits = [String(s.no)];
    if (s.size) bits.push(s.size);
    if (s.Q_m3_d != null) bits.push(`${s.Q_m3_d} m³/d`);
    const arrow = s.recycle ? '-.->' : '-->';
    lines.push(`  ${mermaidId(s.from)} ${arrow}|"${bits.join(' · ')}"| ${mermaidId(s.to)}`);
  }
  return lines.join('\n');
}

// ── Stream table ─────────────────────────────────────────────────────────────

/** Rows keyed to the circled numbers on the sheet. */
function streamTable(model) {
  return model.streams.map((s) => ({
    no: s.no,
    from: s.fromLabel,
    to: s.toLabel,
    service: s.serviceLabel,
    size: s.size || '—',
    Q_m3_d: s.Q_m3_d,
    TSS: s.quality ? +s.quality.TSS.toFixed(1) : null,
    BOD: s.quality ? +s.quality.BOD.toFixed(1) : null,
    TN: s.quality ? +s.quality.TN.toFixed(1) : null,
    TP: s.quality ? +s.quality.TP.toFixed(2) : null,
    pH: s.quality ? +s.quality.pH.toFixed(2) : null,
    inlineEquipment: s.inlineEquipment.join(', ') || '—',
    note: s.label || '',
  }));
}

module.exports = { buildDiagram, toSvg, toMermaid, streamTable, SERVICES, PFD_HIDDEN };
