/**
 * Where to put the blocks read from a P&ID picture.
 *
 * The reader gives each unit's centre as a fraction of the picture. Mapped
 * straight onto the sheet, a small picture or a model that bunches its
 * answers puts cards on top of each other. So the drawing's arrangement is
 * kept but stretched until no two cards are closer than one cell; when that
 * would take an absurd stretch (two units at the same spot), the units are
 * laid out left to right in flow order instead.
 */

// A card is 168 x 116; a cell leaves room for the pipe between two cards.
export const CELL_W = 260;
export const CELL_H = 190;
const CARD_W = 168;
const CARD_H = 116;
const MAX_STRETCH = 4;

/**
 * @param {{id:string,x:number,y:number}[]} units  x, y as fractions of the picture
 * @param {{from:string,to:string}[]} connections
 * @param {{w:number,h:number,ox?:number,oy?:number}} box  the picture on the sheet
 * @returns {Record<string,{x:number,y:number}>}  top-left of each card
 */
export function layoutPidUnits(units, connections, { w, h, ox = 0, oy = 0 }) {
  if (!units.length) return {};
  const centres = units.map((u) => ({ id: u.id, x: u.x * w, y: u.y * h }));

  // The stretch at which every pair is at least a cell apart on one axis.
  let stretch = 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      const dx = Math.abs(centres[i].x - centres[j].x);
      const dy = Math.abs(centres[i].y - centres[j].y);
      const need = Math.min(dx ? CELL_W / dx : Infinity, dy ? CELL_H / dy : Infinity);
      stretch = Math.max(stretch, need);
    }
  }

  const out = {};
  if (stretch <= MAX_STRETCH) {
    // Stretch about the picture's top-left corner so the blocks start where it does.
    for (const c of centres) {
      out[c.id] = { x: Math.round(ox + c.x * stretch - CARD_W / 2), y: Math.round(oy + c.y * stretch - CARD_H / 2) };
    }
    return out;
  }

  // Flow order: a unit's column is its longest path from a feed; units in
  // one column keep their top-to-bottom order from the picture.
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
  for (const c of centres) {
    if (!byCol.has(col[c.id])) byCol.set(col[c.id], []);
    byCol.get(col[c.id]).push(c);
  }
  for (const [k, list] of byCol) {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    const top = -((list.length - 1) * CELL_H) / 2;
    list.forEach((c, i) => {
      out[c.id] = { x: Math.round(ox + k * CELL_W), y: Math.round(oy + h / 2 + top + i * CELL_H - CARD_H / 2) };
    });
  }
  return out;
}
