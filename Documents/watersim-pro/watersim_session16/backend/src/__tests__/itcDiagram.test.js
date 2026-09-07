/**
 * WaterSim Pro — ITC STP process flow diagram tests  (Session 18)
 *
 * The whole argument for generating this drawing is that it cannot drift from
 * the plant model. These tests are what makes that true rather than aspirational:
 *
 *   FIDELITY   every block and every stream traces back to a node or edge in
 *              flowsheet.js — the sheet cannot invent equipment, and it cannot
 *              quietly drop any either.
 *   HONESTY    a pipe size is only printed when it can be attributed; an assumed
 *              parameter is marked; the air header is declared as derived.
 *   GEOMETRY   blocks do not overlap, streams run forwards, and stream-number
 *              bubbles do not land on top of equipment. A PFD that overlaps is
 *              not a PFD.
 *   OUTPUT     the SVG is well-formed and contains no NaN or undefined, which is
 *              how a broken layout usually escapes into a drawing.
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const diagram = require('../plants/itcStp/diagram');
const { NODES, EDGES, buildFlowsheet, buildNodeParams } = require('../plants/itcStp/flowsheet');
const { runSteadyState } = require('../simulation/solver');

const solved = runSteadyState(buildFlowsheet(), { nodeParams: buildNodeParams() });
const model = diagram.buildDiagram({ results: solved });
const full = diagram.buildDiagram({ detail: 'full' });

const nodeIds = new Set(NODES.map((n) => n.id));

// ── Fidelity ─────────────────────────────────────────────────────────────────

describe('The diagram is generated from the flow, and only from the flow', () => {
  it('draws only blocks that exist as nodes on the flowsheet', () => {
    const invented = model.blocks.map((b) => b.id).filter((id) => !nodeIds.has(id));
    expect(invented).toEqual([]);
  });

  it('drops exactly the valve and instrument nodes, and nothing else', () => {
    const drawn = new Set(model.blocks.map((b) => b.id));
    const dropped = NODES.filter((n) => !drawn.has(n.id));
    const unexpected = dropped.filter((n) => !diagram.PFD_HIDDEN.has(n.data.opType));
    expect(unexpected.map((n) => n.id)).toEqual([]);
    expect(dropped.length).toBeGreaterThan(0);
  });

  it('keeps every node at full detail', () => {
    expect(full.blocks).toHaveLength(NODES.length);
  });

  it('routes every stream between two blocks that are on the sheet', () => {
    const drawn = new Set(model.blocks.map((b) => b.id));
    for (const s of model.streams) {
      expect(drawn.has(s.from)).toBe(true);
      expect(drawn.has(s.to)).toBe(true);
    }
  });

  it('loses no flowsheet edge: every water edge reaches the sheet somewhere', () => {
    // A valve or instrument in the middle of a line is contracted away, so its
    // two edges become one stream. What must never happen is a line vanishing:
    // every edge whose SOURCE is drawn must appear as a stream from that source.
    const drawn = new Set(model.blocks.map((b) => b.id));
    const streamKeys = new Set(model.streams.map((s) => s.id));
    const missing = EDGES
      .filter((e) => drawn.has(e.source))
      .filter((e) => !streamKeys.has(e.id))
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it('numbers streams contiguously from 1', () => {
    expect(model.streams.map((s) => s.no)).toEqual(model.streams.map((_, i) => i + 1));
  });

  it('gives the stream table one row per stream on the sheet', () => {
    expect(diagram.streamTable(model)).toHaveLength(model.streams.length);
  });
});

// ── Honesty ──────────────────────────────────────────────────────────────────

describe('The diagram prints nothing it cannot attribute', () => {
  it('prints a size on an influent only where the schematic states one', () => {
    // The kitchen and laundry lines have no stated size and no area to borrow
    // one from, so they print nothing. The sewage line is drawn as 150 mm UPVC
    // on the schematic, so it prints that — stated is always printable.
    const byFrom = (id) => model.streams.find((s) => s.from === id);
    expect(byFrom('in_kitchen').size).toBeNull();
    expect(byFrom('in_laundry').size).toBeNull();
    expect(byFrom('in_sewage').size).toBe('150 mm');
  });

  it('gives every block on the sheet a tag, and never the same tag twice', () => {
    // Two blocks sharing a tag is worse than none: an engineer reading "CT" has
    // no way to tell the collection tank from the cooling tower.
    const tags = model.blocks.map((b) => b.tag);
    expect(tags.filter((t) => !t)).toEqual([]);
    const dupes = tags.filter((t, i) => tags.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  it("takes a pump's suction size from the pump's area, not the tank's", () => {
    // EQT sits in the ELP area (50 mm) but EQT -> RFP is the reactor feed pump's
    // 100 mm suction. Attributing it to the source would print 50 mm.
    const suction = model.streams.find((s) => s.from === 'eqt' && s.to === 'rfp_p');
    expect(suction).toBeDefined();
    expect(suction.size).toBe('100 mm');
  });

  it('prefers a size the schematic states over the area default', () => {
    const lift = model.streams.find((s) => s.from === 'elp_p' && s.to === 'eqt');
    expect(lift.size).toBe('65 mm');
  });

  it('marks every block whose parameters are an assumption', () => {
    const assumedNodes = NODES.filter((n) => n.data.assumption && !diagram.PFD_HIDDEN.has(n.data.opType));
    expect(model.assumptions).toHaveLength(assumedNodes.length);
    expect(model.assumptions.length).toBeGreaterThan(10);
    for (const a of model.assumptions) expect(a.text.length).toBeGreaterThan(20);
  });

  it('declares the air header as derived, because it is not a flowsheet stream', () => {
    const air = model.streams.filter((s) => s.service === 'air');
    expect(air).toHaveLength(2);           // three blowers, two reactors
    for (const s of air) {
      expect(s.derived).toMatch(/carries air/);
      expect(s.Q_m3_d).toBeNull();         // the solver computes no air flow
      expect(s.from).toBe('blowers');
    }
    expect(air.map((s) => s.to).sort()).toEqual(['r1', 'r2']);
  });

  it('carries the folded valves and instruments on the line they sit on', () => {
    const feed = model.streams.find((s) => s.from === 'rfp_p' && s.to === 'r1');
    expect(feed.inlineEquipment.join(' ')).toMatch(/outlet valves/i);
    expect(feed.inlineEquipment.join(' ')).toMatch(/flow/i);
  });

  it('carries the solved flow on every water stream when balanced', () => {
    const water = model.streams.filter((s) => s.service !== 'air');
    expect(model.balanced).toBe(true);
    for (const s of water) expect(typeof s.Q_m3_d).toBe('number');
  });

  it('carries no flow at all when not balanced', () => {
    const dry = diagram.buildDiagram({});
    expect(dry.balanced).toBe(false);
    for (const s of dry.streams) expect(s.Q_m3_d).toBeNull();
  });

  it('classifies the plant boundaries by what actually leaves there', () => {
    const byTo = (id) => model.streams.find((s) => s.to === id);
    expect(byTo('cooling_tower').service).toBe('product');
    expect(byTo('irrigation').service).toBe('product');
    expect(byTo('flush_out').service).toBe('product');
    expect(byTo('solids_out').service).toBe('sludge');
    expect(byTo('reject_out').service).toBe('reject');
  });

  it('draws every recycle as a return, and they all land on EQT', () => {
    const returns = model.streams.filter((s) => s.recycle);
    expect(returns.length).toBeGreaterThanOrEqual(4);
    for (const s of returns) {
      expect(s.to).toBe('eqt');
      expect(s.service).toBe('return');
    }
  });
});

// ── Geometry ─────────────────────────────────────────────────────────────────

describe('The sheet is legible', () => {
  it('never overlaps two blocks', () => {
    const overlaps = [];
    const b = model.blocks;
    for (let i = 0; i < b.length; i += 1) {
      for (let j = i + 1; j < b.length; j += 1) {
        const a = b[i]; const c = b[j];
        if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) {
          overlaps.push(`${a.id}/${c.id}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('runs every forward stream left to right', () => {
    const rank = new Map(model.blocks.map((b) => [b.id, b.rank]));
    const backwards = model.streams
      .filter((s) => !s.recycle)
      .filter((s) => rank.get(s.to) <= rank.get(s.from))
      .map((s) => `${s.no}:${s.fromLabel}->${s.toLabel}`);
    expect(backwards).toEqual([]);
  });

  it('never puts a stream-number bubble on top of a block', () => {
    const by = new Map(model.blocks.map((b) => [b.id, b]));
    const collisions = [];
    for (const s of model.streams) {
      if (s.recycle) continue;
      const a = by.get(s.from); const b = by.get(s.to);
      const bx = a.x + a.w + (b.x - (a.x + a.w)) / 2;
      const byy = a.y + a.h / 2;
      for (const blk of model.blocks) {
        if (bx > blk.x - 10 && bx < blk.x + blk.w + 10 && byy > blk.y - 10 && byy < blk.y + blk.h + 10) {
          collisions.push(`${s.no} over ${blk.id}`);
          break;
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('fits every block name inside its block', () => {
    // ~5.6 px per character against the width the label is given.
    const maxChars = Math.floor((model.geometry.blockW - 26) / 5.6);
    const clipped = model.blocks.filter((b) => b.name.length > maxChars).map((b) => b.name);
    expect(clipped).toEqual([]);
  });

  it('reports a sheet large enough to hold what it drew', () => {
    const right = Math.max(...model.blocks.map((b) => b.x + b.w));
    const bottom = Math.max(...model.blocks.map((b) => b.y + b.h));
    expect(model.geometry.width).toBeGreaterThanOrEqual(right);
    expect(model.geometry.height).toBeGreaterThan(bottom);
  });
});

// ── Output ───────────────────────────────────────────────────────────────────

describe('SVG output', () => {
  const svg = diagram.toSvg(model);

  it('is a single standalone sheet with no external references', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // The SVG namespace is the one http:// the sheet may contain — it is a
    // namespace identifier, never fetched. Everything else must be inline.
    const withoutNs = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    expect(withoutNs).not.toMatch(/<image|xlink:href|<script|https?:\/\//);
  });

  it('contains no NaN or undefined — the usual sign of a broken layout', () => {
    expect(svg).not.toMatch(/NaN|undefined|null"/);
  });

  it('balances its tags', () => {
    const open = (svg.match(/<(svg|g|defs|marker|text)\b/g) || []).length;
    const close = (svg.match(/<\/(svg|g|defs|marker|text)>/g) || []).length;
    expect(open).toBe(close);
  });

  it('escapes the text it draws', () => {
    // The title line carries a literal ampersand ("P&ID"); it must arrive escaped.
    expect(svg).toMatch(/P&amp;ID/);
    expect(svg).not.toMatch(/[^&]&(?!amp;|lt;|gt;|quot;|#)/);
  });

  it('draws one arrowhead marker per service class', () => {
    for (const key of Object.keys(diagram.SERVICES)) {
      expect(svg).toContain(`id="ah-${key}"`);
    }
  });

  it('prints every stream number on the sheet', () => {
    for (const s of model.streams) {
      expect(svg).toMatch(new RegExp(`>${s.no}(</text>| ·)`));
    }
  });
});

describe('Mermaid output', () => {
  const mmd = diagram.toMermaid(model);

  it('opens a left-to-right flowchart', () => {
    expect(mmd.split('\n')[0]).toBe('flowchart LR');
  });

  it('groups blocks into the proposal’s own process areas', () => {
    const subgraphs = (mmd.match(/^\s+subgraph /gm) || []).length;
    expect(subgraphs).toBe(model.lanes.length);
    expect(subgraphs).toBe(11);
  });

  it('emits one link per stream and closes every subgraph', () => {
    const links = (mmd.match(/-\.?-+>\|/g) || []).length;
    expect(links).toBe(model.streams.length);
    expect((mmd.match(/^\s+end$/gm) || []).length).toBe(model.lanes.length);
  });

  it('dashes the recycles so they read as returns', () => {
    const dashed = (mmd.match(/-\.->\|/g) || []).length;
    expect(dashed).toBe(model.streams.filter((s) => s.recycle).length);
  });

  it('uses node identifiers mermaid can parse', () => {
    // Only the IDENTIFIERS are constrained. Label text lives inside quotes and
    // may carry anything the plant is actually called — ×, ³, — all appear. An
    // id with a hyphen or a space is what breaks mermaid, so that is what is
    // asserted, on every block, rather than a blanket rule over whole lines.
    // Three block kinds mean three shape delimiters: ([…]) for a boundary,
    // [[…]] for a machine, {{…}} for a dosing skid, […] for a vessel.
    for (const b of model.blocks) {
      const mermaidised = b.id.replace(/[^A-Za-z0-9_]/g, '_');
      expect(mermaidised).toMatch(/^[A-Za-z0-9_]+$/);
      expect(mmd).toMatch(new RegExp(`\\b${mermaidised}(\\(\\[|\\[\\[|\\{\\{|\\[)"`));
    }
  });
});
