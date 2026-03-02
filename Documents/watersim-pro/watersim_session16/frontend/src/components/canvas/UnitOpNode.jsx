import { memo } from 'react';
import { Handle, Position } from 'reactflow';

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
  blower:             { bg: '#F8FAFC', border: '#94A3B8', icon: '🌀' },
  ro_membrane:        { bg: '#F0FDFA', border: '#0D9488', icon: '💧' },
  thickener:          { bg: '#FDF4FF', border: '#9333EA', icon: '🪣' },
  opc_read:           { bg: '#EFF6FF', border: '#1D4ED8', icon: '📡' },
  opc_write:          { bg: '#FEF3C7', border: '#B45309', icon: '📤' },
  default:            { bg: '#F8FAFC', border: '#94A3B8', icon: '⬡' },
};

// OPC nodes are data integration nodes — no connection handles needed.
// They inject/extract values globally via tagMappings, not via edges.
const OPC_TYPES = new Set(['opc_read', 'opc_write']);

const UnitOpNode = memo(({ data, selected }) => {
  const style = TYPE_COLORS[data.opType] || TYPE_COLORS.default;
  const isOpc = OPC_TYPES.has(data.opType);
  return (
    <div style={{
      ...styles.node,
      background: style.bg,
      border: `2px solid ${selected ? '#1F4E79' : style.border}`,
      boxShadow: selected ? `0 0 0 3px rgba(31,78,121,0.25)` : '0 2px 6px rgba(0,0,0,0.08)',
    }}>
      {/* Input handle (left) — not for OPC nodes */}
      {!isOpc && <Handle type="target" position={Position.Left} style={styles.handle} />}

      <div style={styles.body}>
        <span style={styles.icon}>{style.icon}</span>
        <span style={styles.label}>{data.label}</span>
      </div>

      {/* Output handle (right) — not for OPC nodes */}
      {!isOpc && <Handle type="source" position={Position.Right} style={styles.handle} />}
    </div>
  );
});

UnitOpNode.displayName = 'UnitOpNode';
export default UnitOpNode;

const styles = {
  node:   { borderRadius: 8, padding: '10px 14px', minWidth: 150, cursor: 'grab', userSelect: 'none' },
  body:   { display: 'flex', alignItems: 'center', gap: 8 },
  icon:   { fontSize: 18 },
  label:  { fontSize: 12, fontWeight: 600, color: '#111', fontFamily: 'Arial, sans-serif', lineHeight: 1.3 },
  handle: { width: 10, height: 10, background: '#2E75B6', border: '2px solid #fff' },
};
