/**
 * Where to put the blocks read from a P&ID picture.
 *
 * The reader gives each unit's centre as a fraction of the picture. The
 * blocks follow the drawing: its arrangement is stretched until the cards
 * clear each other, and cards that still collide (two items read at almost
 * the same spot) are nudged down. Only when the positions carry nothing (every
 * unit at one spot) are the units laid out left to right in flow order.
 */

// A card is 168 x 116; a cell leaves room for the pipe between two cards.
export const CELL_W = 260;
export const CELL_H = 190;
const CARD_W = 168;
const CARD_H = 116;
// Pairs closer than this (as a fraction of the picture) count as one spot:
// they do not drive the stretch, the nudge separates them.
const SAME_SPOT = 0.03;

/**
 * @param {{id:string,x:number,y:number}[]} units  x, y as fractions of the picture
 * @param {{from:string,to:string}[]} connections
 * @param {{w:number,h:number,ox?:number,oy?:number}} box  the picture on the sheet
 * @param {{x:number,y:number}[]} [existing]  top-left of cards already on the
 *   sheet; if the new set would touch any of them it moves right, past them all
 * @returns {Record<string,{x:number,y:number}>}  top-left of each card
 */
export function layoutPidUnits(units, connections, box, existing = []) {
  const out = layoutFresh(units, connections, box);
  const fresh = Object.values(out);
  const touches = fresh.some((a) => existing.some((b) =>
    Math.abs(a.x - b.x) < CELL_W && Math.abs(a.y - b.y) < CELL_H));
  if (!touches) return out;
  const shift = Math.max(...existing.map((b) => b.x)) + CELL_W - Math.min(...fresh.map((a) => a.x));
  for (const p of fresh) p.x += shift;
  return out;
}

function layoutFresh(units, connections, { w, h, ox = 0, oy = 0 }) {
  if (!units.length) return {};
  const xs = units.map((u) => u.x);
  const ys = units.map((u) => u.y);
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (units.length > 1 && spread < SAME_SPOT) return flowOrder(units, connections, { h, ox, oy });

  // The stretch at which every pair of distinct spots is a cell apart on one axis.
  let stretch = 1;
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const fx = Math.abs(units[i].x - units[j].x);
      const fy = Math.abs(units[i].y - units[j].y);
      if (fx < SAME_SPOT && fy < SAME_SPOT) continue;
      const need = Math.min(fx ? CELL_W / (fx * w) : Infinity, fy ? CELL_H / (fy * h) : Infinity);
      stretch = Math.max(stretch, need);
    }
  }

  // Place left to right; a card that lands on one already placed moves down
  // a cell at a time until it is clear.
  const out = {};
  const placed = [];
  const order = [...units].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const u of order) {
    const p = { x: Math.round(ox + u.x * w * stretch - CARD_W / 2), y: Math.round(oy + u.y * h * stretch - CARD_H / 2) };
    while (placed.some((q) => Math.abs(p.x - q.x) < CARD_W + 24 && Math.abs(p.y - q.y) < CARD_H + 24)) p.y += CELL_H;
    placed.push(p);
    out[u.id] = p;
  }
  return out;
}

/** Columns by longest path from a feed; a column keeps the picture's top-to-bottom order. */
function flowOrder(units, connections, { h, ox, oy }) {
  const out = {};
  const ids = new Set(units.map((u) => u.id));
  const edges = connections.filter((c) => ids.has(c.from) && ids.has(c.to) && c.from !== c.to);
  const next = new Map(units.map((u) => [u.id, []]));
  const fed = new Set(edges.map((e) => e.to));
  for (const e of edges) next.get(e.from).push(e.to);
  // Depth-first from the feeds, dropping the back edge of each recycle loop,
  // so what is left has no cycles; then a unit's column is its longest path.
  const forward = [];
  const state = {};
  const visit = (id) => {
    state[id] = 'open';
    for (const to of next.get(id)) {
      if (state[to] === 'open') continue;
      forward.push([id, to]);
      if (!state[to]) visit(to);
    }
    state[id] = 'done';
  };
  for (const u of units) if (!fed.has(u.id) && !state[u.id]) visit(u.id);
  for (const u of units) if (!state[u.id]) visit(u.id);
  const col = Object.fromEntries(units.map((u) => [u.id, 0]));
  for (let pass = 0; pass < units.length; pass++) {
    let moved = false;
    for (const [from, to] of forward) {
      if (col[to] < col[from] + 1) { col[to] = col[from] + 1; moved = true; }
    }
    if (!moved) break;
  }
  const byCol = new Map();
  for (const u of units) {
    if (!byCol.has(col[u.id])) byCol.set(col[u.id], []);
    byCol.get(col[u.id]).push(u);
  }
  for (const [k, list] of byCol) {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    const top = -((list.length - 1) * CELL_H) / 2;
    list.forEach((u, i) => {
      out[u.id] = { x: Math.round(ox + k * CELL_W), y: Math.round(oy + h / 2 + top + i * CELL_H - CARD_H / 2) };
    });
  }
  return out;
}
