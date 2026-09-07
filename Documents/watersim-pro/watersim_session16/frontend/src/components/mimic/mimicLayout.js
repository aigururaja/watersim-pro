/**
 * mimicLayout — geometry and flow logic for the schematic (mimic) view.
 *
 * The canvas already holds a laid-out plant: every node has a position, every
 * edge a source and target. This module turns that into what a mimic needs:
 *
 *   ports()        where a pipe leaves and enters each piece of equipment
 *   routePipe()    an orthogonal pipe run between two ports, with the corner
 *                  points where flanges are drawn
 *   propagateFlow() which pipes carry water right now, from MEASURED states:
 *                  a running pump pushes, a closed valve blocks, an inlet
 *                  always supplies, a vessel passes on what reaches it
 *   streamStyle()  the colour of what is in the pipe, by stream type
 *
 * Nothing here is modelled: a pipe moves because a measured contact says the
 * drive upstream is running, or because the source is an inlet.
 */

export const NODE_W = 168;
export const NODE_H = 116;

/** Equipment families for drawing and for flow logic. */
export const FAMILY = {
  inlet: 'source', outlet: 'sink',
  pump: 'drive', blower: 'drive', sludge_centrifuge: 'drive',
  valve: 'valve',
  equalisation_tank: 'tank', tank: 'tank', sbr_reactor: 'tank', anaerobic_digester: 'tank',
  activated_carbon_filter: 'vessel', multigrade_filter: 'vessel', micron_filter: 'vessel', pressure_filter: 'vessel',
  water_softener: 'vessel', sand_filter: 'vessel', granular_filter: 'vessel', uf_membrane: 'vessel', ro_membrane: 'vessel', gac_adsorption: 'vessel',
  instrument: 'instrument',
  chemical_dosing: 'dosing', polymer_dosing: 'dosing', coagulant_dosing: 'dosing', chlorination: 'dosing', ph_adjustment: 'dosing',
  oil_grease_trap: 'basin', screening: 'basin', grit_removal: 'basin', primary_clarifier: 'basin', secondary_clarifier: 'basin', thickener: 'basin',
  activated_sludge: 'basin', uct_reactor: 'basin', jhb_reactor: 'basin', membrane_bioreactor: 'basin', coagulation: 'basin', uv_disinfection: 'vessel',
};
export const familyOf = (opType) => FAMILY[opType] || 'basin';

/** Ports: water enters on the left, leaves on the right, at the equipment's centre line. */
export function ports(node) {
  const x = node.position?.x ?? 0;
  const y = node.position?.y ?? 0;
  return {
    in: { x, y: y + NODE_H / 2 },
    out: { x: x + NODE_W, y: y + NODE_H / 2 },
    cx: x + NODE_W / 2, cy: y + NODE_H / 2,
  };
}

/**
 * Orthogonal run from `a` to `b`: leave horizontally, turn once or twice,
 * arrive horizontally. Returns the polyline points (corners get flanges) and
 * the SVG path with rounded bends.
 */
export function routePipe(a, b, { stub = 22, bend = 10 } = {}) {
  const pts = [];
  const sx = a.x, sy = a.y, tx = b.x, ty = b.y;
  pts.push({ x: sx, y: sy });
  if (tx - sx >= 2 * stub && Math.abs(sy - ty) < 1) {
    pts.push({ x: tx, y: ty });
  } else if (tx - sx >= 2 * stub) {
    // forward: out, across, up/down, in
    const midX = sx + Math.max(stub, (tx - sx) / 2);
    pts.push({ x: midX, y: sy }, { x: midX, y: ty }, { x: tx, y: ty });
  } else {
    // backward (a recycle): out a stub, drop below both, come back, up, in
    const dropY = Math.max(sy, ty) + NODE_H * 0.75;
    pts.push({ x: sx + stub, y: sy }, { x: sx + stub, y: dropY }, { x: tx - stub, y: dropY }, { x: tx - stub, y: ty }, { x: tx, y: ty });
  }
  return polyline(pts, bend);
}

/** An orthogonal polyline as a rounded SVG path, with its corners (for flanges) and length. */
export function polyline(pts, bend = 10) {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if (!next) { d += ` L ${p.x} ${p.y}`; break; }
    const r = Math.min(bend, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const ux = Math.sign(p.x - prev.x), uy = Math.sign(p.y - prev.y);
    const vx = Math.sign(next.x - p.x), vy = Math.sign(next.y - p.y);
    d += ` L ${p.x - ux * r} ${p.y - uy * r} Q ${p.x} ${p.y} ${p.x + vx * r} ${p.y + vy * r}`;
  }
  const corners = pts.slice(1, -1);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return { d, points: pts, corners, length };
}

/** Pipe contents by stream type: colour, and whether it is a liquid (moves as water) or air. */
export function streamStyle(streamType) {
  switch (streamType) {
    case 'was': case 'thickened': case 'sludge': return { color: '#8a7a55', light: '#b8a97f', kind: 'sludge' };
    case 'recycle': case 'ras': return { color: '#c48a3c', light: '#e9c48c', kind: 'recycle' };
    case 'backwash': case 'concentrate': case 'reject': return { color: '#b96a6a', light: '#e0a0a0', kind: 'reject' };
    case 'filtrate': case 'permeate': return { color: '#3ea6d6', light: '#9ad8f0', kind: 'water' };
    case 'air': return { color: '#8fd3e8', light: '#d6f1fa', kind: 'air' };
    case 'chemical': return { color: '#c2578a', light: '#ecaacc', kind: 'chemical' };
    default: return { color: '#4aa9d3', light: '#a6dcf2', kind: 'water' };
  }
}

/**
 * Which pipes flow, from measured states.
 * @param {Array} nodes  canvas nodes
 * @param {Array} edges  canvas edges
 * @param {Map}   state  nodeId → { running, opened, closed, tripped, level } (measured; undefined = unknown)
 * @returns {{ flowing: Set<string>, active: Set<string> }} edge ids that flow, node ids that are wet
 */
export function propagateFlow(nodes, edges, state) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of edges) { if (!incoming.has(e.target)) incoming.set(e.target, []); incoming.get(e.target).push(e); }
  const active = new Set();
  const flowing = new Set();

  const passes = (node, wetIn) => {
    const fam = familyOf(node.data?.opType);
    const s = state.get(node.id) || {};
    switch (fam) {
      case 'source': return true;
      case 'drive':
        // A drive pushes only when its contact says it runs; with no contact bound, water passes if it arrives.
        return s.running === true || (s.running == null && wetIn);
      case 'valve':
        if (s.closed === true || s.opened === false) return false;
        return wetIn;
      case 'tank':
        // A tank with a measured level above zero can feed its outlet even when nothing arrives.
        return wetIn || (typeof s.level === 'number' && s.level > 2);
      case 'sink': return false;
      default: return wetIn;
    }
  };

  // Iterate to a fixed point (recycles make the graph cyclic).
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const n of nodes) {
      const ins = incoming.get(n.id) || [];
      const wetIn = ins.some((e) => flowing.has(e.id));
      const out = passes(n, wetIn);
      if (out && !active.has(n.id)) { active.add(n.id); changed = true; }
      if (wetIn && familyOf(n.data?.opType) === 'sink' && !active.has(n.id)) { active.add(n.id); changed = true; }
    }
    for (const e of edges) {
      const src = byId.get(e.source);
      if (!src) continue;
      const should = active.has(e.source) && familyOf(src.data?.opType) !== 'sink';
      if (should && !flowing.has(e.id)) { flowing.add(e.id); changed = true; }
    }
    if (!changed) break;
  }
  return { flowing, active };
}

/** Bounds of a layout, padded, for the SVG viewBox. */
export function layoutBounds(nodes, pad = 80) {
  if (!nodes.length) return { x: 0, y: 0, w: 800, h: 400 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = n.position?.x ?? 0, y = n.position?.y ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W); maxY = Math.max(maxY, y + NODE_H);
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + 40 };
}
