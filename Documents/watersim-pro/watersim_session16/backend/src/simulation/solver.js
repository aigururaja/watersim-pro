/**
 * WaterSim Pro — Steady-State Solver  (Session 4 — Step 19; graph/mass-balance rework Session 16)
 *
 * Supports:
 *   - Linear process trains
 *   - Branching (splitters) and merging (mixers) — true DAGs are solved in one pass
 *   - RAS / WAS loops — fixed-point iteration (max 50 iterations, ε = 0.01%) with
 *     0.5 relaxation damping when oscillation is detected
 *   - Named stream roles on edges: edge.data.role / edge.data.port / edge.sourceHandle /
 *     edge.data.streamType (e.g. 'ras', 'was', 'sludge', 'backwash', 'concentrate')
 *
 * Ordering uses Kahn's algorithm (in-degree counting). True cycles are detected
 * structurally (SCC membership / DFS back-edges); only edges that are genuinely
 * part of a cycle are torn for fixed-point iteration. Feed-forward branch-and-merge
 * DAGs are never misclassified as recycles.
 *
 * Honesty guarantees:
 *   - Unrouted side streams (WAS, sludge, backwash, …) are warned about and reported
 *     in summary.unroutedLosses instead of silently vanishing.
 *   - Non-finite values are swept to null, warned about, and flag the run degraded.
 *   - The result carries { converged, iterations, maxResidual, degraded }.
 */
'use strict';

const { Stream } = require('./stream');

const MODELS = {
  inlet:            require('./models/inlet'),
  outlet:           require('./models/outlet'),
  screen:           require('./models/screen'),
  grit:             require('./models/grit'),
  prim_clarifier:   require('./models/primaryClarifier'),
  aeration:         require('./models/aerationBasin'),
  sec_clarifier:    require('./models/secondaryClarifier'),
  thickener:        require('./models/sludgeThickener'),
  ro:               require('./models/roMembrane'),
  chemical_dosing:  require('./models/chemicalDosing'),
  // Session 8 — Step 38: Tertiary treatment models
  uv_disinfection:  require('./models/uvDisinfection'),
  granular_filter:  require('./models/granularFilter'),
  // Session 8 — Step 39: ADM1-lite anaerobic digestion
  anaerobic_digest: require('./models/anaerobicDigester'),
  // Session 17: flow-control elements (pump on/off, valve open/close)
  pump:             require('./models/pump'),
  valve:            require('./models/valve'),
};

const PALETTE_TYPE_MAP = {
  inlet: 'inlet', outlet: 'outlet',
  screening: 'screen', screen: 'screen',
  grit_removal: 'grit', grit: 'grit',
  primary_clarifier: 'prim_clarifier', prim_clarifier: 'prim_clarifier',
  activated_sludge: 'aeration', aeration: 'aeration',
  secondary_clarifier: 'sec_clarifier', sec_clarifier: 'sec_clarifier',
  membrane_bioreactor: 'aeration',
  // Session 9 — Step 40: Advanced EBPR node types (all share the aeration basin model)
  uct_reactor:         'aeration',
  jhb_reactor:         'aeration',
  ebpr_uct:            'aeration',
  ebpr_jhb:            'aeration',
  anaerobic_digester: 'anaerobic_digest',
  ro_membrane: 'ro', ro: 'ro',
  uf_membrane: 'screen', coagulation: 'chemical_dosing',
  sand_filter: 'granular_filter', granular_filter: 'granular_filter',
  uv_disinfection: 'uv_disinfection', chlorination: 'chemical_dosing',
  gac_adsorption: 'screen',
  thickener: 'thickener', sludge_thickener: 'thickener',
  chemical_dosing: 'chemical_dosing',
  coagulant_dosing: 'chemical_dosing',
  polymer_dosing: 'chemical_dosing',
  ph_adjustment: 'chemical_dosing',
  pump: 'pump', valve: 'valve',
  blower: null, tank: null,
};

const SOURCE_TYPES = new Set(['inlet']);
const SINK_TYPES   = new Set(['outlet']);
const RECYCLE_STREAM_TYPES = new Set(['ras', 'was', 'recycle', 'internal_recycle']);
const CONVERGENCE_TOL = 0.0001;
const MAX_ITERATIONS  = 50;

// Map a normalized edge role to the named model output it carries.
const PORT_ALIASES = {
  ras: 'RAS', was: 'WAS',
  sludge: 'primarySludge', primary_sludge: 'primarySludge', primarysludge: 'primarySludge',
  thickened: 'thickened', filtrate: 'filtrate', permeate: 'permeate',
  concentrate: 'concentrate', screenings: 'screenings',
  digestate: 'digestate', backwash: 'backwash', effluent: 'effluent',
};

// Named output ports a model may emit (order matters only for reporting).
const OUTPUT_PORTS = [
  'effluent', 'primarySludge', 'WAS', 'RAS', 'thickened', 'filtrate',
  'permeate', 'concentrate', 'screenings', 'digestate', 'backwash',
];

function resolveNodeType(node) {
  const raw = node.data?.opType || node.data?.type || node.id.replace(/_\d+$/, '');
  if (MODELS[raw]) return raw;
  const mapped = PALETTE_TYPE_MAP[raw];
  if (mapped === null) return 'passthrough';
  if (mapped !== undefined) return mapped;
  const stripped = raw.replace(/_\d+$/, '');
  return (PALETTE_TYPE_MAP[stripped] || MODELS[stripped]) ? (PALETTE_TYPE_MAP[stripped] || stripped) : raw;
}

/** Normalized role annotation for an edge, or null for a plain forward stream. */
function edgeRole(edge) {
  const raw = edge.data?.role ?? edge.data?.port ?? edge.sourceHandle ?? edge.data?.streamType ?? edge.label;
  if (raw == null) return null;
  const norm = String(raw).toLowerCase().replace(/[-\s]/g, '_');
  if (norm === '' || norm === 'stream' || norm === 'forward' || norm === 'default') return null;
  return norm;
}

/** Explicitly marked as a recycle-type connection (used for cycle-tear preference only). */
function isMarkedRecycle(edge) {
  if (edge.data?.isRecycle === true) return true;
  const st = edge.data?.streamType;
  return !!(st && RECYCLE_STREAM_TYPES.has(String(st).toLowerCase()));
}

// ── Graph analysis ────────────────────────────────────────────────────────────

/** Tarjan strongly-connected components. Returns Map nodeId → sccId, and sizes. */
function stronglyConnectedComponents(nodeIds, adjacency) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const sccOf = new Map(), sccSize = new Map();
  const stack = [];
  let counter = 0, sccCounter = 0;

  // Iterative Tarjan to avoid recursion limits on large flowsheets.
  for (const start of nodeIds) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v] = frame;
      if (frame[1] === 0) {
        index.set(v, counter); low.set(v, counter); counter++;
        stack.push(v); onStack.add(v);
      }
      let advanced = false;
      const nbrs = adjacency.get(v) || [];
      while (frame[1] < nbrs.length) {
        const w = nbrs[frame[1]++];
        if (!index.has(w)) { work.push([w, 0]); advanced = true; break; }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (advanced) continue;
      if (low.get(v) === index.get(v)) {
        const id = sccCounter++;
        let size = 0, w;
        do {
          w = stack.pop(); onStack.delete(w);
          sccOf.set(w, id); size++;
        } while (w !== v);
        sccSize.set(id, size);
      }
      work.pop();
      if (work.length) {
        const [parent] = work[work.length - 1];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
    }
  }
  return { sccOf, sccSize };
}

/**
 * Decide which edges must be torn for fixed-point iteration.
 * Only edges genuinely on a cycle are torn:
 *   1. explicitly-marked recycle edges whose endpoints share an SCC;
 *   2. DFS back-edges remaining after (1) — unmarked cycles, warned about.
 */
function findTornEdges(nodes, edges, warnings) {
  const nodeIds = nodes.map(n => n.id);
  const idSet   = new Set(nodeIds);
  const valid   = edges.filter(e => idSet.has(e.source) && idSet.has(e.target));

  const adjAll = new Map(nodeIds.map(id => [id, []]));
  for (const e of valid) adjAll.get(e.source).push(e.target);

  const { sccOf, sccSize } = stronglyConnectedComponents(nodeIds, adjAll);
  const inCycle = e =>
    sccOf.get(e.source) === sccOf.get(e.target) &&
    (sccSize.get(sccOf.get(e.source)) > 1 || e.source === e.target);

  const torn = new Set();
  for (const e of valid) {
    if (isMarkedRecycle(e) && inCycle(e)) torn.add(e.id);
  }

  // Remaining graph may still contain unmarked cycles — tear DFS back-edges.
  const adj2 = new Map(nodeIds.map(id => [id, []]));
  for (const e of valid) if (!torn.has(e.id)) adj2.get(e.source).push(e);
  const color = new Map(); // 0 white, 1 gray, 2 black
  const dfs = (start) => {
    const work = [[start, 0]];
    color.set(start, 1);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v] = frame;
      const outs = adj2.get(v) || [];
      let advanced = false;
      while (frame[1] < outs.length) {
        const e = outs[frame[1]++];
        const c = color.get(e.target) || 0;
        if (c === 1) {
          torn.add(e.id);
          warnings.push(
            `Cycle detected on edge ${e.id} (${e.source} → ${e.target}) with no recycle designation — tearing it and iterating`);
        } else if (c === 0) {
          color.set(e.target, 1);
          work.push([e.target, 0]);
          advanced = true;
          break;
        }
      }
      if (!advanced) { color.set(v, 2); work.pop(); }
    }
  };
  for (const id of nodeIds) if ((color.get(id) || 0) === 0) dfs(id);

  return torn;
}

/** Kahn's algorithm over the forward (non-torn) edges. */
function kahnOrder(nodes, edges, tornEdgeIds, warnings, state) {
  const idSet = new Set(nodes.map(n => n.id));
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const out   = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    if (tornEdgeIds.has(e.id) || !idSet.has(e.source) || !idSet.has(e.target)) continue;
    indeg.set(e.target, indeg.get(e.target) + 1);
    out.get(e.source).push(e.target);
  }
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  const order = [];
  const seen  = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const t of out.get(id)) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  if (order.length < nodes.length) {
    // Should be impossible once all cycles are torn — fail loudly, not silently.
    for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);
    warnings.push('Internal ordering error: topological sort did not cover all nodes — run marked degraded');
    state.degraded = true;
  }
  return order;
}

// ── Convergence helpers ───────────────────────────────────────────────────────

const RESIDUAL_KEYS = ['Q', 'TSS', 'BOD', 'TN', 'NH4', 'NO3', 'TP'];

function streamResidual(prev, curr) {
  if (!prev || !curr) return Infinity;
  let max = 0;
  for (const k of RESIDUAL_KEYS) {
    const p = prev[k] ?? 0;
    const c = curr[k] ?? 0;
    const ref = Math.max(Math.abs(p), Math.abs(c), 1e-6);
    max = Math.max(max, Math.abs(c - p) / ref);
  }
  return max;
}

function relaxStream(prevJSON, curr, factor) {
  const blend = {};
  for (const k of ['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'NO2', 'TP', 'DO', 'pH', 'temp']) {
    const p = prevJSON?.[k] ?? 0;
    const c = curr?.[k] ?? 0;
    blend[k] = p + factor * (c - p);
  }
  return new Stream(blend);
}

// ── Execution ────────────────────────────────────────────────────────────────

function componentLoads(stream) {
  const out = {};
  for (const [k, label] of [['TSS', 'TSS_kg_d'], ['BOD', 'BOD_kg_d'], ['COD', 'COD_kg_d'], ['TN', 'TN_kg_d'], ['TP', 'TP_kg_d']]) {
    out[label] = +(((stream.Q || 0) * (stream[k] || 0)) / 1000).toFixed(3);
  }
  return out;
}

function executePass(ctx) {
  const {
    order, nodeMap, edgesByTarget, edgesBySource, roleByEdge,
    edgeStreams, nodeParams, tornEdgeIds, warnings, unroutedLosses, state,
  } = ctx;
  const unitResults = {};

  for (const nodeId of order) {
    const node = nodeMap[nodeId];
    if (!node) continue;
    const type   = resolveNodeType(node);
    const model  = type === 'passthrough' ? null : MODELS[type];
    const params = nodeParams[nodeId] || {};

    const incomingEdges   = edgesByTarget.get(nodeId) || [];
    const forwardIncoming = incomingEdges.filter(e => !tornEdgeIds.has(e.id));
    const tornIncoming    = incomingEdges.filter(e =>  tornEdgeIds.has(e.id));

    const forwardStreams = forwardIncoming.map(e => edgeStreams[e.id]).filter(Boolean);
    if (forwardIncoming.length > 0 && forwardStreams.length === 0) {
      warnings.push(`Node ${nodeId} has upstream connections but no solved upstream stream — run marked degraded`);
      state.degraded = true;
    }
    let influent = forwardStreams.length === 0 ? new Stream()
                 : forwardStreams.length === 1 ? forwardStreams[0]
                 : Stream.mix(forwardStreams);

    // Route torn (recycle) inflows by their declared role — never guess 'RAS'.
    const inputs = { influent };
    for (const e of tornIncoming) {
      const s = edgeStreams[e.id];
      if (!s) continue;
      if (roleByEdge.get(e.id) === 'ras') {
        inputs.RAS = inputs.RAS ? Stream.mix([inputs.RAS, s]) : s;
      } else {
        inputs.influent = Stream.mix([inputs.influent, s]);
      }
    }

    let result;
    if (!model) {
      if (type !== 'passthrough') warnings.push(`Unknown op type: "${type}" (${nodeId}) — pass-through`);
      result = { effluent: inputs.influent.clone(), metrics: {} };
    } else {
      try {
        result = model.solve(inputs, params);
      } catch (err) {
        warnings.push(`Error solving ${nodeId}: ${err.message}`);
        result = { effluent: inputs.influent.clone(), metrics: { error: err.message } };
      }
    }

    unitResults[nodeId] = {
      type,
      paletteType: node.data?.opType || type,
      metrics: result.metrics || {},
      outputs: {},
    };
    if (result.biogas) unitResults[nodeId].biogas = result.biogas;

    const outputs = {};
    for (const port of OUTPUT_PORTS) if (result[port]) outputs[port] = result[port];
    for (const [k, v] of Object.entries(outputs)) unitResults[nodeId].outputs[k] = v.toJSON();

    // Primary forward output for this node type.
    const primaryKey = result.effluent ? 'effluent'
                     : result.digestate ? 'digestate'
                     : result.filtrate ? 'filtrate'
                     : result.permeate ? 'permeate'
                     : null;
    let primary = primaryKey ? outputs[primaryKey] : inputs.influent;

    // ── Distribute outputs to outgoing edges ────────────────────────────────
    const outgoing = edgesBySource.get(nodeId) || [];
    const routed   = new Set();
    const plainOut = [];
    let primaryDeduction = 0;

    for (const e of outgoing) {
      const role = roleByEdge.get(e.id);
      if (!role) { plainOut.push(e); continue; }

      const port = PORT_ALIASES[role];
      if (port && outputs[port]) {
        edgeStreams[e.id] = outputs[port];
        routed.add(port);
        continue;
      }
      // Generic recycle designation: use the model's RAS output when it exists.
      if ((role === 'recycle' || role === 'internal_recycle') && outputs.RAS) {
        edgeStreams[e.id] = outputs.RAS;
        routed.add('RAS');
        continue;
      }
      // The edge names a stream this unit does not produce. Require an explicit
      // flow parameter; otherwise fail loudly with zero flow — never invent mass.
      const rf = params.recycleFlow_m3d ?? (params.recycleRatio != null ? primary.Q * params.recycleRatio : null);
      if (rf != null && Number.isFinite(rf) && rf >= 0) {
        const q = Math.min(rf, Math.max(0, primary.Q - primaryDeduction));
        edgeStreams[e.id] = primary.clone({ Q: q });
        primaryDeduction += q;
        routed.add(primaryKey || 'effluent');
      } else if (outgoing.length === 1) {
        // Single-outlet unit sitting ON a role-marked line (e.g. a pump or
        // valve inside a RAS return): forward the primary output. This is
        // mass-conserving — nothing else consumes the primary — and keeps the
        // stream's role intact for the downstream unit (the aeration basin
        // still receives it as RAS).
        edgeStreams[e.id] = primary;
        routed.add(primaryKey || 'effluent');
      } else {
        warnings.push(
          `Edge ${e.id} (${nodeId} → ${e.target}) requests stream '${role}' but ${nodeId} produces no such output ` +
          `and no recycleFlow_m3d/recycleRatio param is set — using zero flow`);
        edgeStreams[e.id] = new Stream({ Q: 0 });
      }
    }

    // Plain forward edges share the primary output.
    const primaryForSplit = primaryDeduction > 0
      ? primary.clone({ Q: Math.max(0, primary.Q - primaryDeduction) })
      : primary;
    if (plainOut.length === 1) {
      edgeStreams[plainOut[0].id] = primaryForSplit;
      routed.add(primaryKey || 'effluent');
    } else if (plainOut.length > 1) {
      let ratios = params.splitRatios;
      const usable = Array.isArray(ratios) && ratios.length === plainOut.length &&
        ratios.every(r => typeof r === 'number' && Number.isFinite(r) && r >= 0) &&
        ratios.reduce((s, r) => s + r, 0) > 0;
      if (usable) {
        const sum = ratios.reduce((s, r) => s + r, 0);
        if (Math.abs(sum - 1) > 0.01) {
          warnings.push(`splitRatios for ${nodeId} sum to ${sum.toFixed(3)} — normalized to 1`);
        }
        ratios = ratios.map(r => r / sum);
      } else {
        if (ratios != null) {
          warnings.push(`Invalid splitRatios for ${nodeId} (${plainOut.length} outlets) — defaulting to equal split`);
        } else {
          warnings.push(`No splitRatios provided for ${nodeId} with ${plainOut.length} outlets — defaulting to equal split`);
        }
        ratios = plainOut.map(() => 1 / plainOut.length);
      }
      plainOut.forEach((e, i) => {
        edgeStreams[e.id] = primaryForSplit.clone({ Q: primaryForSplit.Q * ratios[i] });
      });
      routed.add(primaryKey || 'effluent');
    }

    // ── Unrouted side streams: warn and record as explicit boundary losses ──
    for (const [name, s] of Object.entries(outputs)) {
      if (routed.has(name) || name === primaryKey) continue;
      if ((s.Q || 0) > 1e-9) {
        warnings.push(
          `Unrouted side stream '${name}' from ${nodeId} (Q=${s.Q.toFixed(2)} m³/d) — counted as a plant-boundary loss`);
        unroutedLosses.push({ node: nodeId, stream: name, Q_m3_d: +s.Q.toFixed(3), ...componentLoads(s) });
      }
    }
  }

  return unitResults;
}

// ── Non-finite sweep ─────────────────────────────────────────────────────────

function sweepNonFinite(value, counter) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) { counter.count++; return null; }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = sweepNonFinite(value[i], counter);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = sweepNonFinite(value[k], counter);
    return value;
  }
  return value;
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

function runSteadyState(canvasData, config = {}) {
  const { nodes = [], edges = [] } = canvasData;
  const nodeParams   = config.nodeParams   || {};
  const permitLimits = config.permitLimits || null;

  if (nodes.length === 0) {
    return {
      streamResults: {}, unitResults: {}, summary: {},
      warnings: ['Flowsheet has no nodes'],
      iterations: 0, converged: true, maxResidual: 0, degraded: false,
    };
  }

  // Inject permitLimits into outlet node params so outlet.solve() can use them
  const augmentedParams = { ...nodeParams };
  if (permitLimits) {
    for (const node of nodes) {
      const type = node.data?.opType || node.data?.type || '';
      if (type === 'outlet' || type.includes('outlet') || type.includes('disinfection') || type.includes('chlorination')) {
        augmentedParams[node.id] = { ...(augmentedParams[node.id] || {}), permitLimits };
      }
    }
  }

  const warnings = [];
  const state    = { degraded: false };
  const nodeMap  = Object.fromEntries(nodes.map(n => [n.id, n]));

  // ── Graph analysis: true cycles only ────────────────────────────────────────
  const tornEdgeIds = findTornEdges(nodes, edges, warnings);
  const recycleEdges = edges.filter(e => tornEdgeIds.has(e.id));
  const roleByEdge = new Map(edges.map(e => [e.id, edgeRole(e)]));

  const order = kahnOrder(nodes, edges, tornEdgeIds, warnings, state);

  const edgesByTarget = new Map(nodes.map(n => [n.id, []]));
  const edgesBySource = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    edgesByTarget.get(e.target)?.push(e);
    edgesBySource.get(e.source)?.push(e);
  }

  if (recycleEdges.length > 0) {
    warnings.push(`Detected ${recycleEdges.length} recycle stream(s) — running fixed-point iteration`);
  }

  // Init recycle stream state — warm-start from provided values, else cold (Q=0).
  const initStreams = config.initialRecycleStreams || null;
  const edgeStreams = {};
  for (const re of recycleEdges) {
    edgeStreams[re.id] = initStreams?.[re.id] ? new Stream(initStreams[re.id]) : new Stream({ Q: 0 });
  }

  let unitResults    = {};
  let iterations     = 0;
  let converged      = (recycleEdges.length === 0);
  let maxResidual    = 0;
  let prevResidual   = Infinity;
  let damping        = false;
  let passWarnings   = [];
  let unroutedLosses = [];

  const ctx = {
    order, nodeMap, edgesByTarget, edgesBySource, roleByEdge,
    edgeStreams, nodeParams: augmentedParams, tornEdgeIds,
    warnings: passWarnings, unroutedLosses, state,
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations = iter + 1;

    // Per-pass warning/loss buffers: only the final pass is reported.
    passWarnings   = [];
    unroutedLosses = [];
    ctx.warnings       = passWarnings;
    ctx.unroutedLosses = unroutedLosses;

    const prevRecycle = {};
    for (const re of recycleEdges) prevRecycle[re.id] = edgeStreams[re.id]?.toJSON();

    unitResults = executePass(ctx);

    if (recycleEdges.length === 0) break;

    // Damped update: after oscillation is detected, relax by 0.5.
    if (damping) {
      for (const re of recycleEdges) {
        edgeStreams[re.id] = relaxStream(prevRecycle[re.id], edgeStreams[re.id], 0.5);
      }
    }

    maxResidual = 0;
    for (const re of recycleEdges) {
      maxResidual = Math.max(maxResidual, streamResidual(prevRecycle[re.id], edgeStreams[re.id]?.toJSON()));
    }
    converged = maxResidual <= CONVERGENCE_TOL;
    if (converged) break;
    if (!damping && iter >= 1 && Number.isFinite(prevResidual) && maxResidual > prevResidual) {
      damping = true; // oscillating — engage 0.5 relaxation for subsequent iterations
    }
    prevResidual = maxResidual;
  }

  warnings.push(...passWarnings);

  // Hoist model-level warnings into the run-level warning list.
  for (const [nodeId, unit] of Object.entries(unitResults)) {
    const mw = unit?.metrics?.warnings;
    if (Array.isArray(mw)) {
      for (const w of mw) if (typeof w === 'string') warnings.push(`${nodeId}: ${w}`);
    }
  }

  if (!converged) {
    warnings.push(`Recycle streams did not converge in ${MAX_ITERATIONS} iterations — results may be approximate`);
  } else if (recycleEdges.length > 0) {
    warnings.push(`Recycle streams converged in ${iterations} iteration(s)`);
  }

  // Build streamResults from all edges
  const streamResults = {};
  for (const e of edges) {
    if (edgeStreams[e.id]) streamResults[e.id] = edgeStreams[e.id].toJSON();
  }

  // Summary
  const inletNodes  = nodes.filter(n => SOURCE_TYPES.has(resolveNodeType(n)));
  const outletNodes = nodes.filter(n => SINK_TYPES.has(resolveNodeType(n)));
  const summary = {
    nodeCount: nodes.length, edgeCount: edges.length,
    solvedNodes: order.length, warnings: warnings.length,
    iterations, recycleEdges: recycleEdges.length,
    unroutedLosses,
  };
  if (inletNodes.length) {
    summary.influent = unitResults[inletNodes[0].id]?.outputs?.effluent || null;
  }
  if (outletNodes.length) {
    const r = unitResults[outletNodes[0].id];
    summary.effluent          = r?.outputs?.effluent  || null;
    summary.permit_violations = r?.metrics?.permit_violations || [];
    summary.compliant         = r?.metrics?.compliant ?? null;
  }

  // Sweep non-finite values: replace with null, warn, and flag the run degraded.
  const counter = { count: 0 };
  sweepNonFinite(streamResults, counter);
  sweepNonFinite(unitResults, counter);
  sweepNonFinite(summary, counter);
  if (counter.count > 0) {
    warnings.push(`Non-finite value(s) detected in results (${counter.count} replaced with null) — run marked degraded`);
    state.degraded = true;
  }
  summary.warnings = warnings.length;

  return {
    streamResults, unitResults, summary, warnings, iterations,
    converged, maxResidual, degraded: state.degraded,
  };
}

module.exports = { runSteadyState, MODELS, resolveNodeType, PALETTE_TYPE_MAP };
