/**
 * WaterSim Pro — Steady-State Solver  (Session 4 — Step 19)
 *
 * Supports:
 *   - Linear process trains
 *   - Branching (splitters) and merging (mixers)
 *   - RAS / WAS loops — fixed-point iteration (max 50 iterations, ε = 0.01%)
 *   - Named recycle edges: edge.data.streamType === 'ras' | 'was' | 'recycle'
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
  // OPC integration
  opc_read:         require('./models/opcRead'),
  opc_write:        require('./models/opcWrite'),
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
  pump: null, blower: null, tank: null,
  opc_read: 'opc_read', opc_write: 'opc_write',
};

const SOURCE_TYPES = new Set(['inlet']);
const SINK_TYPES   = new Set(['outlet']);
const RECYCLE_STREAM_TYPES = new Set(['ras', 'was', 'recycle', 'internal_recycle']);
const CONVERGENCE_TOL = 0.0001;
const MAX_ITERATIONS  = 50;
const OPC_STREAM_VARS = new Set(['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'NO2', 'TP', 'DO', 'pH', 'temp']);

/**
 * Scan all opc_read nodes and collect OPC overrides from their tagMappings.
 * When a variable is read from OPC, its lastValue takes absolute priority
 * over any internally stored or computed value.
 *
 * @returns {{ [streamVar: string]: number }} e.g. { Q: 8500, TSS: 250 }
 */
function collectOpcOverrides(nodes, nodeParams) {
  const overrides = {};
  for (const node of nodes) {
    const raw = node.data?.opType || node.data?.type || '';
    if (raw !== 'opc_read' && PALETTE_TYPE_MAP[raw] !== 'opc_read') continue;

    const params   = nodeParams[node.id] || {};
    const mappings = params.tagMappings || [];
    for (const m of mappings) {
      if (!m.streamVar || !OPC_STREAM_VARS.has(m.streamVar)) continue;
      if (m.lastValue == null) continue;
      const val = Number(m.lastValue);
      if (!isNaN(val)) overrides[m.streamVar] = val;
    }
  }
  return overrides;
}

function resolveNodeType(node) {
  const raw = node.data?.opType || node.data?.type || node.id.replace(/_\d+$/, '');
  if (MODELS[raw]) return raw;
  const mapped = PALETTE_TYPE_MAP[raw];
  if (mapped === null) return 'passthrough';
  if (mapped !== undefined) return mapped;
  const stripped = raw.replace(/_\d+$/, '');
  return (PALETTE_TYPE_MAP[stripped] || MODELS[stripped]) ? (PALETTE_TYPE_MAP[stripped] || stripped) : raw;
}

function isRecycleEdge(edge, topoIndexMap) {
  const st = edge.data?.streamType;
  if (st && RECYCLE_STREAM_TYPES.has(st)) return true;
  if (edge.data?.isRecycle === true) return true;
  if (topoIndexMap) {
    const si = topoIndexMap.get(edge.source);
    const ti = topoIndexMap.get(edge.target);
    if (si !== undefined && ti !== undefined && ti <= si) return true;
  }
  return false;
}

function buildGraph(nodes, edges, topoIndexMap) {
  const downstream    = new Map();
  const upstream      = new Map();
  const edgesByTarget = new Map();
  const edgesBySource = new Map();
  const recycleEdges  = [];

  for (const n of nodes) {
    downstream.set(n.id, []);
    upstream.set(n.id, []);
    edgesByTarget.set(n.id, []);
    edgesBySource.set(n.id, []);
  }

  for (const e of edges) {
    if (isRecycleEdge(e, topoIndexMap)) {
      recycleEdges.push(e);
      // Still register in source/target so streams can be stored/read
      edgesBySource.get(e.source)?.push(e.id);
      edgesByTarget.get(e.target)?.push(e.id);
    } else {
      downstream.get(e.source)?.push(e.target);
      upstream.get(e.target)?.push(e.source);
      edgesByTarget.get(e.target)?.push(e.id);
      edgesBySource.get(e.source)?.push(e.id);
    }
  }

  return { downstream, upstream, edgesByTarget, edgesBySource, recycleEdges };
}

function topoOrder(nodes, downstream, upstream) {
  const order   = [];
  const visited = new Set();
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const queue   = nodes.filter(n => {
    const t = resolveNodeType(n);
    return SOURCE_TYPES.has(t) || (upstream.get(n.id) || []).length === 0;
  });
  while (queue.length) {
    const n = queue.shift();
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    order.push(n.id);
    for (const cid of (downstream.get(n.id) || [])) {
      const c = nodeMap[cid];
      if (c && !visited.has(cid)) queue.push(c);
    }
  }
  for (const n of nodes) if (!visited.has(n.id)) order.push(n.id);
  return order;
}

function hasConverged(prev, curr) {
  if (!prev || !curr) return false;
  for (const k of ['Q', 'TSS', 'BOD', 'TN', 'NH4', 'NO3', 'TP']) {
    const p = prev[k] ?? 0;
    const c = curr[k] ?? 0;
    const ref = Math.max(Math.abs(p), Math.abs(c), 1e-6);
    if (Math.abs(c - p) / ref > CONVERGENCE_TOL) return false;
  }
  return true;
}

function executePass(order, nodeMap, edgesByTarget, edgesBySource, edgeStreams, nodeParams, recycleEdgeIds, warnings) {
  const unitResults = {};

  for (const nodeId of order) {
    const node   = nodeMap[nodeId];
    if (!node) continue;
    const type   = resolveNodeType(node);
    const model  = type === 'passthrough' ? null : MODELS[type];
    const params = nodeParams[nodeId] || {};

    const incomingEdgeIds = edgesByTarget.get(nodeId) || [];
    const forwardEdgeIds  = incomingEdgeIds.filter(eid => !recycleEdgeIds.has(eid));
    const recycleIncoming = incomingEdgeIds.filter(eid =>  recycleEdgeIds.has(eid));

    const forwardStreams = forwardEdgeIds.map(eid => edgeStreams[eid]).filter(Boolean);
    let influent = forwardStreams.length === 0 ? new Stream()
                 : forwardStreams.length === 1 ? forwardStreams[0]
                 : Stream.mix(forwardStreams);

    // Build named inputs, routing recycle streams
    const inputs = { influent };
    for (const eid of recycleIncoming) {
      const s = edgeStreams[eid];
      if (!s) continue;
      const role = edgeStreams[`__role_${eid}`] || 'RAS';
      if (role === 'ras' || role === 'RAS') {
        inputs.RAS = inputs.RAS ? Stream.mix([inputs.RAS, s]) : s;
      } else {
        inputs.influent = Stream.mix([inputs.influent, s]);
      }
    }

    let result;
    if (!model) {
      if (type !== 'passthrough') warnings.push(`Unknown op type: "${type}" (${nodeId}) — pass-through`);
      result = { effluent: influent.clone(), metrics: {} };
    } else {
      try {
        result = model.solve(inputs, params);
      } catch (err) {
        warnings.push(`Error solving ${nodeId}: ${err.message}`);
        result = { effluent: influent.clone(), metrics: { error: err.message } };
      }
    }

    unitResults[nodeId] = {
      type,
      paletteType: node.data?.opType || type,
      metrics: result.metrics || {},
      outputs: {},
    };
    const outMap = {
      effluent:      result.effluent,
      primarySludge: result.primarySludge,
      WAS:           result.WAS,
      RAS:           result.RAS,
      thickened:     result.thickened,
      filtrate:      result.filtrate,
      permeate:      result.permeate,
      concentrate:   result.concentrate,
      screenings:    result.screenings,
      // Session 8 — new output ports
      digestate:     result.digestate,  // anaerobic digester primary solids output
      backwash:      result.backwash,   // granular filter waste backwash
    };
    // Anaerobic digester: persist biogas data in metrics
    if (result.biogas) unitResults[nodeId].biogas = result.biogas;
    for (const [k, v] of Object.entries(outMap)) {
      if (v) unitResults[nodeId].outputs[k] = v.toJSON();
    }

    // Distribute outputs
    const outgoingEdgeIds = edgesBySource.get(nodeId) || [];
    const forwardOut  = outgoingEdgeIds.filter(eid => !recycleEdgeIds.has(eid));
    const recycleOut  = outgoingEdgeIds.filter(eid =>  recycleEdgeIds.has(eid));
    // For digester-type nodes, primary forward stream is digestate; UV/filter use effluent
    const effluent    = result.effluent || result.digestate || result.filtrate || influent;

    if (forwardOut.length === 1) {
      edgeStreams[forwardOut[0]] = effluent;
    } else if (forwardOut.length > 1) {
      const ratios = params.splitRatios || forwardOut.map(() => 1 / forwardOut.length);
      forwardOut.forEach((eid, i) => {
        edgeStreams[eid] = effluent.clone({ Q: effluent.Q * (ratios[i] ?? 1 / forwardOut.length) });
      });
    }

    for (const eid of recycleOut) {
      const rs = result.RAS || result.WAS || effluent.clone({ Q: params.recycleFlow_m3d || effluent.Q * 0.5 });
      edgeStreams[eid] = rs;
      edgeStreams[`__role_${eid}`] = result.RAS ? 'ras' : result.WAS ? 'was' : 'recycle';
    }
  }

  return unitResults;
}

/** Walk the topo order backwards to find the last node with a non-zero effluent output. */
function findLastEffluent(order, unitResults) {
  for (let i = order.length - 1; i >= 0; i--) {
    const r = unitResults[order[i]];
    if (!r) continue;
    const t = r.paletteType || r.type;
    // Skip inlet, outlet, opc nodes
    if (t === 'inlet' || t === 'outlet' || t === 'opc_read' || t === 'opc_write') continue;
    // Check all possible output keys
    const out = r.outputs?.effluent || r.outputs?.filtrate || r.outputs?.permeate
             || r.outputs?.digestate || r.outputs?.thickened;
    if (out && out.Q > 0) return out;
  }
  return null;
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

function runSteadyState(canvasData, config = {}) {
  const { nodes = [], edges = [] } = canvasData;
  const nodeParams   = config.nodeParams   || {};
  const permitLimits = config.permitLimits || null;

  if (nodes.length === 0) {
    return { streamResults: {}, unitResults: {}, summary: {}, warnings: ['Flowsheet has no nodes'], iterations: 0 };
  }

  // Inject permitLimits into outlet node params so outlet.solve() can use them
  const augmentedParams = { ...nodeParams };
  if (permitLimits) {
    for (const node of nodes) {
      const type = node.data?.opType || node.data?.type || '';
      if (type === 'outlet' || type.includes('outlet') || type.includes('disinfection') || type.includes('chlorination')) {
        augmentedParams[node.id] = { ...( augmentedParams[node.id] || {}), permitLimits };
      }
    }
  }

  // ── OPC Override Injection ────────────────────────────────────────────────
  // When variables are read from OPC, their lastValues take absolute priority
  // over internally stored inlet parameters. This ensures the simulation uses
  // live OPC values from the very first node in the process train.
  const opcOverrides = collectOpcOverrides(nodes, augmentedParams);
  if (Object.keys(opcOverrides).length > 0) {
    for (const node of nodes) {
      const type = resolveNodeType(node);
      if (!SOURCE_TYPES.has(type)) continue;
      augmentedParams[node.id] = { ...(augmentedParams[node.id] || {}), ...opcOverrides };
    }
  }

  if (nodes.length === 0) {
    return { streamResults: {}, unitResults: {}, summary: {}, warnings: ['Flowsheet has no nodes'], iterations: 0 };
  }

  const warnings = [];
  const nodeMap  = Object.fromEntries(nodes.map(n => [n.id, n]));

  // Pass 1 — topo order without recycle detection (to build index map)
  const g0 = buildGraph(nodes, edges, null);
  const order0 = topoOrder(nodes, g0.downstream, g0.upstream);
  const topoIndexMap = new Map(order0.map((id, i) => [id, i]));

  // Pass 2 — rebuild with recycle detection using the topo index map
  const { downstream, upstream, edgesByTarget, edgesBySource, recycleEdges } =
    buildGraph(nodes, edges, topoIndexMap);
  const recycleEdgeIds = new Set(recycleEdges.map(e => e.id));

  if (recycleEdges.length > 0) {
    warnings.push(`Detected ${recycleEdges.length} recycle stream(s) — running fixed-point iteration`);
  }

  const order = topoOrder(nodes, downstream, upstream);

  // Init recycle stream state (cold start = zero flow)
  const edgeStreams = {};
  for (const re of recycleEdges) {
    edgeStreams[re.id] = new Stream({ Q: 0 });
  }

  let unitResults = {};
  let iterations  = 0;
  let converged   = (recycleEdges.length === 0);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations = iter + 1;
    const prevRecycle = {};
    for (const re of recycleEdges) prevRecycle[re.id] = edgeStreams[re.id]?.toJSON();

    unitResults = executePass(
      order, nodeMap, edgesByTarget, edgesBySource,
      edgeStreams, augmentedParams, recycleEdgeIds, warnings
    );

    if (recycleEdges.length > 0) {
      converged = recycleEdges.every(re => hasConverged(prevRecycle[re.id], edgeStreams[re.id]?.toJSON()));
      if (converged) break;
    } else {
      break;
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
  };
  if (inletNodes.length) {
    summary.influent = unitResults[inletNodes[0].id]?.outputs?.effluent || null;
  }
  if (outletNodes.length) {
    const r = unitResults[outletNodes[0].id];
    const outEff = r?.outputs?.effluent;
    // If the outlet node has no incoming edge its Q will be 0 — fall back to
    // the last process node in topological order that produced a non-zero output.
    if (outEff && outEff.Q > 0) {
      summary.effluent = outEff;
    } else {
      summary.effluent = findLastEffluent(order, unitResults) || outEff || null;
    }
    summary.permit_violations = r?.metrics?.permit_violations || [];
    summary.compliant         = r?.metrics?.compliant ?? null;
  } else {
    // No outlet node at all — use the last process node's output
    summary.effluent = findLastEffluent(order, unitResults) || null;
  }

  return { streamResults, unitResults, summary, warnings, iterations };
}

module.exports = { runSteadyState, MODELS, resolveNodeType, PALETTE_TYPE_MAP, collectOpcOverrides };
