/**
 * UnitOpNode — the equipment card (spec §2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 168 x 116 for EVERY type, and that is load-bearing:
 *
 *     6 padding + 22 header + 60 symbol frame + 22 footer + 6 padding = 116
 *     symbol centre = 6 + 22 + 30 = 58 = 116 / 2
 *
 * Because the header and the footer are both 22px and the padding is symmetric,
 * the symbol's centreline lands exactly on the card's vertical centre — so the
 * Handles stay at ReactFlow's DEFAULT `top: 50%`. No absolute repositioning, no
 * handle `id` props, no change to `edge.sourceHandle`, and therefore no change
 * to `edgeRole()` in the solver or to `liveSignature`. Process lines enter the
 * equipment and no saved flowsheet re-anchors (acceptance check #17).
 *
 * The footer MUST occupy its 22px even when empty, or the geometry breaks.
 *
 * ── WHAT WAS DELETED ─────────────────────────────────────────────────────────
 * `TYPE_COLORS`, and with it every emoji and every per-category background.
 * "Equipment is never coloured by category. Colour encodes service or state
 * only" (§1.1). The 4px band across the top edge is the only service colour on
 * a card, and it is the target of the §5.3 #20 per-tick heartbeat.
 *
 * ── WHAT WAS MOVED, NOT REWRITTEN ────────────────────────────────────────────
 * `ControlRow` and `NodeInfoButton` are byte-for-byte the components that were
 * here before: the same `role="switch"`, `aria-checked`, ``aria-label={`Toggle
 * ${opType}`}``, ``aria-label={`About ${label}`}``, `className="nodrag"`,
 * `stopPropagation`, `data.onControlToggle` / `data.onNodeInfo` escape hatches
 * and context fallbacks. The pill keeps its own element containing EXACTLY
 * `ON` / `OFF` / `OPEN` / `CLOSED` / `70%` as a lone text node — never
 * `ON · 70%`. `src/test/unitOpNode.test.jsx` pins all of it and must pass
 * unmodified.
 *
 * Nothing in the new SVG carries `role="switch"`: the valve disc is decorative
 * and its whole group is `aria-hidden`.
 *
 * ── WHAT NEVER HAPPENS HERE ──────────────────────────────────────────────────
 * Nothing from the live store or the animation layer is ever written into
 * `node.data` or `params`. `node.data` stays plain JSON for `save()` and for
 * the collab `sendEvent` JSON.stringify, and `liveSignature` hashes
 * `data.params` — UI state stashed there would retrigger the simulation on
 * every frame.
 */

import { memo, useContext, useState } from 'react';
import { Handle, Position } from 'reactflow';
import { NodeControlContext, NodeInfoContext, isControlOn, controlPct } from './controlState';
import { useLiveNode } from './liveStore';
import { getSymbol, getTag, resolveSymbolType } from './symbols';
// THE import point for the 26 glyphs. Every symbol module registers itself as a
// side effect of being imported and nothing else imports them, so without this
// line `SYMBOLS` is empty and every node draws the placeholder. See
// symbols/register.js for why it lives here and not in UnitOpPalette.
import './symbols/register';
import {
  CONTROL_DEFS, deriveNodeState, isAlarmState, nodeReadout, nodeSecondary,
  serviceColorOf, useAlarmFlood,
} from './nodeReadouts';

const cxs = (...p) => p.filter(Boolean).join(' ');

// ── Flow-control (pump / valve) state row: pill + toggle switch ──────────────
//
// MOVED VERBATIM from the previous UnitOpNode. Do not rewrite; do not merge the
// pill text. `CONTROL_DEFS` now lives in nodeReadouts.js so the card, the state
// machine and the sheet-wide alarm count all read one definition.

function ControlRow({ nodeId, opType, data }) {
  const def = CONTROL_DEFS[opType];
  const toggleViaContext = useContext(NodeControlContext);

  const on  = isControlOn(data.params?.[def.paramKey]); // undefined → ON
  const pct = controlPct(data.params?.[def.pctKey]);
  const throttled = on && pct < 100;

  const pillText  = !on ? def.offLabel : throttled ? `${Math.round(pct)}%` : def.onLabel;
  const pillColor = !on ? { bg: '#FEE2E2', fg: '#991B1B' }
    : throttled          ? { bg: '#FEF3C7', fg: '#92400E' }
                         : { bg: '#DCFCE7', fg: '#166534' };

  const handleToggle = (e) => {
    // Don't let the click bubble up and open the node's param panel.
    e.stopPropagation();
    const next = on ? 0 : 1; // numeric 1/0 — PLC-compatible
    if (typeof data.onControlToggle === 'function') data.onControlToggle(def.paramKey, next);
    else toggleViaContext?.(nodeId, def.paramKey, next);
  };

  return (
    <div style={styles.controlRow}>
      <span style={{
        ...styles.pill,
        background: pillColor.bg,
        color: pillColor.fg,
      }}>{pillText}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Toggle ${opType}`}
        onClick={handleToggle}
        className="nodrag"
        style={{
          ...styles.switchTrack,
          background: on ? '#16A34A' : '#9CA3AF',
        }}
      >
        <span style={{
          ...styles.switchKnob,
          transform: on ? 'translateX(14px)' : 'translateX(0)',
        }} />
      </button>
    </div>
  );
}

// ── In-node ⓘ: opens the node info modal (what / how / watch-for + params) ────
//
// MOVED VERBATIM. Same in-node control contract as the pump/valve switch above:
// `nodrag` so the node is not dragged, and stopPropagation so the click never
// selects the node or opens the params panel.

function NodeInfoButton({ opType, label, data }) {
  const openInfoViaContext = useContext(NodeInfoContext);
  const [hover, setHover] = useState(false);

  const handleInfo = (e) => {
    e.stopPropagation();
    if (typeof data?.onNodeInfo === 'function') data.onNodeInfo(opType, label);
    else openInfoViaContext?.(opType, label);
  };

  return (
    <button
      type="button"
      className="nodrag"
      aria-label={`About ${label}`}
      title={`About ${label}`}
      onClick={handleInfo}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        ...styles.infoBtn,
        opacity: hover ? 1 : 0.35,
        color: hover ? '#1F4E79' : '#6B7280',
      }}
    >
      ⓘ
    </button>
  );
}

// ── Footer readout (spec §1.2, §2.1) ─────────────────────────────────────────
//
// Mono, tabular figures, magnitude dominant with the unit demoted to 0.85em.
// `key={value}` remounts the span so the §5.3 #21 one-shot replays on a CHANGE
// only — a converged plant goes completely still, which is itself information.
// The class is applied only in live view, so a still frame and a print show the
// number with no animation at all.

function Readouts({ opType, snap, params }) {
  const r = nodeReadout(opType, snap, params);
  const second = nodeSecondary(opType, snap);
  const motion = !!snap?.live;

  if (!r) {
    return <span style={styles.readoutMuted}>{snap?.hasResults ? '—' : ''}</span>;
  }
  return (
    <div style={styles.readoutRow} title={r.title}>
      <span
        key={r.value}
        className={motion ? 'ws-stamp' : undefined}
        style={motion ? { ...styles.readout, '--ws-dur-stamp': '260ms' } : styles.readout}
      >
        {r.value}
        <span style={styles.unit}>{` ${r.unit}`}</span>
      </span>
      {second && <span style={styles.readoutSecond}>{second}</span>}
    </div>
  );
}

// ── Selection: four 8px crop-mark brackets, no glow, no blur (spec §1.3) ─────

const BRACKETS = [
  { top: -3, left: -3, borderTop: true, borderLeft: true },
  { top: -3, right: -3, borderTop: true, borderRight: true },
  { bottom: -3, left: -3, borderBottom: true, borderLeft: true },
  { bottom: -3, right: -3, borderBottom: true, borderRight: true },
];

function CropMarks() {
  return (
    <>
      {BRACKETS.map((b, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 8, height: 8, pointerEvents: 'none',
            top: b.top, bottom: b.bottom, left: b.left, right: b.right,
            borderTop: b.borderTop ? '1.5px solid var(--ws-brand-900, #1F4E79)' : undefined,
            borderBottom: b.borderBottom ? '1.5px solid var(--ws-brand-900, #1F4E79)' : undefined,
            borderLeft: b.borderLeft ? '1.5px solid var(--ws-brand-900, #1F4E79)' : undefined,
            borderRight: b.borderRight ? '1.5px solid var(--ws-brand-900, #1F4E79)' : undefined,
          }}
        />
      ))}
    </>
  );
}

// ── The card ─────────────────────────────────────────────────────────────────

const BORDER_BY_STATE = {
  off:     'var(--ws-alarm, #DC2626)',
  error:   'var(--ws-alarm, #DC2626)',
  alarm:   'var(--ws-alarm, #DC2626)',
  watch:   'var(--ws-watch, #D97706)',
  nomodel: 'var(--ws-nomodel, #64748B)',
};

const CHIP_TONE = {
  alarm:   { bg: '#FEE2E2', fg: 'var(--ws-alarm, #DC2626)' },
  error:   { bg: '#FEE2E2', fg: 'var(--ws-alarm, #DC2626)' },
  watch:   { bg: '#FEF3C7', fg: 'var(--ws-watch, #D97706)' },
  nomodel: { bg: '#F1F5F9', fg: 'var(--ws-nomodel, #64748B)' },
};

const UnitOpNode = memo(({ id, data, selected, xPos, yPos }) => {
  // Per-node subscription: this node re-renders only when ITS data identity
  // changed, or when the live gate flipped. Typically 3-8 of 30 per tick, and
  // 0 once the solver converges to the same numbers.
  const snap = useLiveNode(id);
  const alarmFlood = useAlarmFlood();
  const [hover, setHover] = useState(false);

  const opType = data.opType;
  const symbolType = resolveSymbolType(opType) || opType;
  const Symbol = getSymbol(opType);
  const isControl = !!CONTROL_DEFS[opType];

  const { state, chip } = deriveNodeState(opType, snap, data.params);
  const band = state === 'watch' ? 'var(--ws-watch, #D97706)'
    : state === 'nomodel' ? 'var(--ws-nomodel, #64748B)'
      : serviceColorOf(opType);

  const ringed = isAlarmState(state) || state === 'watch' || state === 'off';
  const borderColor = BORDER_BY_STATE[state] || 'var(--ws-ink-200, #E2E8F0)';

  // §5 row 19: the ring and the chips render whenever results exist — live or
  // not, and in print. Only the 1.0s blink is gated, and the FLOOD GUARD kills
  // even that once more than six cards are alarmed: severity is carried by
  // colour and chip count, never by tempo, and twenty blinking cards is noise.
  const blink = isAlarmState(state) && !!snap.live && !alarmFlood;

  // §5 row 20: a 240ms inward ink-darken on the service band, but only on the
  // nodes whose metrics ACTUALLY changed this tick — so you can watch which
  // part of the plant responded. `changedSeq === seq` is exactly that test.
  const ticked = !!snap.live && snap.changedSeq === snap.seq && snap.hasResults;

  return (
    <div
      className={cxs('ws-node', selected && 'ws-node--selected')}
      data-op={opType}
      data-state={state}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.node,
        border: `1px solid ${borderColor}`,
        boxShadow: hover ? 'var(--ws-elev-hover, 0 1px 2px rgba(15,23,42,.06))' : 'none',
        outline: selected ? '1px solid var(--ws-brand-900, #1F4E79)' : 'none',
      }}
    >
      {/* Input handle — LEFT, UNNAMED. Never give it an id: `edge.sourceHandle`
          feeds `edgeRole()` in the solver and `liveSignature`. */}
      <Handle type="target" position={Position.Left} style={styles.handle} />

      {/* 4px service band, inside the border, keyed so the heartbeat replays
          exactly once per tick on which this node's numbers moved. */}
      <div
        key={ticked ? snap.changedSeq : 'idle'}
        className={cxs('ws-node__band', ticked && 'ws-tick')}
        aria-hidden="true"
        style={{ ...styles.band, background: band, '--ws-band': band }}
      />

      <header style={styles.hdr}>
        <span style={styles.tag}>{getTag(opType)}</span>
        <span style={styles.label} title={data.label}>{data.label}</span>
        <NodeInfoButton opType={opType} label={data.label} data={data} />
      </header>

      {/* THE SYMBOL FRAME — 144 x 60, `contain: layout paint style` via
          `.ws-frame`. ALL animation lives inside this box and nowhere else. */}
      <div style={styles.frame}>
        <svg
          className="ws-frame"
          viewBox="0 0 144 60"
          width="144"
          height="60"
          aria-hidden="true"
          focusable="false"
          style={styles.svg}
        >
          <Symbol
            nodeId={id}
            opType={symbolType}
            data={data}
            state={state}
            snap={snap}
            /* §5.3 #10: the one-shot vessel prime staggers HEAD-WORKS FIRST via
               `--ws-x = clamp(0, position.x / 4, 400)`. `xPos`/`yPos` are
               ReactFlow's own node props — the position never has to be copied
               into `node.data`, which is saved, broadcast and hashed. */
            position={Number.isFinite(xPos) ? { x: xPos, y: yPos } : undefined}
          />
        </svg>
      </div>

      {/* FOOTER — always 22px, even when empty, or the 116px geometry breaks
          and the handles leave the symbol centreline. */}
      <footer style={styles.ft}>
        {isControl
          ? <ControlRow nodeId={id} opType={opType} data={data} />
          : <Readouts opType={opType} snap={snap} params={data.params} />}
        {chip && !isControl && (
          <span style={{ ...styles.chip, ...(CHIP_TONE[state] || CHIP_TONE.nomodel) }}>{chip}</span>
        )}
      </footer>

      {/* The alarm / watch ring. A real element, not a pseudo-element, so the
          pre-composed `box-shadow` is written once and only its OPACITY is
          animated — `box-shadow` itself is never animated (§7). */}
      {ringed && (
        <span
          aria-hidden="true"
          className={cxs('ws-node__ring', blink && 'ws-anim', blink && 'ws-alarm')}
          style={{
            ...styles.ring,
            boxShadow: `0 0 0 1px ${borderColor}`,
          }}
        />
      )}

      {selected && <CropMarks />}

      {/* Output handle — RIGHT, UNNAMED. */}
      <Handle type="source" position={Position.Right} style={styles.handle} />
    </div>
  );
});

UnitOpNode.displayName = 'UnitOpNode';
export default UnitOpNode;

// ═══════════════════════════════════════════════════════════════════════════
// Styles — geometry from the §1.3 / §2.1 tokens, with literal fallbacks so a
// test renderer that never loads canvas-tokens.css still lays the card out.
// ═══════════════════════════════════════════════════════════════════════════

const MONO = "var(--ws-font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace)";

const styles = {
  node: {
    position: 'relative',
    boxSizing: 'border-box',
    width: 'var(--ws-card-w, 168px)',
    height: 'var(--ws-card-h, 116px)',
    padding: 'var(--ws-card-pad, 6px)',
    borderRadius: 'var(--ws-r-card, 4px)',
    background: 'var(--ws-card, #FFFFFF)',
    cursor: 'grab',
    userSelect: 'none',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'visible',
    transition: 'box-shadow 180ms var(--ws-ease-in, cubic-bezier(.2,0,0,1)), border-color 180ms var(--ws-ease-in, cubic-bezier(.2,0,0,1))',
  },
  band: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 'var(--ws-band-h, 4px)',
    borderTopLeftRadius: 'var(--ws-r-card, 4px)',
    borderTopRightRadius: 'var(--ws-r-card, 4px)',
    pointerEvents: 'none',
  },
  hdr: {
    height: 'var(--ws-hdr-h, 22px)',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    paddingTop: 2,
  },
  tag: {
    fontFamily: MONO,
    fontVariantNumeric: 'tabular-nums lining-nums',
    fontSize: 'var(--ws-fs-tag, 9.5px)',
    fontWeight: 'var(--ws-fw-tag, 700)',
    letterSpacing: 'var(--ws-ls-tag, 0.06em)',
    textTransform: 'uppercase',
    color: 'var(--ws-ink-400, #94A3B8)',
    flexShrink: 0,
  },
  label: {
    flex: 1,
    minWidth: 0,
    fontFamily: "var(--ws-font-label, 'Inter', system-ui, sans-serif)",
    fontSize: 'var(--ws-fs-label, 11px)',
    fontWeight: 'var(--ws-fw-label, 600)',
    letterSpacing: 'var(--ws-ls-label, -0.005em)',
    color: 'var(--ws-ink-900, #0B1220)',
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  frame: {
    width: 'var(--ws-frame-w, 144px)',
    height: 'var(--ws-frame-h, 60px)',
    flex: '0 0 auto',
    borderRadius: 'var(--ws-r-frame, 2px)',
    overflow: 'hidden',
  },
  svg: { display: 'block', width: '100%', height: '100%' },
  ft: {
    height: 'var(--ws-ft-h, 22px)',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    minWidth: 0,
  },
  readoutRow: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, overflow: 'hidden' },
  readout: {
    display: 'inline-block',
    fontFamily: MONO,
    fontVariantNumeric: 'var(--ws-num-variant, tabular-nums lining-nums)',
    fontSize: 'var(--ws-fs-readout, 10.5px)',
    fontWeight: 'var(--ws-fw-readout, 500)',
    color: 'var(--ws-ink-700, #1E293B)',
    whiteSpace: 'nowrap',
    transformOrigin: 'left center',
  },
  readoutSecond: {
    fontFamily: MONO,
    fontVariantNumeric: 'var(--ws-num-variant, tabular-nums lining-nums)',
    fontSize: 9,
    color: 'var(--ws-ink-400, #94A3B8)',
    whiteSpace: 'nowrap',
  },
  readoutMuted: { fontFamily: MONO, fontSize: 'var(--ws-fs-readout, 10.5px)', color: 'var(--ws-ink-400, #94A3B8)' },
  unit: { fontSize: 'var(--ws-fs-unit, 0.85em)', color: 'var(--ws-ink-400, #94A3B8)' },
  chip: {
    fontFamily: MONO,
    fontSize: 'var(--ws-fs-chip, 9px)',
    fontWeight: 'var(--ws-fw-chip, 600)',
    letterSpacing: '0.04em',
    borderRadius: 'var(--ws-r-chip, 2px)',
    padding: '0 4px',
    lineHeight: '13px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  ring: {
    position: 'absolute',
    inset: -1,
    borderRadius: 'var(--ws-r-card, 4px)',
    pointerEvents: 'none',
  },
  infoBtn: {
    background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px',
    fontSize: 11, lineHeight: '14px', fontWeight: 700, flexShrink: 0,
    transition: 'opacity 0.12s ease, color 0.12s ease',
  },
  // 9 x 9 squares, radius 1, 1.5px ink border, white fill (spec §2.3). Kept at
  // ReactFlow's DEFAULT position — no `top` override, no `id`, both unnamed.
  handle: {
    width: 9, height: 9, borderRadius: 1,
    background: 'var(--ws-card, #FFFFFF)',
    border: '1.5px solid var(--ws-ink-700, #1E293B)',
    transition: 'transform 180ms var(--ws-ease-in, cubic-bezier(.2,0,0,1))',
  },
  controlRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' },
  pill: {
    fontFamily: MONO,
    fontSize: 'var(--ws-fs-pill, 9.5px)',
    fontWeight: 'var(--ws-fw-pill, 700)',
    letterSpacing: 'var(--ws-ls-pill, 0.04em)',
    borderRadius: 8, padding: '1px 7px', lineHeight: '14px',
  },
  switchTrack: {
    position: 'relative', width: 32, height: 18, borderRadius: 9, border: 'none',
    cursor: 'pointer', padding: 2, flexShrink: 0, display: 'inline-block',
    transition: 'background 0.15s ease',
  },
  switchKnob: {
    display: 'block', width: 14, height: 14, borderRadius: '50%', background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'transform 0.15s ease',
  },
};
