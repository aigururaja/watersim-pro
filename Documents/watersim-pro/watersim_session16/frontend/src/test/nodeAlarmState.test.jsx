/**
 * Configured alarms in the card state machine (§2.4 precedence, extended).
 *
 * The state machine already knew about INTRINSIC alarms — conditions the solver
 * discovered, like a permit violation or a soured digester. Configured rules are
 * a second, independent source, and merging them wrongly is the easy mistake:
 *
 *     error > off > (critical rule OR intrinsic alarm) > warning rule/watch
 *           > nomodel > rest
 *
 * Three of these are worth stating out loud, and all three are pinned below:
 *   · an OFF pump reads OFF even with a critical rule breaching on it
 *   · a `warning` rule never demotes an intrinsic alarm to amber
 *   · `countAlarms` sees exactly what the cards see — including the configured
 *     ones — or the toolbar chip and the flood guard would lie
 *
 * The severity arrives by CONTEXT, never in `node.data`: that object is saved to
 * the database, broadcast to collaborators and hashed by `liveSignature`.
 * `renders identically with no provider` is the regression net for that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import UnitOpNode from '../components/canvas/UnitOpNode';
import {
  deriveNodeState, countAlarms, isAlarmState, NodeAlarmContext,
} from '../components/canvas/nodeReadouts';
import { setFrame, resetLiveStore } from '../components/canvas/liveStore';
import { worstSeverityByNode } from '../components/alarms/alarmState';

const critical = (name = 'TN over permit') => ({ severity: 'critical', ruleName: name });
const warning  = (name = 'SRT drifting')   => ({ severity: 'warning', ruleName: name });

/** An outlet whose permit failed — the canonical INTRINSIC alarm. */
const VIOLATING_OUTLET = {
  compliant: false,
  permit_violations: [{ param: 'TN', value: 52.8, limit: 10, unit: 'mg/L' }],
};

const snap = (metrics = {}) => ({ metrics, derived: {}, outputs: {}, biogas: null });

beforeEach(() => resetLiveStore());
afterEach(() => { cleanup(); resetLiveStore(); });

// ── The precedence table ────────────────────────────────────────────────────

describe('deriveNodeState — configured alarms in the precedence order', () => {
  it('unchanged when no configured alarm is supplied', () => {
    expect(deriveNodeState('activated_sludge', snap(), {})).toEqual({ state: 'rest', chip: null, reason: null });
    expect(deriveNodeState('outlet', snap(VIOLATING_OUTLET), {}))
      .toEqual({ state: 'alarm', chip: '1 VIOLATION', reason: '1 VIOLATION' });
  });

  it('a critical rule puts an otherwise-resting node into ALARM, chipped with the rule name', () => {
    const s = deriveNodeState('activated_sludge', snap(), {}, critical('SRT collapse'));
    expect(s.state).toBe('alarm');
    expect(isAlarmState(s.state)).toBe(true);
    expect(s.chip).toBe('SRT COLLAPSE');
    expect(s.reason).toBe('SRT collapse');
  });

  it('a warning rule puts it on WATCH, not alarm', () => {
    const s = deriveNodeState('activated_sludge', snap(), {}, warning('SRT drifting'));
    expect(s.state).toBe('watch');
    expect(isAlarmState(s.state)).toBe(false);
    expect(s.chip).toBe('SRT DRIFTING');
  });

  it('an INFO rule changes nothing on the canvas', () => {
    // Info is recorded in the history; it is not a thing the sheet shouts about.
    expect(deriveNodeState('activated_sludge', snap(), {}, { severity: 'info', ruleName: 'FYI' }).state)
      .toBe('rest');
  });

  it('a warning rule does NOT outrank an intrinsic alarm', () => {
    const s = deriveNodeState('outlet', snap(VIOLATING_OUTLET), {}, warning());
    expect(s.state).toBe('alarm');
    expect(s.chip).toBe('1 VIOLATION');   // the specific fact wins the label
  });

  it('an intrinsic alarm keeps its own chip even alongside a critical rule', () => {
    const s = deriveNodeState('outlet', snap(VIOLATING_OUTLET), {}, critical());
    expect(s.state).toBe('alarm');
    expect(s.chip).toBe('1 VIOLATION');
  });

  it('a critical rule DOES outrank an intrinsic watch', () => {
    // A screen blinding is a watch; a configured critical is an alarm.
    const watchOnly = deriveNodeState('screening', snap({ headloss_m: 0.5 }), {});
    expect(watchOnly.state).toBe('watch');
    expect(deriveNodeState('screening', snap({ headloss_m: 0.5 }), {}, critical()).state).toBe('alarm');
  });

  it('an intrinsic watch keeps its chip over a warning rule', () => {
    const s = deriveNodeState('screening', snap({ headloss_m: 0.5 }), {}, warning());
    expect(s.state).toBe('watch');
    expect(s.chip).toBe('BLINDING');
  });

  it('an OFF pump still shows OFF, never alarm, however critical the rule', () => {
    // THE precedence test: state of the equipment beats a threshold on it.
    const s = deriveNodeState('pump', snap({ status: 'OFF', Q_delivered_m3_d: 0 }), { running: 0 }, critical());
    expect(s.state).toBe('off');
    expect(s.reason).toBe('OFF');
    expect(isAlarmState(s.state)).toBe(false);

    const closed = deriveNodeState('valve', snap({}), { open: 0 }, critical());
    expect(closed.state).toBe('off');
  });

  it('a model error still beats everything', () => {
    const s = deriveNodeState('activated_sludge', snap({ error: 'solver diverged' }), {}, critical());
    expect(s.state).toBe('error');
    expect(s.chip).toBe('ERR');
  });

  it('a configured alarm outranks nomodel — an unlinked blower with a rule rings', () => {
    expect(deriveNodeState('blower', snap(), {}).state).toBe('nomodel');
    expect(deriveNodeState('blower', snap(), {}, critical()).state).toBe('alarm');
    expect(deriveNodeState('blower', snap(), {}, warning()).state).toBe('watch');
  });

  it('truncates a long rule name to fit the 22px footer, keeping it in `reason`', () => {
    const long = 'Effluent nitrogen over permit';
    const s = deriveNodeState('activated_sludge', snap(), {}, critical(long));
    expect(s.chip).toHaveLength(14);
    expect(s.chip).toMatch(/…$/);
    expect(s.reason).toBe(long);          // the whole name is still reachable
  });

  it('ignores a malformed configured input rather than inventing a state', () => {
    for (const bad of [null, undefined, {}, { severity: 'meltdown' }, 'nonsense']) {
      expect(deriveNodeState('activated_sludge', snap(), {}, bad).state).toBe('rest');
    }
    // A bare severity string is accepted, for a caller that has only that.
    expect(deriveNodeState('activated_sludge', snap(), {}, 'critical').state).toBe('alarm');
  });
});

// ── The rendered card ───────────────────────────────────────────────────────

describe('UnitOpNode — the ring comes from the context, not from node.data', () => {
  const renderCard = (configured, { opType = 'activated_sludge', params = {}, metrics = {}, live = true } = {}) => {
    setFrame({
      live,
      unitResults: { n1: { type: opType, paletteType: opType, metrics, outputs: {} } },
      streamResults: {},
      nodes: [{ id: 'n1', data: { opType } }],
      edges: [],
    });
    const map = configured ? new Map([['n1', configured]]) : new Map();
    const { container } = render(
      <ReactFlowProvider>
        <NodeAlarmContext.Provider value={map}>
          <UnitOpNode id="n1" data={{ label: 'Aeration Basin', opType, params }} selected={false} xPos={0} yPos={0} />
        </NodeAlarmContext.Provider>
      </ReactFlowProvider>
    );
    return container.querySelector('.ws-node');
  };

  it('a node with an ACTIVE CRITICAL configured alarm reaches `alarm` and gets the ring', () => {
    const card = renderCard(critical('TN over permit'));
    expect(card).toHaveAttribute('data-state', 'alarm');
    // The ring is a real element (so only its opacity animates), and it blinks
    // because this frame is live and the sheet is not flooded.
    const ring = card.querySelector('.ws-node__ring');
    expect(ring).not.toBeNull();
    expect(ring.className).toMatch(/ws-alarm/);
    expect(card.textContent).toContain('TN OVER PERMIT');
  });

  it('a warning rule rings amber and never blinks', () => {
    const card = renderCard(warning('SRT drifting'));
    expect(card).toHaveAttribute('data-state', 'watch');
    const ring = card.querySelector('.ws-node__ring');
    expect(ring).not.toBeNull();
    expect(ring.className).not.toMatch(/ws-alarm/);   // watch is static by design
  });

  it('an OFF pump with a critical rule renders OFF, with no alarm chip', () => {
    const card = renderCard(critical('Pump pressure'), {
      opType: 'pump', params: { running: 0 },
      metrics: { status: 'OFF', speed_pct: 100, Q_delivered_m3_d: 0, blocked_Q_m3_d: 5000, power_kW: 0 },
    });
    expect(card).toHaveAttribute('data-state', 'off');
    expect(card.textContent).toContain('OFF');
    expect(card.textContent).not.toContain('PUMP PRESSURE');
  });

  it('renders identically with NO provider — nothing lives in node.data', () => {
    const withEmpty = renderCard(null);
    expect(withEmpty).toHaveAttribute('data-state', 'rest');
    cleanup(); resetLiveStore();

    // The same card outside any provider (a print, an existing test) is `rest`
    // too: the default context value is an empty map, not a lookup into `data`.
    setFrame({
      live: true,
      unitResults: { n1: { type: 'activated_sludge', paletteType: 'activated_sludge', metrics: {}, outputs: {} } },
      streamResults: {}, nodes: [{ id: 'n1', data: { opType: 'activated_sludge' } }], edges: [],
    });
    const { container } = render(
      <ReactFlowProvider>
        <UnitOpNode id="n1" data={{ label: 'Aeration Basin', opType: 'activated_sludge', params: {} }} />
      </ReactFlowProvider>
    );
    expect(container.querySelector('.ws-node')).toHaveAttribute('data-state', 'rest');
  });

  it('only the node the alarm names is affected', () => {
    setFrame({
      live: true,
      unitResults: {
        n1: { type: 'activated_sludge', paletteType: 'activated_sludge', metrics: {}, outputs: {} },
        n2: { type: 'activated_sludge', paletteType: 'activated_sludge', metrics: {}, outputs: {} },
      },
      streamResults: {},
      nodes: [{ id: 'n1', data: { opType: 'activated_sludge' } }, { id: 'n2', data: { opType: 'activated_sludge' } }],
      edges: [],
    });
    const { container } = render(
      <ReactFlowProvider>
        <NodeAlarmContext.Provider value={new Map([['n1', critical()]])}>
          <UnitOpNode id="n1" data={{ label: 'A', opType: 'activated_sludge', params: {} }} />
          <UnitOpNode id="n2" data={{ label: 'B', opType: 'activated_sludge', params: {} }} />
        </NodeAlarmContext.Provider>
      </ReactFlowProvider>
    );
    const [a, b] = container.querySelectorAll('.ws-node');
    expect(a).toHaveAttribute('data-state', 'alarm');
    expect(b).toHaveAttribute('data-state', 'rest');
  });
});

// ── countAlarms must agree with the canvas ──────────────────────────────────

describe('countAlarms — the count matches the ringed cards', () => {
  const nodes = [
    { id: 'n1', data: { opType: 'activated_sludge', params: {} } },
    { id: 'n2', data: { opType: 'outlet', params: {} } },
    { id: 'n3', data: { opType: 'pump', params: { running: 0 } } },
    { id: 'n4', data: { opType: 'screening', params: {} } },
  ];
  const unitResults = {
    n1: { metrics: {} },
    n2: { metrics: VIOLATING_OUTLET },
    n3: { metrics: { status: 'OFF', Q_delivered_m3_d: 0 } },
    n4: { metrics: { headloss_m: 0.5 } },
  };

  /** The count, recomputed the long way from the SAME state machine. */
  const ringedByHand = (cfg) => nodes.filter(n => isAlarmState(
    deriveNodeState(
      n.data.opType,
      { metrics: unitResults[n.id]?.metrics || {}, derived: {}, outputs: {}, biogas: null },
      n.data.params,
      cfg?.get(n.id)
    ).state
  )).length;

  it('counts intrinsic alarms only when no configured map is given', () => {
    expect(countAlarms(nodes, unitResults)).toBe(1);       // just the violating outlet
    expect(countAlarms(nodes, unitResults)).toBe(ringedByHand(null));
  });

  it('counts a configured critical alarm too', () => {
    const cfg = new Map([['n1', critical()]]);
    expect(countAlarms(nodes, unitResults, cfg)).toBe(2);
    expect(countAlarms(nodes, unitResults, cfg)).toBe(ringedByHand(cfg));
  });

  it('does not count a warning rule, and does not count the OFF pump', () => {
    const cfg = new Map([['n1', warning()], ['n3', critical()]]);
    // n1 → watch (not counted); n3 → off (not counted); n2 → intrinsic alarm.
    expect(countAlarms(nodes, unitResults, cfg)).toBe(1);
    expect(countAlarms(nodes, unitResults, cfg)).toBe(ringedByHand(cfg));
  });

  it('counts a node the solver said nothing about but a rule is breaching on', () => {
    // An open alarm event is a fact about the plant; it does not stop being true
    // between simulation runs.
    const cfg = new Map([['n9', critical()]]);
    const withOrphan = [...nodes, { id: 'n9', data: { opType: 'activated_sludge', params: {} } }];
    expect(countAlarms(withOrphan, unitResults, cfg)).toBe(2);
    expect(countAlarms(withOrphan, {}, cfg)).toBe(1);
  });

  it('feeds straight from worstSeverityByNode, the way CanvasPage wires it', () => {
    const events = [
      { id: 'e1', ruleId: 'r1', ruleName: 'TN', state: 'active', severity: 'critical', nodeId: 'n1', triggeredAt: 'T2' },
      { id: 'e2', ruleId: 'r2', ruleName: 'Old', state: 'cleared', severity: 'critical', nodeId: 'n4', triggeredAt: 'T1' },
    ];
    const cfg = worstSeverityByNode(events);
    // n1 rings from the open event; n4 does NOT — its alarm cleared.
    expect(countAlarms(nodes, unitResults, cfg)).toBe(2);
    expect(cfg.has('n4')).toBe(false);
  });

  it('is safe with no nodes and no results', () => {
    expect(countAlarms(null, unitResults)).toBe(0);
    expect(countAlarms(nodes, null)).toBe(0);
    expect(countAlarms([], null, new Map())).toBe(0);
  });
});
