/**
 * SafeKrit — ITC STP canvas layout tests  (Session 18)
 *
 * The flowsheet's node positions are authored by hand, and the canvas draws
 * every node as a FIXED 168 × 116 card — `UnitOpNode` says so at the top of the
 * file and calls the geometry load-bearing. Positions written against a smaller
 * mental picture overlap, and an overlap on a 55-node sheet is not something you
 * notice by scrolling past it: one card simply sits under another.
 *
 * These tests hold the layout to the real card size. They caught `reject_out`
 * sitting 60 px above `ft_irr` — half a card's height — which read fine in the
 * source and rendered as one card on top of another.
 *
 * Pure geometry — no DB, no rendering.
 */

'use strict';

const { NODES, EDGES, buildFlowsheet } = require('../plants/itcStp/flowsheet');

/** The canvas card, from UnitOpNode: 6 + 22 + 60 + 22 + 6 = 116 tall, 168 wide. */
const CARD = { w: 168, h: 116 };
/** The gap below which two cards read as touching rather than as neighbours. */
const READABLE_GAP = 16;

const overlapping = (a, b, pad = 0) =>
  a.x < b.x + CARD.w + pad && b.x < a.x + CARD.w + pad
  && a.y < b.y + CARD.h + pad && b.y < a.y + CARD.h + pad;

describe('ITC flowsheet canvas layout', () => {
  it('never overlaps two node cards at the real 168 × 116 size', () => {
    const clashes = [];
    for (let i = 0; i < NODES.length; i += 1) {
      for (let j = i + 1; j < NODES.length; j += 1) {
        if (overlapping(NODES[i].position, NODES[j].position)) {
          clashes.push(`${NODES[i].id} / ${NODES[j].id}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('leaves a readable gap between every pair of cards', () => {
    const tight = [];
    for (let i = 0; i < NODES.length; i += 1) {
      for (let j = i + 1; j < NODES.length; j += 1) {
        if (overlapping(NODES[i].position, NODES[j].position, READABLE_GAP)) {
          const a = NODES[i].position; const b = NODES[j].position;
          tight.push(`${NODES[i].id} / ${NODES[j].id} (dx=${Math.abs(a.x - b.x)}, dy=${Math.abs(a.y - b.y)})`);
        }
      }
    }
    expect(tight).toEqual([]);
  });

  it('gives every node an integer position the canvas can persist cleanly', () => {
    for (const n of NODES) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
      expect(Number.isInteger(n.position.x)).toBe(true);
      expect(Number.isInteger(n.position.y)).toBe(true);
    }
  });

  it('uses a unique id for every node and every edge', () => {
    const nodeIds = NODES.map((n) => n.id);
    const edgeIds = EDGES.map((e) => e.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  it('ships a well-formed viewport', () => {
    // ReactFlow is mounted with `fitView`, so it frames the sheet itself on load
    // and this stored viewport is only the fallback. It still has to be valid:
    // a zero or negative zoom renders nothing at all.
    const { viewport } = buildFlowsheet();
    expect(viewport.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(viewport.x)).toBe(true);
    expect(Number.isFinite(viewport.y)).toBe(true);
  });

  it('returns a fresh, mutable copy each time, so the canvas cannot mutate the source', () => {
    const a = buildFlowsheet();
    const b = buildFlowsheet();
    expect(a.nodes[0]).not.toBe(b.nodes[0]);
    a.nodes[0].position.x = -99999;
    a.nodes[0].data.label = 'mutated';
    const c = buildFlowsheet();
    expect(c.nodes[0].data.label).not.toBe('mutated');
  });

  it('gives every node the shape the canvas and the solver both expect', () => {
    for (const n of buildFlowsheet().nodes) {
      expect(n.type).toBe('unitOp');
      expect(typeof n.id).toBe('string');
      expect(typeof n.data.opType).toBe('string');
      expect(typeof n.data.label).toBe('string');
      expect(n.data.params).toBeDefined();
    }
  });

  it('gives every edge the stream shape the canvas edge renderer expects', () => {
    for (const e of buildFlowsheet().edges) {
      expect(e.type).toBe('stream');
      expect(typeof e.source).toBe('string');
      expect(typeof e.target).toBe('string');
      expect(e.data.streamType).toBeTruthy();
    }
  });
});
