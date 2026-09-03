import { memo, useContext, useState } from 'react';
import { Handle, Position } from 'reactflow';
import { NodeControlContext, NodeInfoContext, isControlOn, controlPct } from './controlState';

const TYPE_COLORS = {
  inlet:              { bg: '#F0FDF4', border: '#16A34A', icon: '🌊' },
  outlet:             { bg: '#FFF7ED', border: '#EA580C', icon: '🏞️' },
  preliminary:        { bg: '#F0F4FF', border: '#6366F1', icon: '🔲' },
  screening:          { bg: '#F0F4FF', border: '#6366F1', icon: '🔲' },
  grit_removal:       { bg: '#F0F4FF', border: '#6366F1', icon: '🪨' },
  primary_clarifier:  { bg: '#EFF6FF', border: '#2E75B6', icon: '⬛' },
  activated_sludge:   { bg: '#F0FDF4', border: '#16A34A', icon: '🦠' },
  secondary_clarifier:{ bg: '#EFF6FF', border: '#2E75B6', icon: '⬜' },
  membrane_bioreactor:{ bg: '#FFF7ED', border: '#EA580C', icon: '🔵' },
  // Session 9 — Step 40: Advanced EBPR
  uct_reactor:        { bg: '#EEF2FF', border: '#4F46E5', icon: '🔄' },
  jhb_reactor:        { bg: '#FFF1F2', border: '#BE123C', icon: '🔀' },
  anaerobic_digester: { bg: '#FDF4FF', border: '#9333EA', icon: '⚗' },
  uv_disinfection:    { bg: '#FFFBEB', border: '#D97706', icon: '☀' },
  sand_filter:        { bg: '#F0FDF4', border: '#15803D', icon: '🟫' },
  granular_filter:    { bg: '#F0FDF4', border: '#15803D', icon: '🟫' },
  chlorination:       { bg: '#ECFDF5', border: '#059669', icon: '⚗️' },
  pump:               { bg: '#F8FAFC', border: '#94A3B8', icon: '⚙️' },
  valve:              { bg: '#F0F9FF', border: '#0284C7', icon: '🚰' },
  blower:             { bg: '#F8FAFC', border: '#94A3B8', icon: '🌀' },
  ro_membrane:        { bg: '#F0FDFA', border: '#0D9488', icon: '💧' },
  thickener:          { bg: '#FDF4FF', border: '#9333EA', icon: '🪣' },
  default:            { bg: '#F8FAFC', border: '#94A3B8', icon: '⬡' },
};

// ── Flow-control (pump / valve) state row: pill + toggle switch ──────────────

const CONTROL_DEFS = {
  pump:  { paramKey: 'running', pctKey: 'speed_pct',   onLabel: 'ON',   offLabel: 'OFF' },
  valve: { paramKey: 'open',    pctKey: 'opening_pct', onLabel: 'OPEN', offLabel: 'CLOSED' },
};

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
// Same in-node control contract as the pump/valve switch above: `nodrag` so the
// node is not dragged, and stopPropagation so the click never selects the node
// or opens the params panel.

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

const UnitOpNode = memo(({ id, data, selected }) => {
  const style = TYPE_COLORS[data.opType] || TYPE_COLORS.default;
  const isControl = !!CONTROL_DEFS[data.opType];
  // When OFF/CLOSED the node border goes red so the blocked element stands out.
  const off = isControl && !isControlOn(data.params?.[CONTROL_DEFS[data.opType].paramKey]);
  const borderColor = selected ? '#1F4E79' : off ? '#DC2626' : style.border;

  return (
    <div style={{
      ...styles.node,
      background: style.bg,
      border: `2px solid ${borderColor}`,
      boxShadow: selected ? `0 0 0 3px rgba(31,78,121,0.25)` : '0 2px 6px rgba(0,0,0,0.08)',
    }}>
      {/* Input handle (left) */}
      <Handle type="target" position={Position.Left} style={styles.handle} />

      {/* Corner ⓘ — every node explains itself */}
      <NodeInfoButton opType={data.opType} label={data.label} data={data} />

      <div style={styles.body}>
        <span style={styles.icon}>{style.icon}</span>
        <span style={styles.label}>{data.label}</span>
      </div>

      {isControl && <ControlRow nodeId={id} opType={data.opType} data={data} />}

      {/* Output handle (right) */}
      <Handle type="source" position={Position.Right} style={styles.handle} />
    </div>
  );
});

UnitOpNode.displayName = 'UnitOpNode';
export default UnitOpNode;

const styles = {
  node:   { position: 'relative', borderRadius: 8, padding: '10px 14px', minWidth: 150, cursor: 'grab', userSelect: 'none' },
  body:   { display: 'flex', alignItems: 'center', gap: 8, paddingRight: 12 },
  icon:   { fontSize: 18 },
  label:  { fontSize: 12, fontWeight: 600, color: '#111', fontFamily: 'Arial, sans-serif', lineHeight: 1.3 },
  infoBtn: {
    position: 'absolute', top: 1, right: 3, zIndex: 1,
    background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
    fontSize: 11, lineHeight: '14px', fontWeight: 700,
    transition: 'opacity 0.12s ease, color 0.12s ease',
  },
  handle: { width: 10, height: 10, background: '#2E75B6', border: '2px solid #fff' },
  controlRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  pill:   { fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', borderRadius: 8, padding: '1px 7px', lineHeight: '14px' },
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
