/**
 * Acceptance checks §9 #1–#4, #8, #12 — the ones that prove the animation is
 * driven by the simulation and not by decoration.
 *
 * The product requirement is literally "all the animations should [be]
 * controlled by the values". These tests assert that at the DOM level: they
 * push real solver-shaped results through the live store, render the node,
 * and check that the CSS custom properties the stylesheet retimes actually
 * move in the right direction — and, just as importantly, that they do NOT
 * move for metrics that are only the user's own setpoint echoed back.
 *
 * Everything here is a permanent regression net. A future change that wires a
 * loop to an echo metric would ship an animation frozen forever, and no
 * existing test would notice.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import UnitOpNode from '../components/canvas/UnitOpNode';
import { setFrame, resetLiveStore } from '../components/canvas/liveStore';

// ── helpers ─────────────────────────────────────────────────────────────────

const NODE_ID = 'n1';

/** Push one solver frame, live, and render the node under test. */
function renderNode({ opType, label = 'Unit', metrics = {}, biogas, params = {},
  outputs = {}, streamResults = {}, extraUnits = {}, live = true, nodes, edges }) {
  const unitResults = {
    [NODE_ID]: { type: opType, paletteType: opType, metrics, outputs, ...(biogas ? { biogas } : {}) },
    ...extraUnits,
  };
  setFrame({
    live,
    unitResults,
    streamResults,
    nodes: nodes || [{ id: NODE_ID, data: { opType } }],
    edges: edges || [],
  });
  const utils = render(
    <ReactFlowProvider>
      <UnitOpNode
        id={NODE_ID}
        data={{ opType, label, params }}
        selected={false}
        xPos={0}
        yPos={0}
      />
    </ReactFlowProvider>,
  );
  return utils.container;
}

/** Read a CSS custom property off whichever element carries it. */
function readVar(container, name) {
  const el = container.querySelector(`[style*="${name}"]`);
  if (!el) return null;
  const raw = el.getAttribute('style') || '';
  const m = raw.match(new RegExp(`${name}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/** Parse a "0.72s" duration into a number of seconds. */
function seconds(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(m?s)/);
  if (!m) return null;
  return m[2] === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
}

/** Elements that are actually animating carry BOTH ws-anim and a loop class. */
const animatedCount = (container) => container.querySelectorAll('.ws-anim').length;

beforeEach(() => resetLiveStore());
afterEach(() => { cleanup(); resetLiveStore(); });

// ── §9 #1 — pump speed drives the impeller ──────────────────────────────────

describe('§9 #1 — pump impeller rate follows speed_pct', () => {
  const pumpMetrics = (speed) => ({
    status: 'ON', speed_pct: speed, Q_delivered_m3_d: 5000 * (speed / 100),
    blocked_Q_m3_d: 0, power_kW: 7.3, Q_in_m3_d: 5000,
  });

  test('dropping speed 100 → 30 makes the rotation markedly slower', () => {
    const fast = renderNode({ opType: 'pump', metrics: pumpMetrics(100) });
    const fastSpin = seconds(readVar(fast, '--ws-spin'));
    cleanup(); resetLiveStore();

    const slow = renderNode({ opType: 'pump', metrics: pumpMetrics(30) });
    const slowSpin = seconds(readVar(slow, '--ws-spin'));

    expect(fastSpin).toBeGreaterThan(0);
    expect(slowSpin).toBeGreaterThan(0);
    // A longer period is a slower impeller. The catalogue maps 100% to the
    // 0.28s floor and 30% to roughly 1.1-1.2s — several times slower.
    expect(slowSpin).toBeGreaterThan(fastSpin * 2.5);
  });

  test('an OFF pump has no rotation at all and is not merely paused', () => {
    const off = renderNode({
      opType: 'pump',
      // params must agree with metrics: the solver derives status FROM running,
      // so an OFF status only ever occurs alongside running = 0.
      params: { running: 0 },
      metrics: { status: 'OFF', speed_pct: 100, Q_delivered_m3_d: 0, blocked_Q_m3_d: 5000, power_kW: 0 },
    });
    expect(readVar(off, '--ws-spin')).toBeNull();
    expect(off.querySelector('.ws-anim.ws-rotor')).toBeNull();
  });

  test('a blocked discharge throbs, an unblocked one does not', () => {
    const blocked = renderNode({
      opType: 'pump',
      metrics: { ...pumpMetrics(100), blocked_Q_m3_d: 1200 },
    });
    expect(readVar(blocked, '--ws-throb')).not.toBeNull();
    cleanup(); resetLiveStore();

    const clear = renderNode({ opType: 'pump', metrics: pumpMetrics(100) });
    expect(readVar(clear, '--ws-throb')).toBeNull();
  });
});

// ── §9 #2 — aeration responds to the PLANT, not to its own setpoint ─────────

describe('§9 #2 — aeration bubbles follow computed oxygen demand', () => {
  const basin = (o2) => ({
    O2_demand_kg_d: o2, volume_m3: 4000, MLSS_mg_L: 3000,
    SRT_d: 10, HRT_h: 19, nitrification: true,
  });

  test('more oxygen demand gives more columns AND a faster rise', () => {
    const low = renderNode({ opType: 'activated_sludge', metrics: basin(400) });
    const lowBubbles = low.querySelectorAll('.ws-bubble').length;
    const lowDur = seconds(readVar(low, '--ws-bubble-dur'));
    cleanup(); resetLiveStore();

    const high = renderNode({ opType: 'activated_sludge', metrics: basin(6000) });
    const highBubbles = high.querySelectorAll('.ws-bubble').length;
    const highDur = seconds(readVar(high, '--ws-bubble-dur'));

    expect(highBubbles).toBeGreaterThan(lowBubbles);
    expect(highDur).toBeLessThan(lowDur);           // shorter period = faster rise
  });

  test('no oxygen demand mounts no bubbles at all', () => {
    const idle = renderNode({
      opType: 'activated_sludge',
      metrics: { O2_demand_kg_d: 0, volume_m3: 4000, MLSS_mg_L: 3000 },
    });
    expect(idle.querySelectorAll('.ws-bubble').length).toBe(0);
  });

  test('MLSS is a setpoint: changing it must NOT retime the bubbles', () => {
    const a = renderNode({ opType: 'activated_sludge', metrics: { ...basin(3000), MLSS_mg_L: 2000 } });
    const durA = readVar(a, '--ws-bubble-dur');
    cleanup(); resetLiveStore();

    const b = renderNode({ opType: 'activated_sludge', metrics: { ...basin(3000), MLSS_mg_L: 5000 } });
    const durB = readVar(b, '--ws-bubble-dur');

    expect(durA).toBe(durB);   // density may change; the RATE may not
  });
});

// ── §9 #12 — the echo traps, pinned at the node level ───────────────────────

describe('§9 #12 — setpoint echoes never drive a rate', () => {
  const clarifier = (over) => ({
    RAS_Q_m3_d: 2000, SLR_kg_m2_d: 48, RAS_TSS_mg_L: 8000,
    area_m2: 320, SOR_m3_m2_d: 16, eff_TSS_mg_L: 12, ...over,
  });

  test('surface overflow rate does not change the rake speed', () => {
    const outputs = { effluent: { Q: 5000 }, RAS: { Q: 2000 } };
    const a = renderNode({ opType: 'secondary_clarifier', outputs, metrics: clarifier({ SOR_m3_m2_d: 16 }) });
    const rakeA = readVar(a, '--ws-rake-dur');
    cleanup(); resetLiveStore();

    const b = renderNode({ opType: 'secondary_clarifier', outputs, metrics: clarifier({ SOR_m3_m2_d: 40 }) });
    const rakeB = readVar(b, '--ws-rake-dur');

    expect(rakeA).not.toBeNull();   // the rake IS turning — otherwise this proves nothing
    expect(rakeA).toBe(rakeB);
  });

  test('computed RAS flow DOES change the rake speed', () => {
    // The rake only turns when water is actually passing through, so the unit
    // needs real output streams — and sludgeRef ratchets across the sheet, so
    // a second clarifier sets a common reference for both renders.
    const flows = (ras) => ({ effluent: { Q: 5000 }, RAS: { Q: ras } });
    const reference = {
      other: {
        type: 'secondary_clarifier', paletteType: 'secondary_clarifier',
        metrics: { RAS_Q_m3_d: 10000 }, outputs: { effluent: { Q: 5000 }, RAS: { Q: 10000 } },
      },
    };

    const busy = renderNode({
      opType: 'secondary_clarifier',
      metrics: clarifier({ RAS_Q_m3_d: 9000 }),
      outputs: flows(9000),
      extraUnits: reference,
    });
    const busyRake = readVar(busy, '--ws-rake-dur');
    cleanup(); resetLiveStore();

    const quiet = renderNode({
      opType: 'secondary_clarifier',
      metrics: clarifier({ RAS_Q_m3_d: 500 }),
      outputs: flows(500),
      extraUnits: reference,
    });
    const quietRake = readVar(quiet, '--ws-rake-dur');

    expect(busyRake).not.toBeNull();
    expect(quietRake).not.toBeNull();
    expect(busyRake).not.toBe(quietRake);
    expect(seconds(busyRake)).toBeLessThan(seconds(quietRake));  // busier = faster
  });

  test('a non-empty warnings array does not make the clarifier look alarmed', () => {
    // The model's own SLR test is a units bug and fires on essentially every
    // sheet; wiring the ring to it would paint every plant permanently amber.
    const c = renderNode({
      opType: 'secondary_clarifier',
      metrics: clarifier({ warnings: ['High solids loading rate (48.0 kg/m²/d)'] }),
    });
    expect(c.querySelector('.ws-alarm')).toBeNull();
    expect(c.innerHTML).not.toMatch(/ws-node__ring[^"]*alarm/);
  });

  test('screenings drive the screen rake; headloss does not', () => {
    const base = { screenings_kg_d: 200, headloss_m: 0.15, TSS_removal_pct: '15.0', screenType: 'fine' };
    const a = renderNode({ opType: 'screening', metrics: { ...base, headloss_m: 0.15 } });
    const durA = readVar(a, '--ws-rake-dur');
    cleanup(); resetLiveStore();

    const b = renderNode({ opType: 'screening', metrics: { ...base, headloss_m: 0.42 } });
    const durB = readVar(b, '--ws-rake-dur');
    expect(durA).toBe(durB);           // headloss is an echo — rate must not move
  });
});

// ── §9 #4 — a stopped pump reads as stopped, statically ─────────────────────

describe('§9 #4 — the dead-line cascade survives a screenshot', () => {
  test('an OFF pump still reads OFF with every animation removed', () => {
    const off = renderNode({
      opType: 'pump',
      label: 'Feed Pump',
      params: { running: 0 },
      metrics: { status: 'OFF', speed_pct: 100, Q_delivered_m3_d: 0, blocked_Q_m3_d: 5000, power_kW: 0 },
      live: false,                                  // as in a printed sheet
    });
    expect(animatedCount(off)).toBe(0);
    expect(off.textContent).toContain('OFF');       // state is text, not motion
  });
});

// ── §9 #8 — values without motion ───────────────────────────────────────────
//
// Two cooperating gates, and they behave differently on purpose:
//   (a) play-state — loops KEEP their classes and are paused by CSS, so
//       re-entering live resumes in phase instead of jumping. jsdom applies no
//       stylesheet, so the class staying put is the observable proof.
//   (b) existence — elements that are meaningless without values (bubbles,
//       droplets, edge pulses) are not mounted at all when not live.

describe('§9 #8 — leaving live view stops motion but keeps every value', () => {
  const metrics = { status: 'ON', speed_pct: 80, Q_delivered_m3_d: 4000, blocked_Q_m3_d: 0, power_kW: 6 };

  test('a loop keeps its class when not live, so CSS can pause rather than restart it', () => {
    const liveEl = renderNode({ opType: 'pump', metrics, live: true });
    const liveSpin = readVar(liveEl, '--ws-spin');
    expect(animatedCount(liveEl)).toBeGreaterThan(0);
    cleanup(); resetLiveStore();

    const still = renderNode({ opType: 'pump', metrics, live: false });
    // Same element, same duration — only the ancestor .ws-live class differs,
    // which is what preserves phase across the toggle.
    expect(readVar(still, '--ws-spin')).toBe(liveSpin);
  });

  test('value-meaningless elements ARE unmounted when not live', () => {
    const basin = { O2_demand_kg_d: 4000, volume_m3: 4000, MLSS_mg_L: 3000, nitrification: true };
    const liveEl = renderNode({ opType: 'activated_sludge', metrics: basin, live: true });
    expect(liveEl.querySelectorAll('.ws-bubble').length).toBeGreaterThan(0);
    cleanup(); resetLiveStore();

    const still = renderNode({ opType: 'activated_sludge', metrics: basin, live: false });
    expect(still.querySelectorAll('.ws-bubble').length).toBe(0);
  });

  test('the readout and status survive with motion off', () => {
    const still = renderNode({ opType: 'pump', label: 'Feed Pump', metrics, live: false });
    expect(still.textContent).toContain('ON');
    expect(still.textContent).toContain('Feed Pump');
  });
});

// ── §9 #9/#11 — the refusals, at the rendered-node level ────────────────────

describe('§9 #9/#11 — refusals hold once assembled into a node', () => {
  test('a tank shows no level and no animation at any input', () => {
    for (const params of [{}, { volume_m3: 500 }]) {
      const t = renderNode({ opType: 'tank', label: 'Balance Tank', metrics: {}, params, live: true });
      expect(animatedCount(t)).toBe(0);
      expect(readVar(t, '--ws-level')).toBeNull();
      cleanup(); resetLiveStore();
    }
  });

  test('a digester bubbles and mixes, but its cover carries no animation', () => {
    const d = renderNode({
      opType: 'anaerobic_digester',
      metrics: { volume_m3: 3000, HRT_d: 20, stable: true, pH_out: 7.1, CH4_pct: 63 },
      biogas: { volume_m3_d: 1800, energy_kWh_d: 4200 },
    });
    expect(animatedCount(d)).toBeGreaterThan(0);          // it IS alive
    const cover = d.querySelector('[data-part="cover"], .ws-cover');
    if (cover) {
      expect(cover.className.baseVal || cover.getAttribute('class') || '').not.toContain('ws-anim');
    }
  });

  test('a blower with no aeration basin connected does not spin', () => {
    const lonely = renderNode({ opType: 'blower', metrics: {} });
    expect(readVar(lonely, '--ws-spin')).toBeNull();
    expect(lonely.querySelector('.ws-anim.ws-rotor')).toBeNull();
  });

  test('the same blower spins once it serves a basin', () => {
    const served = renderNode({
      opType: 'blower',
      metrics: {},
      nodes: [{ id: NODE_ID, data: { opType: 'blower' } }, { id: 'b1', data: { opType: 'activated_sludge' } }],
      edges: [{ id: 'e1', source: NODE_ID, target: 'b1' }],
      extraUnits: {
        b1: { type: 'activated_sludge', paletteType: 'activated_sludge',
          metrics: { O2_demand_kg_d: 2000, volume_m3: 4000 }, outputs: {} },
      },
    });
    expect(readVar(served, '--ws-spin')).not.toBeNull();
  });
});
