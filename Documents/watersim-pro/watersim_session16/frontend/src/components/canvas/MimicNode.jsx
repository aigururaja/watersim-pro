/**
 * MimicNode — the equipment card drawn as the MACHINE, the way the Live plant
 * draws it (components/mimic/MimicSymbols.jsx), so the sheet being built and
 * the plant being watched are one picture.
 *
 * Same 168 × 116 cell as UnitOpNode, same unnamed handles at ReactFlow's
 * default centre line — the mimic symbols' ports sit at y = 58 too — so a
 * saved flowsheet re-anchors nothing when the style is switched. The header
 * (tag · label · ⓘ) and the footer (the switch for a pump or valve, the
 * readout for everything else) are the SAME components UnitOpNode uses, laid
 * over the symbol; `src/test/unitOpNode.test.jsx` keeps pinning them.
 *
 * What moves, and why (the mimic's rule — nothing moves without a reason):
 *   · a pump or blower spins when its control says ON — the setpoint IS the
 *     rate depicted (the §5.1 Class-C exception) — and parks when the model
 *     reports it OFF;
 *   · a valve turns its handwheel with `open`;
 *   · a tank shows a water line only when the model reports `level_pct`;
 *   · an instrument reads what its bound transmitter says, else the model;
 *   · the water in the pipes is PipeEdge's business, from the stream results.
 *
 * Nothing here is written into `node.data` — the same honesty rule as every
 * other renderer on the sheet.
 */
import { memo, useState } from 'react';
import { Handle, Position } from 'reactflow';
import '../mimic/mimic.css';
import MimicSymbol from '../mimic/MimicSymbols';
import { familyOf } from '../mimic/mimicLayout';
import { useLiveNode, num, resolveType } from './liveStore';
import { isControlOn, controlPct } from './controlState';
import { CONTROL_DEFS, deriveNodeState, isAlarmState, useAlarmFlood, useNodeAlarm } from './nodeReadouts';
import { ControlRow, NodeInfoButton, Readouts, CropMarks } from './UnitOpNode';
import { getTag } from './symbols';

const cxs = (...p) => p.filter(Boolean).join(' ');
const READING_KIND = { LT: 'level', PT: 'pressure', FT: 'flow', AT: 'ph', TT: 'temperature' };
const READING_UNIT = { LT: '%', FT: 'm³/d', AT: 'pH', PT: 'bar', TT: '°C' };

/** The ISA function letters of the node's first tag: 'RFP-FT-201' → 'FT'. */
export function tagFunction(data) {
  const t = (data?.tags || [])[0] || '';
  const m = /-([A-Z]{2,3})-/.exec(String(t));
  return m ? m[1] : null;
}

/**
 * The mimic's state for a card, from what the sheet knows: the card's own
 * control params and the model's metrics. Same shape MimicView passes from
 * measured contacts — `running / tripped / opened / closed / level`.
 */
export function mimicStateOf(opType, family, snap, params, state) {
  const m = snap?.metrics || {};
  const s = {};
  if (family === 'drive' || family === 'dosing') {
    const def = CONTROL_DEFS[opType];
    let running = def ? isControlOn(params?.[def.paramKey]) : (snap?.hasResults ? true : undefined);
    if (m.status === 'OFF') running = false;
    s.running = running;
    s.tripped = isAlarmState(state);
  } else if (family === 'valve') {
    const open = isControlOn(params?.open) && controlPct(params?.opening_pct) > 0;
    s.opened = open;
    s.closed = !open;
  } else if (family === 'tank') {
    const lvl = num(m.level_pct);
    if (lvl != null) s.level = lvl;
  }
  return s;
}

/** What an instrument's dial or LCD shows: the bound transmitter if it has one, else the model. */
export function instrumentReading(snap, params) {
  const m = snap?.metrics || {};
  const measured = num(m.measured);
  const value = measured != null && measured >= 0 ? measured : (num(m.modelled) ?? num(m.value) ?? num(m.reading));
  const rangeMin = num(params?.range_min) ?? 0;
  const rangeMax = num(params?.range_max);
  return {
    value,
    quality: snap?.hasResults ? 'good' : 'unknown',
    rangeMin,
    rangeMax: rangeMax != null && rangeMax > rangeMin ? rangeMax : null,
  };
}

const CHIP_TONE = {
  alarm:   { background: '#FEE2E2', color: 'var(--ws-alarm, #DC2626)' },
  error:   { background: '#FEE2E2', color: 'var(--ws-alarm, #DC2626)' },
  watch:   { background: '#FEF3C7', color: 'var(--ws-watch, #D97706)' },
  nomodel: { background: '#F1F5F9', color: 'var(--ws-nomodel, #64748B)' },
};

const MimicNode = memo(({ id, data, selected }) => {
  const snap = useLiveNode(id);
  const alarmFlood = useAlarmFlood();
  const configuredAlarm = useNodeAlarm(id);
  const [hover, setHover] = useState(false);

  const opType = data.opType;
  const t = resolveType(opType) || opType;
  const family = familyOf(t);
  const isControl = !!CONTROL_DEFS[opType];

  const { state, chip, reason } = deriveNodeState(opType, snap, data.params, configuredAlarm);
  const s = mimicStateOf(opType, family, snap, data.params, state);
  const fn = family === 'instrument' ? (tagFunction(data) || 'FT') : null;
  const reading = family === 'instrument' ? instrumentReading(snap, data.params) : undefined;
  const label = String(data.label || '');

  const ringed = isAlarmState(state) || state === 'watch';
  const blink = isAlarmState(state) && !!snap.live && !alarmFlood;
  const ringColor = isAlarmState(state) ? 'var(--ws-alarm, #DC2626)' : 'var(--ws-watch, #D97706)';

  return (
    <div
      className={cxs('ws-node', 'ws-node--mimic', selected && 'ws-node--selected')}
      data-op={opType}
      data-state={state}
      data-style="mimic"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.node,
        outline: selected ? '1.5px solid var(--ws-brand-900, #1F4E79)' : hover ? '1px solid rgba(46,117,182,.45)' : 'none',
      }}
    >
      {/* Input handle — LEFT, UNNAMED, at the symbol's inlet port. */}
      <Handle type="target" position={Position.Left} style={styles.handle} />

      <svg className="ws-frame mimic-root" viewBox="0 0 168 116" width="168" height="116" aria-hidden="true" focusable="false" style={styles.svg}>
        <MimicSymbol
          family={family} opType={t} s={s} label={null}
          sub={family === 'tank' || family === 'basin' ? label.split(' — ')[0] : undefined}
          active={!!snap.hasResults}
          reading={reading} unit={fn ? READING_UNIT[fn] : undefined} kind={fn ? READING_KIND[fn] : undefined}
          chemical={family === 'dosing' ? label.split(' ')[0] : undefined}
        />
      </svg>

      <header style={styles.hdr}>
        <span style={styles.tag}>{getTag(opType)}</span>
        <span style={styles.label} title={label}>{label}</span>
        <span style={{ pointerEvents: 'auto', display: 'inline-flex' }}>
          <NodeInfoButton opType={opType} label={label} data={data} />
        </span>
      </header>

      <footer style={styles.ft}>
        {isControl
          ? <span style={styles.plate}><ControlRow nodeId={id} opType={opType} data={data} /></span>
          : <span style={styles.plate}><Readouts opType={opType} snap={snap} params={data.params} /></span>}
        {chip && !isControl && (
          <span style={{ ...styles.chip, ...(CHIP_TONE[state] || CHIP_TONE.nomodel) }} title={reason && reason !== chip ? reason : undefined}>
            {chip}
          </span>
        )}
      </footer>

      {ringed && (
        <span
          aria-hidden="true"
          className={cxs('ws-node__ring', blink && 'ws-anim', blink && 'ws-alarm')}
          style={{ ...styles.ring, boxShadow: `0 0 0 2px ${ringColor}` }}
        />
      )}

      {selected && <CropMarks />}

      {/* Output handle — RIGHT, UNNAMED, at the symbol's outlet port. */}
      <Handle type="source" position={Position.Right} style={styles.handle} />
    </div>
  );
});

MimicNode.displayName = 'MimicNode';
export default MimicNode;

const MONO = "var(--ws-font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace)";
const PLATE = 'rgba(255,255,255,.82)';

const styles = {
  node: {
    position: 'relative',
    boxSizing: 'border-box',
    width: 168,
    height: 116,
    background: 'transparent',
    borderRadius: 8,
    outlineOffset: 2,
    cursor: 'grab',
    userSelect: 'none',
    transition: 'outline-color 120ms ease',
  },
  svg: { position: 'absolute', inset: 0, display: 'block', overflow: 'visible' },
  hdr: {
    position: 'absolute', top: 1, left: 4, right: 4, height: 18,
    display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, pointerEvents: 'none',
  },
  tag: {
    fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--ws-ink-400, #94A3B8)', background: PLATE, borderRadius: 3, padding: '0 3px', lineHeight: '15px', flexShrink: 0,
  },
  label: {
    flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: 'var(--ws-ink-900, #0B1220)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    background: PLATE, borderRadius: 3, padding: '0 4px', lineHeight: '15px',
  },
  ft: {
    position: 'absolute', bottom: 0, left: 4, right: 4, height: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minWidth: 0,
  },
  plate: { display: 'inline-flex', alignItems: 'center', minWidth: 0, background: PLATE, borderRadius: 3, padding: '0 3px', maxWidth: '100%' },
  chip: {
    fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', borderRadius: 2, padding: '0 4px',
    lineHeight: '13px', whiteSpace: 'nowrap', flexShrink: 0,
  },
  ring: { position: 'absolute', inset: -2, borderRadius: 10, pointerEvents: 'none' },
  handle: {
    width: 9, height: 9, borderRadius: 1,
    background: 'var(--ws-card, #FFFFFF)',
    border: '1.5px solid var(--ws-ink-700, #1E293B)',
  },
};
