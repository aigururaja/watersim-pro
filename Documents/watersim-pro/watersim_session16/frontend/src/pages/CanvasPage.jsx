import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactFlow, {
  addEdge, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  Panel, EdgeLabelRenderer, BaseEdge, getStraightPath,
  ReactFlowProvider, useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';
import api from '../utils/api';
import AppLayout from '../components/layout/AppLayout';
import UnitOpNode from '../components/canvas/UnitOpNode';
import UnitOpPalette from '../components/canvas/UnitOpPalette';
import PresenceAvatars from '../components/canvas/PresenceAvatars';
import RemoteCursors from '../components/canvas/RemoteCursors';
import SimBanner from '../components/canvas/SimBanner';
import LiveSimPanel, { TrendOverlay } from '../components/canvas/LiveSimPanel';
import OpcConnectionDialog from '../components/canvas/OpcConnectionDialog';
import OpcTagTable from '../components/canvas/OpcTagTable';
import { useCollaboration } from '../hooks/useCollaboration';
import { useCanvasPerf } from '../hooks/useCanvasPerf';
import useOpcPolling from '../hooks/useOpcPolling';
import useLiveSimStore from '../store/liveSimStore';
import useOpcStore from '../store/opcStore';

// ── Custom stream-labelled edge ──────────────────────────────────────────────

const StreamEdge = React.memo(function StreamEdge({ id, sourceX, sourceY, targetX, targetY, data, style = {}, markerEnd, selected }) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const stream     = data?.streamResult;
  const isRecycle  = data?.isRecycle || (data?.streamType && data.streamType !== 'stream');
  const streamType = data?.streamType || 'stream';

  const label = stream
    ? isRecycle
      ? `RAS: ${stream.Q} m³/d`
      : `Q: ${stream.Q} m³/d`
    : null;

  const edgeColor = selected ? '#EF4444' : isRecycle ? '#F97316' : (stream ? '#0ea5e9' : '#2E75B6');
  const edgeDash  = isRecycle ? '6 3' : undefined;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} interactionWidth={20} style={{
        stroke: edgeColor,
        strokeWidth: selected ? 3.5 : (stream ? 2.5 : 2),
        strokeDasharray: edgeDash,
        ...style,
      }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: selected ? '#FEF2F2' : isRecycle ? '#FFF7ED' : '#f0f9ff',
              border: `1px solid ${selected ? '#FCA5A5' : isRecycle ? '#FED7AA' : '#7dd3fc'}`,
              borderRadius: 4,
              padding: '1px 7px',
              fontSize: 10,
              fontWeight: 600,
              color: selected ? '#DC2626' : isRecycle ? '#9A3412' : '#0369a1',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 10,
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

// ── Node param definitions ────────────────────────────────────────────────────

const PARAM_DEFS = {
  inlet: [
    { key: 'Q',    label: 'Flow (m³/d)',      type: 'number', step: 100 },
    { key: 'BOD',  label: 'BOD (mg/L)',       type: 'number', step: 5 },
    { key: 'COD',  label: 'COD (mg/L)',       type: 'number', step: 10 },
    { key: 'TSS',  label: 'TSS (mg/L)',       type: 'number', step: 5 },
    { key: 'TN',   label: 'TN (mg/L)',        type: 'number', step: 1 },
    { key: 'NH4',  label: 'NH₄-N (mg/L)',     type: 'number', step: 1 },
    { key: 'TP',   label: 'TP (mg/L)',        type: 'number', step: 0.5 },
    { key: 'pH',   label: 'pH',               type: 'number', step: 0.1, min: 4, max: 10 },
    { key: 'temp', label: 'Temperature (°C)', type: 'number', step: 1 },
  ],
  screening: [
    { key: 'screenType', label: 'Screen Type', type: 'select', options: ['coarse','fine','micro'] },
    { key: 'headloss_m', label: 'Head Loss (m)', type: 'number', step: 0.05 },
  ],
  grit_removal: [
    { key: 'chamberType', label: 'Chamber Type', type: 'select', options: ['vortex','aerated','horizontal'] },
    { key: 'HRT_min',     label: 'HRT (min)',    type: 'number', step: 0.5 },
  ],
  primary_clarifier: [
    { key: 'SOR_m3_m2_d', label: 'SOR (m³/m²/d)',   type: 'number', step: 2 },
    { key: 'depth_m',     label: 'Depth (m)',         type: 'number', step: 0.5 },
    { key: 'sludge_TSS',  label: 'Sludge TSS (mg/L)', type: 'number', step: 1000 },
  ],
  activated_sludge: [
    { key: 'SRT_d',            label: 'SRT (days)',              type: 'number', step: 1 },
    { key: 'MLSS_mg_L',        label: 'MLSS (mg/L)',             type: 'number', step: 100 },
    { key: 'DO_set_mg_L',      label: 'DO Setpoint (mg/L)',      type: 'number', step: 0.5 },
    { key: 'volume_m3',        label: 'Volume m³ (0=auto)',      type: 'number', step: 500 },
    { key: 'denitrification',  label: 'Denitrification',         type: 'select', options: ['false','true'] },
    { key: 'anoxic_fraction',  label: 'Anoxic Fraction (0–1)',   type: 'number', step: 0.05, min: 0, max: 0.6 },
    { key: 'ebpr_config',      label: 'EBPR Config',             type: 'select',
      options: ['none','simple','uct','jhb'],
      hint: 'none=off · simple=anaerobic selector · uct=UCT · jhb=JHB' },
    { key: 'anaerobic_fraction',label: 'Anaerobic Fraction',     type: 'number', step: 0.05, min: 0, max: 0.4 },
    { key: 'PAO_fraction',     label: 'PAO Fraction of MLVSS',   type: 'number', step: 0.05, min: 0.1, max: 0.7 },
    { key: 'uct_anoxic_fraction', label: 'Main Anoxic Fraction (UCT/JHB)', type: 'number', step: 0.05, min: 0.1, max: 0.5 },
    { key: 'MLR_ratio',        label: 'MLR Ratio (×Qin)',        type: 'number', step: 0.5, min: 0.5, max: 6,
      hint: 'Mixed Liquor Recycle. UCT: 2–4. JHB: 1.5–2.5' },
    { key: 'jhb_preanoxic_fraction', label: 'Pre-Anoxic Fraction (JHB)', type: 'number', step: 0.02, min: 0.02, max: 0.15 },
  ],
  secondary_clarifier: [
    { key: 'SOR_m3_m2_d', label: 'SOR (m³/m²/d)',       type: 'number', step: 1 },
    { key: 'RAS_ratio',   label: 'RAS Ratio',            type: 'number', step: 0.1, min: 0.1, max: 1.5 },
    { key: 'TSS_effluent',label: 'Target Effluent TSS (mg/L)', type: 'number', step: 1 },
  ],
  membrane_bioreactor: [
    { key: 'SRT_d',           label: 'SRT (days)',           type: 'number', step: 1 },
    { key: 'MLSS_mg_L',       label: 'MLSS (mg/L)',          type: 'number', step: 500 },
    { key: 'DO_set_mg_L',     label: 'DO Setpoint (mg/L)',   type: 'number', step: 0.5 },
    { key: 'denitrification', label: 'Denitrification',      type: 'select', options: ['false','true'] },
    { key: 'anoxic_fraction', label: 'Anoxic Fraction (0–1)',type: 'number', step: 0.05, min: 0, max: 0.6 },
    { key: 'ebpr_config',     label: 'EBPR Config',          type: 'select', options: ['none','simple','uct','jhb'] },
  ],
  // ── Session 9 — Step 40: Advanced EBPR (UCT / JHB) dedicated nodes ────────
  uct_reactor: [
    { key: 'SRT_d',               label: 'SRT (days)',                type: 'number', step: 1, min: 8 },
    { key: 'MLSS_mg_L',           label: 'MLSS (mg/L)',               type: 'number', step: 100 },
    { key: 'DO_set_mg_L',         label: 'DO Setpoint (mg/L)',        type: 'number', step: 0.5 },
    { key: 'volume_m3',           label: 'Total Volume m³ (0=auto)', type: 'number', step: 500 },
    { key: 'anaerobic_fraction',  label: 'Anaerobic Zone Fraction',   type: 'number', step: 0.05, min: 0.05, max: 0.30,
      hint: 'Typical UCT: 0.10–0.20' },
    { key: 'uct_anoxic_fraction', label: 'Anoxic Zone Fraction',      type: 'number', step: 0.05, min: 0.10, max: 0.45,
      hint: 'Typical UCT: 0.20–0.35' },
    { key: 'MLR_ratio',           label: 'MLR Ratio (×Qin)',          type: 'number', step: 0.5, min: 1, max: 6,
      hint: 'Recycle from aerobic→anoxic. Typical: 2–4' },
    { key: 'PAO_fraction',        label: 'PAO Fraction of MLVSS',     type: 'number', step: 0.05, min: 0.10, max: 0.70 },
    { key: 'VFA_COD_fraction',    label: 'VFA/COD Fraction',          type: 'number', step: 0.01, min: 0.05, max: 0.35,
      hint: 'Readily-biodegradable COD fraction available for PAOs' },
    { key: 'ebpr_uptake_rate',    label: 'PAO Uptake Rate (g P/gVSS/d)', type: 'number', step: 0.01, min: 0.05, max: 0.40 },
  ],
  jhb_reactor: [
    { key: 'SRT_d',                  label: 'SRT (days)',                 type: 'number', step: 1, min: 8 },
    { key: 'MLSS_mg_L',              label: 'MLSS (mg/L)',                type: 'number', step: 100 },
    { key: 'DO_set_mg_L',            label: 'DO Setpoint (mg/L)',         type: 'number', step: 0.5 },
    { key: 'volume_m3',              label: 'Total Volume m³ (0=auto)',  type: 'number', step: 500 },
    { key: 'jhb_preanoxic_fraction', label: 'Pre-Anoxic Zone Fraction',   type: 'number', step: 0.02, min: 0.02, max: 0.15,
      hint: 'Denitrifies RAS before anaerobic zone. Typical: 0.05–0.10' },
    { key: 'anaerobic_fraction',     label: 'Anaerobic Zone Fraction',    type: 'number', step: 0.05, min: 0.05, max: 0.25,
      hint: 'Protected from NO₃ by pre-anoxic zone. Typical: 0.10–0.20' },
    { key: 'uct_anoxic_fraction',    label: 'Main Anoxic Zone Fraction',  type: 'number', step: 0.05, min: 0.10, max: 0.40,
      hint: 'Denitrifies MLR. Typical: 0.20–0.30' },
    { key: 'MLR_ratio',              label: 'MLR Ratio (×Qin)',           type: 'number', step: 0.5, min: 1, max: 5,
      hint: 'Recycle from aerobic→main anoxic. Typical: 1.5–2.5' },
    { key: 'PAO_fraction',           label: 'PAO Fraction of MLVSS',      type: 'number', step: 0.05, min: 0.10, max: 0.70 },
    { key: 'VFA_COD_fraction',       label: 'VFA/COD Fraction',           type: 'number', step: 0.01, min: 0.05, max: 0.35 },
    { key: 'ebpr_uptake_rate',       label: 'PAO Uptake Rate (g P/gVSS/d)', type: 'number', step: 0.01, min: 0.05, max: 0.40 },
  ],
  chemical_dosing: [
    { key: 'chemical_type',  label: 'Chemical Type',     type: 'select',
      options: ['alum','ferric_chloride','polymer','naoh','h2so4','naocl'] },
    { key: 'dose_mg_L',      label: 'Dose (mg/L)',        type: 'number', step: 1, min: 0 },
    { key: 'target_pH',      label: 'Target pH (optional)',type: 'number', step: 0.1, min: 0, max: 14 },
  ],
  coagulant_dosing: [
    { key: 'chemical_type',  label: 'Chemical Type',     type: 'select', options: ['alum','ferric_chloride'] },
    { key: 'dose_mg_L',      label: 'Dose (mg/L)',        type: 'number', step: 5,  min: 0 },
  ],
  polymer_dosing: [
    { key: 'chemical_type',  label: 'Chemical Type',     type: 'select', options: ['polymer'] },
    { key: 'dose_mg_L',      label: 'Dose (mg/L)',        type: 'number', step: 1,  min: 0 },
  ],
  ph_adjustment: [
    { key: 'chemical_type',  label: 'Chemical Type',     type: 'select', options: ['naoh','h2so4'] },
    { key: 'dose_mg_L',      label: 'Dose (mg/L)',        type: 'number', step: 5,  min: 0 },
    { key: 'target_pH',      label: 'Target pH',          type: 'number', step: 0.1, min: 2, max: 12 },
  ],
  chlorination: [
    { key: 'chemical_type',  label: 'Chemical Type',     type: 'select', options: ['naocl','hypochlorite'] },
    { key: 'dose_mg_L',      label: 'Cl₂ Dose (mg/L)',   type: 'number', step: 1,  min: 0 },
  ],
  ro_membrane: [
    { key: 'recovery_pct',   label: 'Recovery (%)',     type: 'number', step: 1, min: 30, max: 95 },
    { key: 'salt_rejection', label: 'Salt Rejection',   type: 'number', step: 0.01 },
    { key: 'pressure_bar',   label: 'Pressure (bar)',   type: 'number', step: 1 },
  ],
  thickener: [
    { key: 'thickened_TSS_mg_L', label: 'Thickened TSS (mg/L)', type: 'number', step: 1000 },
    { key: 'solids_capture',     label: 'Solids Capture (0-1)', type: 'number', step: 0.01 },
  ],
  // ── Session 8 — Step 38: Tertiary treatment params ────────────────────────
  uv_disinfection: [
    { key: 'target_log_reduction', label: 'Target Log Reduction',    type: 'number', step: 0.5, min: 1, max: 6 },
    { key: 'UVT_pct',              label: 'UV Transmittance (%)',     type: 'number', step: 1, min: 20, max: 99 },
    { key: 'lamp_power_kW',        label: 'Lamp Power (kW)',         type: 'number', step: 0.05 },
    { key: 'lamp_Q_rating_m3_h',   label: 'Lamp Rating (m³/h)',      type: 'number', step: 10 },
    { key: 'k_inact_mJ_cm2',       label: 'k_inact (mJ/cm²)',        type: 'number', step: 1, min: 5,
      hint: 'Organism: E.coli=19, Crypto=10, Giardia=82' },
  ],
  sand_filter: [
    { key: 'filter_type',     label: 'Filter Type',             type: 'select', options: ['dual_media','sand'] },
    { key: 'HLR_m_h',        label: 'Hydraulic Loading (m/h)', type: 'number', step: 1, min: 2, max: 20 },
    { key: 'TSS_removal_pct',label: 'Target TSS Removal (%)',  type: 'number', step: 5, min: 50, max: 99 },
    { key: 'sand_depth_m',   label: 'Sand Depth (m)',          type: 'number', step: 0.05 },
    { key: 'backwash_interval_h', label: 'Backwash Interval (h)', type: 'number', step: 1, min: 4 },
  ],
  // ── Session 8 — Step 39: ADM1-lite digester params ───────────────────────
  anaerobic_digester: [
    { key: 'HRT_d',            label: 'HRT (days)',               type: 'number', step: 1, min: 8 },
    { key: 'temp_C',           label: 'Temperature (°C)',         type: 'number', step: 1, min: 20, max: 65,
      hint: 'Mesophilic: 30–40°C. Thermophilic: 50–60°C' },
    { key: 'COD_removal_pct',  label: 'VS/COD Destruction (%)',   type: 'number', step: 5, min: 20, max: 85 },
    { key: 'pH_setpoint',      label: 'Digester pH setpoint',     type: 'number', step: 0.1, min: 6.5, max: 8 },
    { key: 'biogas_CH4_frac',  label: 'Biogas CH₄ fraction',      type: 'number', step: 0.01, min: 0.5, max: 0.75 },
    { key: 'dewatering',       label: 'Dewatering',               type: 'select', options: ['false','true'],
      hint: 'true = digestate split into cake + centrate' },
    { key: 'cake_DS_pct',      label: 'Cake Dry Solids (%)',      type: 'number', step: 1, min: 12, max: 35 },
  ],
  // ── OPC Integration — uses OpcConfigPanel instead of ParamPanel ─────────
  opc_read:  [],
  opc_write: [],
};

// ── Main component ────────────────────────────────────────────────────────────

const nodeTypes = { unitOp: UnitOpNode };
const edgeTypes = { stream: StreamEdge };

let idCounter = 1;
const getId = () => `node_${idCounter++}`;

export default function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasPageInner />
    </ReactFlowProvider>
  );
}

// ── OPC Toolbar Button (shows connection status dot) ────────────────────────
function OpcToolbarBtn({ onClick }) {
  const connStatus = useOpcStore(s => s.connStatus);
  const dotColor = { disconnected: '#9CA3AF', connecting: '#F59E0B', connected: '#16A34A', error: '#DC2626' }[connStatus];
  return (
    <button
      style={{ border: 'none', borderRadius: 5, padding: '5px 10px', fontWeight: 600, cursor: 'pointer', fontSize: 12, minHeight: 30, background: '#1F4E79', color: '#fff', display: 'flex', alignItems: 'center', gap: 4 }}
      onClick={onClick}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
      OPC
    </button>
  );
}

// ── Minimal info panel shown when OPC node is clicked ───────────────────────
function OpcNodeInfoPanel({ node, onOpenTagTable, onOpenConnection, onClose }) {
  const connStatus = useOpcStore(s => s.connStatus);
  const isRead = node.data.opType === 'opc_read';
  const mappings = node.data.params?.tagMappings || [];
  const mapped = mappings.filter(m => m.opcTag).length;
  const dotColor = { disconnected: '#9CA3AF', connecting: '#F59E0B', connected: '#16A34A', error: '#DC2626' }[connStatus];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #E5E7EB' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>{node.data.label}</div>
          <div style={{ fontSize: 11, color: '#9CA3AF' }}>{isRead ? 'OPC Read' : 'OPC Write'}</div>
        </div>
        <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 }} onClick={onClose}>{'\u2715'}</button>
      </div>
      <div style={{ padding: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, fontSize: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
          <span style={{ color: '#374151' }}>{connStatus}</span>
        </div>
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 16 }}>
          {mapped} tag{mapped !== 1 ? 's' : ''} mapped
        </div>
        <button
          style={{ width: '100%', border: 'none', borderRadius: 5, padding: '8px 12px', fontWeight: 600, cursor: 'pointer', fontSize: 12, background: '#7C3AED', color: '#fff', marginBottom: 8 }}
          onClick={onOpenTagTable}
        >
          Open Tag Table
        </button>
        <button
          style={{ width: '100%', border: 'none', borderRadius: 5, padding: '8px 12px', fontWeight: 600, cursor: 'pointer', fontSize: 12, background: '#1F4E79', color: '#fff' }}
          onClick={onOpenConnection}
        >
          OPC Connection
        </button>
      </div>
    </div>
  );
}

function CanvasPageInner() {
  const { projectId, flowsheetId } = useParams();
  const navigate   = useNavigate();
  const reactFlowInstance = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // ── Canvas performance monitor (FPS overlay in dev) ──────────────────────
  const { PerfOverlay } = useCanvasPerf(nodes, edges);

  const [flowsheet, setFlowsheet]   = useState(null);
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(true);

  // ── Collab: remote event handler (must be defined before useCollaboration) ─
  const handleRemoteEvent = useCallback(({ type, payload, from }) => {
    switch (type) {
      case 'node:add':
        setNodes(ns => {
          if (ns.find(n => n.id === payload.id)) return ns;
          return [...ns, payload];
        });
        break;
      case 'node:delete':
        setNodes(ns => ns.filter(n => n.id !== payload.id));
        break;
      case 'node:move':
        setNodes(ns => ns.map(n =>
          n.id === payload.id
            ? { ...n, position: payload.position }
            : n
        ));
        break;
      case 'edge:add':
        setEdges(eds => {
          if (eds.find(e => e.id === payload.id)) return eds;
          return [...eds, payload];
        });
        break;
      case 'edge:delete':
        setEdges(eds => eds.filter(e => e.id !== payload.id));
        break;
      case 'params:update':
        setNodes(ns => ns.map(n =>
          n.id === payload.nodeId
            ? { ...n, data: { ...n.data, params: { ...n.data.params, ...payload.params } } }
            : n
        ));
        break;
      case 'sim:result':
        if (payload?.results) {
          setSimResults(payload);
          setEdges(eds => eds.map(e => ({
            ...e,
            type: 'stream',
            data: { ...e.data, streamResult: payload.results?.streamResults?.[e.id] || null },
          })));
          setShowSummary(true);
        }
        break;
      default:
        break;
    }
  }, []);

  // ── Collaboration hook ────────────────────────────────────────────────────
  const { sendEvent, presence, self: collabSelf, remoteCursors, simBanner, wsConnected } =
    useCollaboration(flowsheetId, { onRemoteEvent: handleRemoteEvent });

  // Throttled cursor broadcast ref
  const cursorThrottleRef = useRef(null);

  // Snapshot state
  const [showSnapModal, setShowSnapModal] = useState(false);
  const [snapName, setSnapName]           = useState('');
  const [snapping, setSnapping]           = useState(false);
  const [snapToast, setSnapToast]         = useState(null);

  const [simulating, setSimulating] = useState(false);
  const [simResults, setSimResults] = useState(null);
  const [simError, setSimError]     = useState(null);

  const [selectedNode, setSelectedNode] = useState(null);
  const [showSummary, setShowSummary]   = useState(false);

  // ── Dynamic simulation ─────────────────────────────────────────────────────
  const [showDynamic, setShowDynamic]       = useState(false);
  const [dynamicResults, setDynamicResults] = useState(null);
  const [dynamicRunning, setDynamicRunning] = useState(false);

  // ── Live simulation ────────────────────────────────────────────────────────
  const [showLiveSim, setShowLiveSim] = useState(false);
  const [showTrend, setShowTrend]     = useState(false);

  // ── OPC dialogs ────────────────────────────────────────────────────────────
  const [showOpcConnection, setShowOpcConnection] = useState(false);
  const [showOpcTagTable, setShowOpcTagTable]     = useState(false);

  // ── Scenario comparison ────────────────────────────────────────────────────
  const [showScenarios, setShowScenarios]     = useState(false);
  const [scenarioResults, setScenarioResults] = useState(null);
  const [scenariosRunning, setScenariosRunning] = useState(false);

  // ── Design / Run mode ────────────────────────────────────────────────────
  const [mode, setMode] = useState('design'); // 'design' | 'run'

  // ── Load flowsheet ────────────────────────────────────────────────────────
  useEffect(() => {
    api.get(`/projects/${projectId}/flowsheets/${flowsheetId}`)
      .then(({ data }) => {
        setFlowsheet(data);
        const canvas = data.canvas_data || {};
        setNodes(canvas.nodes || []);
        setEdges(canvas.edges || []);
        idCounter = (canvas.nodes?.length || 0) + 1;
      })
      .catch(() => navigate(`/projects/${projectId}`));
  }, [flowsheetId]);

  // ── Hydrate global OPC store from first OPC node found ────────────────────
  const opcHydratedRef = useRef(false);
  useEffect(() => {
    if (opcHydratedRef.current || nodes.length === 0) return;
    const opcNode = nodes.find(n => n.data?.opType === 'opc_read' || n.data?.opType === 'opc_write');
    if (opcNode?.data?.params) {
      opcHydratedRef.current = true;
      useOpcStore.getState().hydrateFromNode(opcNode.data.params);
      useOpcStore.getState().checkStatus();
    }
  }, [nodes.length]);

  // ── Connections ────────────────────────────────────────────────────────────
  const onConnect = useCallback((params) => {
    const newEdge = {
      ...params,
      id:       `edge_${Date.now()}`,
      type:     'stream',
      animated: true,
      data:     { streamType: 'stream' },
    };
    setEdges(eds => addEdge(newEdge, eds));
    setSaved(false);
    sendEvent('edge:add', newEdge);
  }, [sendEvent]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.patch(`/projects/${projectId}/flowsheets/${flowsheetId}`, {
        canvasData: { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } },
      });
      setSaved(true);
    } catch (err) {
      alert('Save failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  }, [projectId, flowsheetId, nodes, edges]);

  // ── Debounced auto-save (3 s after last unsaved change) ────────────────────
  const autoSaveTimerRef = useRef(null);
  useEffect(() => {
    if (saved) return;
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => { save(); }, 3000);
    return () => clearTimeout(autoSaveTimerRef.current);
  }, [saved, save]);

  const takeSnapshot = async (e) => {
    e?.preventDefault();
    if (!snapName.trim()) return;
    setSnapping(true);
    try {
      await api.post(`/projects/${projectId}/flowsheets/${flowsheetId}/snapshot`, {
        name: snapName.trim(),
      });
      setShowSnapModal(false);
      setSnapName('');
      setSnapToast('Snapshot saved!');
      setTimeout(() => setSnapToast(null), 3000);
    } catch (err) {
      alert('Snapshot failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setSnapping(false);
    }
  };

  // ── Build nodeParams from canvas state ────────────────────────────────────
  const buildNodeParams = () => {
    const nodeParams = {};
    for (const n of nodes) {
      if (n.data?.params && Object.keys(n.data.params).length > 0) {
        const p = { ...n.data.params };
        if (p.denitrification !== undefined)
          p.denitrification = p.denitrification === true || p.denitrification === 'true';
        if (p.ebpr !== undefined)
          p.ebpr = p.ebpr === true || p.ebpr === 'true';
        // ebpr_config is a string — pass through as-is; set ebpr_config from ebpr if not set
        if (!p.ebpr_config || p.ebpr_config === 'none') {
          if (p.ebpr) p.ebpr_config = 'simple';
        }
        if (p.dewatering !== undefined)
          p.dewatering = p.dewatering === true || p.dewatering === 'true';
        nodeParams[n.id] = p;
      }
    }
    return nodeParams;
  };

  // ── Simulate ───────────────────────────────────────────────────────────────
  const simulate = async () => {
    setSimulating(true);
    setSimError(null);
    sendEvent('sim:running', {});
    try {
      const { data } = await api.post(
        `/projects/${projectId}/flowsheets/${flowsheetId}/simulate`,
        { mode: 'steady_state', nodeParams: buildNodeParams() }
      );
      setSimResults(data);
      setEdges(eds => eds.map(e => ({
        ...e,
        type: 'stream',
        data: { ...e.data, streamResult: data.results?.streamResults?.[e.id] || null },
      })));
      setShowDynamic(false);
      setShowScenarios(false);
      // Keep OPC panels open after simulation so they can display the new stream values
      const isOpc = selectedNode?.data?.opType === 'opc_read' || selectedNode?.data?.opType === 'opc_write';
      if (!isOpc) {
        setShowSummary(true);
        setSelectedNode(null);
      }
      sendEvent('sim:result', data);
    } catch (err) {
      setSimError(err.response?.data?.error || err.message);
    } finally {
      setSimulating(false);
    }
  };

  // ── Dynamic simulation ─────────────────────────────────────────────────────
  const runDynamic = async (timeSeriesConfig) => {
    setDynamicRunning(true);
    setSimError(null);
    try {
      const { data } = await api.post(
        `/projects/${projectId}/flowsheets/${flowsheetId}/simulate`,
        { mode: 'dynamic', nodeParams: buildNodeParams(), timeSeriesConfig }
      );
      setDynamicResults(data);
    } catch (err) {
      setSimError(err.response?.data?.error || err.message);
    } finally {
      setDynamicRunning(false);
    }
  };

  // ── Batch scenario comparison ──────────────────────────────────────────────
  const runBatch = async (scenarios) => {
    setScenariosRunning(true);
    setSimError(null);
    try {
      const { data } = await api.post(
        `/projects/${projectId}/flowsheets/${flowsheetId}/simulate/batch`,
        { scenarios }
      );
      setScenarioResults(data);
    } catch (err) {
      setSimError(err.response?.data?.error || err.message);
    } finally {
      setScenariosRunning(false);
    }
  };

  // ── Clear results ──────────────────────────────────────────────────────────
  const clearResults = () => {
    setSimResults(null);
    setDynamicResults(null);
    setScenarioResults(null);
    setShowSummary(false);
    setShowDynamic(false);
    setShowScenarios(false);
    setEdges(eds => eds.map(e => ({ ...e, data: { ...e.data, streamResult: null } })));
  };

  const switchToDesign = useCallback(() => {
    setMode('design');
    clearResults();
    useLiveSimStore.getState().reset();
    setShowLiveSim(false);
  }, []);

  const switchToRun = useCallback(() => {
    setMode('run');
    setSelectedNode(null);
  }, []);

  // ── Live simulation: update edge labels as steps stream in ────────────────
  const liveSteps = useLiveSimStore(s => s.steps);
  const latestLiveStep = liveSteps.length ? liveSteps[liveSteps.length - 1] : null;
  useEffect(() => {
    if (!latestLiveStep?.streamResults) return;
    setEdges(eds => eds.map(e => ({
      ...e,
      type: 'stream',
      data: { ...e.data, streamResult: latestLiveStep.streamResults[e.id] || e.data.streamResult },
    })));
  }, [latestLiveStep, setEdges]);

  // ── Drop ───────────────────────────────────────────────────────────────────
  // OPC nodes are singleton — only one opc_read and one opc_write allowed
  const SINGLETON_OPC_TYPES = new Set(['opc_read', 'opc_write']);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const type  = event.dataTransfer.getData('application/unitop-type');
    const label = event.dataTransfer.getData('application/unitop-label');
    if (!type) return;

    // Enforce single OPC read / single OPC write
    if (SINGLETON_OPC_TYPES.has(type)) {
      const existing = nodes.find(n => n.data?.opType === type);
      if (existing) return; // silently ignore — already on canvas
    }

    // Convert screen coordinates to flow coordinates (accounts for zoom/pan)
    const position = reactFlowInstance.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const newNode = {
      id:   getId(),
      type: 'unitOp',
      position,
      data: { label, opType: type, params: {
        // Inject default ebpr_config for advanced EBPR dedicated nodes
        ...(type === 'uct_reactor' ? { ebpr_config: 'uct', MLR_ratio: 3.0, anaerobic_fraction: 0.15, uct_anoxic_fraction: 0.25 } : {}),
        ...(type === 'jhb_reactor' ? { ebpr_config: 'jhb', MLR_ratio: 2.0, jhb_preanoxic_fraction: 0.08, anaerobic_fraction: 0.15, uct_anoxic_fraction: 0.22 } : {}),
      } },
    };
    setNodes(ns => [...ns, newNode]);
    setSaved(false);
    sendEvent('node:add', newNode);
  }, [sendEvent, reactFlowInstance, nodes]);

  const onDragOver = (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; };

  const onNodesChangeWrapped = useCallback((changes) => {
    onNodesChange(changes);
    if (changes.some(c => c.type !== 'select' && c.type !== 'dimensions')) setSaved(false);
  }, [onNodesChange]);

  // ── Node click → param editor ──────────────────────────────────────────────
  const onNodeClick = useCallback((_evt, node) => {
    setSelectedNode(node);
    setShowSummary(false);
  }, []);

  // ── Update param ───────────────────────────────────────────────────────────
  const updateParam = useCallback((nodeId, key, value) => {
    setNodes(ns => ns.map(n =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } }
        : n
    ));
    setSelectedNode(sn => sn?.id === nodeId
      ? { ...sn, data: { ...sn.data, params: { ...sn.data.params, [key]: value } } }
      : sn
    );
    setSaved(false);
    sendEvent('params:update', { nodeId, params: { [key]: value } });
  }, [sendEvent]);

  // ── Background OPC polling (runs even when tag table is closed) ──────────
  useOpcPolling(nodes, updateParam);

  // Broadcast node position after drag ends
  const onNodeDragStop = useCallback((_evt, node) => {
    sendEvent('node:move', { id: node.id, position: node.position });
  }, [sendEvent]);

  // Broadcast cursor position (throttled 50 ms)
  const onMouseMoveCanvas = useCallback((evt) => {
    if (cursorThrottleRef.current) return;
    const bounds = evt.currentTarget?.getBoundingClientRect();
    if (!bounds) return;
    cursorThrottleRef.current = setTimeout(() => { cursorThrottleRef.current = null; }, 50);
    sendEvent('cursor:move', {
      x: evt.clientX - bounds.left,
      y: evt.clientY - bounds.top,
    });
  }, [sendEvent]);

  const summary       = useMemo(() => simResults?.results?.summary,       [simResults]);
  const costBreakdown = useMemo(() => simResults?.results?.costBreakdown, [simResults]);
  const warnings      = useMemo(() => simResults?.warnings || [],         [simResults]);
  const hasAnyResults = simResults || dynamicResults || scenarioResults;
  const showRight     = selectedNode || showSummary || showDynamic || showScenarios;

  return (
    <AppLayout>
      <div style={S.shell}>

        {/* Toolbar */}
        <div style={S.toolbar}>
          <button style={S.backBtn} onClick={() => navigate(`/projects/${projectId}`)}>← Back</button>
          <span style={S.title}>{flowsheet?.name || 'Loading…'}</span>

          {/* ── Mode toggle (segmented control) ────────────────── */}
          <div style={S.modeToggle}>
            <button
              style={mode === 'design' ? S.modeActive : S.modeInactive}
              onClick={switchToDesign}
            >
              Design
            </button>
            <button
              style={mode === 'run' ? S.modeActive : S.modeInactive}
              onClick={switchToRun}
            >
              Run
            </button>
          </div>

          <div style={S.tbRight}>
            {/* ── Collaboration presence ─────────────────────────── */}
            <PresenceAvatars presence={presence} self={collabSelf} />
            {simBanner && <SimBanner simBanner={simBanner} />}
            {!saved && <span style={S.unsaved}>● Unsaved</span>}

            {/* ── Run-mode buttons ────────────────────────────────── */}
            {mode === 'run' && (
              <>
                {hasAnyResults && (
                  <button style={{ ...S.btn, background: '#F3F4F6', color: '#374151' }} onClick={clearResults}>
                    Clear Results
                  </button>
                )}
                {simResults && (
                  <button style={{ ...S.btn, background: '#0891B2', color: '#fff' }} onClick={() => { setShowSummary(true); setShowDynamic(false); setShowScenarios(false); setShowLiveSim(false); setSelectedNode(null); }}>
                    Summary
                  </button>
                )}
                <button
                  style={{ ...S.btn, background: '#7C3AED', color: '#fff', opacity: dynamicRunning ? 0.7 : 1 }}
                  onClick={() => { setShowDynamic(true); setShowSummary(false); setShowScenarios(false); setShowLiveSim(false); setSelectedNode(null); }}
                  disabled={nodes.length === 0}
                >
                  Dynamic
                </button>
                <button
                  style={{ ...S.btn, background: '#059669', color: '#fff' }}
                  onClick={() => { setShowLiveSim(true); setShowDynamic(false); setShowSummary(false); setShowScenarios(false); setSelectedNode(null); }}
                  disabled={nodes.length === 0}
                >
                  Live Sim
                </button>
                <button
                  style={{ ...S.btn, background: '#0D9488', color: '#fff' }}
                  onClick={() => setShowTrend(true)}
                >
                  Trend
                </button>
                <button
                  style={{ ...S.btn, background: '#B45309', color: '#fff', opacity: scenariosRunning ? 0.7 : 1 }}
                  onClick={() => { setShowScenarios(true); setShowDynamic(false); setShowSummary(false); setShowLiveSim(false); setSelectedNode(null); }}
                  disabled={nodes.length === 0}
                >
                  Compare
                </button>
                {nodes.some(n => n.data?.opType === 'opc_read' || n.data?.opType === 'opc_write') && (
                  <>
                    <OpcToolbarBtn onClick={() => setShowOpcConnection(true)} />
                    <button
                      style={{ ...S.btn, background: '#7C3AED', color: '#fff' }}
                      onClick={() => setShowOpcTagTable(true)}
                    >
                      OPC Tags
                    </button>
                  </>
                )}
                <button
                  style={{ ...S.btn, background: '#16A34A', color: '#fff', opacity: simulating ? 0.7 : 1 }}
                  onClick={simulate}
                  disabled={simulating || nodes.length === 0}
                >
                  {simulating ? 'Running…' : 'Simulate'}
                </button>
              </>
            )}

            {/* ── Common buttons (both modes) ────────────────────── */}
            <button
              title="Edit cost coefficients for this project"
              style={{ ...S.btn, background: '#F3F4F6', color: '#374151', border: '1px solid #D1D5DB', fontSize: 14 }}
              onClick={() => navigate(`/projects/${projectId}/settings`)}
            >⚙</button>
            <button style={{ ...S.btn, background: '#1F4E79', color: '#fff', opacity: saving ? 0.7 : 1 }} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              title="Save a named snapshot of the current canvas"
              style={{ ...S.btn, background: '#0D9488', color: '#fff' }}
              onClick={() => { setSnapName(`${flowsheet?.name || 'Flowsheet'} — ${new Date().toLocaleDateString()}`); setShowSnapModal(true); }}
              disabled={nodes.length === 0}
            >
              Snapshot
            </button>
          </div>
        </div>

        {/* Error banner */}
        {simError && (
          <div style={S.errBanner}>
            ⚠️ {simError}
            <button style={S.dismissBtn} onClick={() => setSimError(null)}>✕</button>
          </div>
        )}

        <div style={S.body}>
          {mode === 'design' && <UnitOpPalette nodes={nodes} />}

          <div
            style={S.canvasWrap}
            onDrop={mode === 'design' ? onDrop : undefined}
            onDragOver={mode === 'design' ? onDragOver : undefined}
            onMouseMove={onMouseMoveCanvas}
          >
            {/* Remote collaborator cursors */}
            <RemoteCursors cursors={remoteCursors} />
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={mode === 'design' ? onNodesChangeWrapped : (changes) => onNodesChangeWrapped(changes.filter(c => c.type !== 'remove'))}
              onEdgesChange={mode === 'design' ? onEdgesChange : (changes) => onEdgesChange(changes.filter(c => c.type !== 'remove'))}
              onConnect={mode === 'design' ? onConnect : undefined}
              onNodeClick={onNodeClick}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={() => setSelectedNode(null)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              deleteKeyCode={mode === 'design' ? 'Delete' : null}
              nodesConnectable={mode === 'design'}
              fitView
            >
              <Background variant="dots" gap={20} size={1} color="#D1D5DB" />
              <PerfOverlay />
              <Controls />
              <MiniMap nodeColor={() => '#2E75B6'} maskColor="rgba(240,246,255,0.6)" />
              <Panel position="top-right">
                <div style={S.hint}>
                  {mode === 'design'
                    ? 'Drag unit ops · Connect nodes · Click to configure · Delete to remove'
                    : 'Click nodes to inspect · Simulate to run'}
                </div>
              </Panel>
            </ReactFlow>
          </div>

          {/* Right panel */}
          {showRight && (
            <aside style={S.rightPanel}>
              {selectedNode && (
                (selectedNode.data.opType === 'opc_read' || selectedNode.data.opType === 'opc_write')
                  ? <OpcNodeInfoPanel
                      node={selectedNode}
                      onOpenTagTable={() => { setShowOpcTagTable(true); setSelectedNode(null); }}
                      onOpenConnection={() => setShowOpcConnection(true)}
                      onClose={() => setSelectedNode(null)}
                    />
                  : <ParamPanel
                      key={selectedNode.id}
                      node={selectedNode}
                      unitResult={simResults?.results?.unitResults?.[selectedNode.id]}
                      onUpdateParam={updateParam}
                      onClose={() => setSelectedNode(null)}
                    />
              )}
              {showSummary && !selectedNode && summary && (
                <SummaryPanel
                  summary={summary}
                  costBreakdown={costBreakdown}
                  unitResults={simResults?.results?.unitResults}
                  warnings={warnings}
                  runId={simResults?.run_id}
                  projectId={projectId}
                  flowsheetId={flowsheetId}
                  onClose={() => setShowSummary(false)}
                />
              )}
              {showDynamic && !selectedNode && (
                <DynamicPanel
                  nodes={nodes}
                  running={dynamicRunning}
                  results={dynamicResults}
                  onRun={runDynamic}
                  onClose={() => setShowDynamic(false)}
                />
              )}
              {showScenarios && !selectedNode && (
                <ScenariosPanel
                  nodes={nodes}
                  running={scenariosRunning}
                  results={scenarioResults}
                  onRun={runBatch}
                  onClose={() => setShowScenarios(false)}
                />
              )}
            </aside>
          )}
        </div>
      </div>

      {/* Live Simulation Dashboard (full-screen overlay) */}
      {showLiveSim && (
        <LiveSimPanel
          sendEvent={sendEvent}
          buildNodeParams={buildNodeParams}
          canvasData={{ nodes, edges }}
          wsConnected={wsConnected}
          onClose={() => setShowLiveSim(false)}
        />
      )}

      {/* Quick Trend Overlay (read-only chart, no controls) */}
      {showTrend && (
        <TrendOverlay onClose={() => setShowTrend(false)} />
      )}

      {/* OPC Connection Dialog */}
      {showOpcConnection && (
        <OpcConnectionDialog onClose={() => setShowOpcConnection(false)} />
      )}

      {/* OPC Tag Table */}
      {showOpcTagTable && (
        <OpcTagTable
          nodes={nodes}
          edges={edges}
          simResults={simResults}
          onUpdateParam={updateParam}
          onClose={() => setShowOpcTagTable(false)}
        />
      )}

      {/* Snapshot toast */}
      {snapToast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: '#065F46', color: '#fff', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,.25)' }}>
          📸 {snapToast}
        </div>
      )}

      {/* Snapshot modal */}
      {showSnapModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>📸 Save Snapshot</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF' }} onClick={() => setShowSnapModal(false)}>&times;</button>
            </div>
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#065F46' }}>
              Saving: <strong>{flowsheet?.name}</strong> (v{flowsheet?.version ?? '?'})
            </div>
            <form onSubmit={takeSnapshot}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>
                Snapshot name *
              </label>
              <input
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
                value={snapName}
                onChange={e => setSnapName(e.target.value)}
                placeholder="e.g. Before SRT change, Design Review v1"
                required
                autoFocus
              />
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: -6, marginBottom: 14 }}>
                A read-only copy will be saved. You can restore it as a new flowsheet from the project page.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" style={{ padding: '8px 16px', background: '#F3F4F6', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                  onClick={() => setShowSnapModal(false)}>Cancel</button>
                <button type="submit"
                  style={{ padding: '8px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, opacity: snapping || !snapName.trim() ? 0.7 : 1 }}
                  disabled={snapping || !snapName.trim()}>
                  {snapping ? 'Saving…' : 'Save Snapshot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

// ── Param Panel ───────────────────────────────────────────────────────────────

const ParamPanel = React.memo(function ParamPanel({ node, unitResult, onUpdateParam, onClose }) {
  const defs = PARAM_DEFS[node.data.opType] || [];

  return (
    <div>
      <div style={S.panelHdr}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>{node.data.label}</div>
          <div style={{ fontSize: 11, color: '#9CA3AF' }}>{node.data.opType}</div>
        </div>
        <button style={S.closeBtn} onClick={onClose}>✕</button>
      </div>

      <div style={S.panelSection}>
        <div style={S.secTitle}>Parameters</div>
        {defs.length === 0 && <p style={S.noParams}>No configurable parameters.</p>}
        {defs.map(def => (
          <ParamRow
            key={def.key}
            def={def}
            value={node.data.params?.[def.key]}
            onChange={v => onUpdateParam(node.id, def.key, v)}
          />
        ))}
      </div>

      {unitResult && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Simulation Output</div>
          {Object.entries(unitResult.metrics).map(([k, v]) => {
            if (Array.isArray(v) || v === null || v === undefined) return null;
            return (
              <div key={k} style={S.metricRow}>
                <span style={S.metricKey}>{k.replace(/_/g,' ')}</span>
                <span style={S.metricVal}>
                  {typeof v === 'boolean' ? (v ? '✓ Yes' : '✗ No') : String(v)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ── Summary Panel ─────────────────────────────────────────────────────────────

const SummaryPanel = React.memo(function SummaryPanel({ summary, costBreakdown, unitResults, warnings, runId, projectId, flowsheetId, onClose }) {
  const c = summary.compliant;
  const [showCost, setShowCost] = React.useState(false);

  const exportURL = (format) =>
    `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/export/${format}`;

  const fmt = (n, dp = 0) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: dp }) : '—');

  return (
    <div>
      <div style={S.panelHdr}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>Simulation Results</div>
        <button style={S.closeBtn} onClick={onClose}>✕</button>
      </div>

      <div style={{ padding: '12px 16px' }}>
        <div style={{
          padding: '8px 12px', borderRadius: 8, border: '1px solid', fontWeight: 700, fontSize: 13, textAlign: 'center',
          background: c == null ? '#F3F4F6' : c ? '#D1FAE5' : '#FEE2E2',
          color:       c == null ? '#6B7280' : c ? '#065F46' : '#991B1B',
          borderColor: c == null ? '#D1D5DB' : c ? '#6EE7B7' : '#FCA5A5',
        }}>
          {c == null ? '— No outlet node' : c ? '✓ Permit Compliant' : `⚠ ${summary.permit_violations?.length} Violations`}
        </div>
      </div>

      {(summary.permit_violations || []).length > 0 && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Permit Violations</div>
          {summary.permit_violations.map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, fontSize: 12, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, color: '#DC2626', minWidth: 36 }}>{v.param}</span>
              <span style={{ color: '#111' }}>{typeof v.value === 'number' ? v.value.toFixed(1) : v.value} {v.unit}</span>
              <span style={{ color: '#9CA3AF', marginLeft: 'auto' }}>limit: {v.limit}</span>
            </div>
          ))}
        </div>
      )}

      {summary.influent && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Influent</div>
          <StreamTable stream={summary.influent} />
        </div>
      )}

      {summary.effluent && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Final Effluent</div>
          <StreamTable stream={summary.effluent} />
        </div>
      )}

      {/* ── Cost Estimation Overlay ─────────────────────────────────────── */}
      {costBreakdown && (
        <div style={S.panelSection}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={S.secTitle}>💰 Cost Estimate</div>
            <button
              onClick={() => setShowCost(v => !v)}
              style={{ fontSize: 11, color: '#3B82F6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {showCost ? 'Hide detail' : 'Show detail'}
            </button>
          </div>
          {/* Headline numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
            <div style={{ background: '#EFF6FF', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 2 }}>Total Annual Cost</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1E40AF' }}>
                ${fmt(costBreakdown.total_USD_yr)} /yr
              </div>
            </div>
            <div style={{ background: '#F0FDF4', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 2 }}>Cost per m³ Treated</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#166534' }}>
                ${fmt(costBreakdown.cost_per_m3_treated_USD, 3)} /m³
              </div>
            </div>
          </div>
          {/* Category breakdown */}
          {showCost && (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: '#6B7280' }}>
                  <th style={{ textAlign: 'left', paddingBottom: 4, fontWeight: 600 }}>Category</th>
                  <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 600 }}>USD/yr</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['⚡ Energy',         costBreakdown.energy?.cost_USD_yr,      '#FEF9C3'],
                  ['🧪 Chemicals',      costBreakdown.chemicals?.total_USD_yr,  '#EDE9FE'],
                  ['🏭 Sludge Disposal',costBreakdown.sludge?.cost_USD_yr,      '#FEE2E2'],
                  ['👷 Labour',         costBreakdown.labour?.cost_USD_yr,      '#D1FAE5'],
                  ['🔧 Maintenance',    costBreakdown.maintenance?.cost_USD_yr, '#E0F2FE'],
                ].map(([label, val, bg]) => (
                  <tr key={label} style={{ background: bg }}>
                    <td style={{ padding: '4px 6px', borderRadius: '4px 0 0 4px' }}>{label}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      ${fmt(val)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {showCost && costBreakdown.energy && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#6B7280' }}>
              Energy: {fmt(costBreakdown.energy.total_kWh_yr)} kWh/yr
              · Staff: {costBreakdown.labour?.staff_count}
            </div>
          )}
        </div>
      )}

      {/* ── Tertiary & Digester Unit Results ─────────────────────────── */}
      {unitResults && (() => {
        const UV     = Object.entries(unitResults).find(([,v]) => v.paletteType === 'uv_disinfection');
        const FILT   = Object.entries(unitResults).find(([,v]) => ['sand_filter','granular_filter'].includes(v.paletteType));
        const DIGEST = Object.entries(unitResults).find(([,v]) => v.paletteType === 'anaerobic_digester');
        // Session 9 — EBPR: find any aeration node with UCT or JHB config
        const EBPR   = Object.entries(unitResults).find(([,v]) =>
          ['uct','jhb'].includes(v.metrics?.config) ||
          ['uct','jhb'].includes(v.metrics?.ebpr?.config)
        );
        if (!UV && !FILT && !DIGEST && !EBPR) return null;
        const fmt2 = (n, dp=1) => n != null ? Number(n).toFixed(dp) : '—';
        return (
          <>
            {UV && (() => { const m = UV[1].metrics; return (
              <div style={S.panelSection}>
                <div style={S.secTitle}>☀ UV Disinfection</div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    {[
                      ['Fluence delivered', `${fmt2(m.fluence_mJ_cm2)} mJ/cm²`],
                      ['Required fluence',  `${fmt2(m.required_fluence_mJ_cm2)} mJ/cm²`],
                      ['Log reduction',     `${fmt2(m.log_reduction, 2)} log`],
                      ['UVT',               `${m.UVT_pct} %`],
                      ['Lamps',             m.lamp_count],
                      ['Energy',            `${fmt2(m.energy_kWh_d)} kWh/d`],
                      ['Compliant',         m.compliant ? '✓ Yes' : '⚠ Deficit: ' + fmt2(m.log_deficit,2) + ' log'],
                    ].map(([l, v]) => (
                      <tr key={l}>
                        <td style={{ color: '#6B7280', padding: '2px 0', paddingRight: 8 }}>{l}</td>
                        <td style={{ fontWeight: 600, color: m.compliant === false && l === 'Compliant' ? '#DC2626' : '#111' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ); })()}
            {FILT && (() => { const m = FILT[1].metrics; return (
              <div style={S.panelSection}>
                <div style={S.secTitle}>🟫 Granular Filter</div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    {[
                      ['Type',            m.filter_type],
                      ['Area',            `${fmt2(m.area_m2)} m²`],
                      ['HLR',             `${m.HLR_m_h} m/h`],
                      ['Bed depth',       `${fmt2(m.total_bed_depth_m)} m`],
                      ['Head loss (clean)',`${fmt2(m.h_clean_bed_m, 3)} m`],
                      ['Head loss (loaded)',`${fmt2(m.h_clogged_m, 3)} m`],
                      ['TSS removal',     `${fmt2(m.effective_TSS_removal_pct)} %`],
                      ['Backwash needed', m.backwash_needed ? '⚠ Yes' : '✓ No'],
                    ].map(([l, v]) => (
                      <tr key={l}>
                        <td style={{ color: '#6B7280', padding: '2px 0', paddingRight: 8 }}>{l}</td>
                        <td style={{ fontWeight: 600, color: m.backwash_needed && l === 'Backwash needed' ? '#D97706' : '#111' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ); })()}
            {DIGEST && (() => { const m = DIGEST[1].metrics; const bg = DIGEST[1].biogas; return (
              <div style={S.panelSection}>
                <div style={S.secTitle}>⚗ Anaerobic Digester</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                  <div style={{ background: '#FAF5FF', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: '#6B7280' }}>VS Destruction</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#7C3AED' }}>{fmt2(m.VS_destruction_pct)} %</div>
                  </div>
                  {bg && (
                    <div style={{ background: '#FFFBEB', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>Biogas Energy</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#D97706' }}>{fmt2(bg.energy_kWh_d)} kWh/d</div>
                    </div>
                  )}
                </div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    {[
                      ['HRT',             `${m.HRT_d} days`],
                      ['Temperature',     `${m.temp_C} °C`],
                      ['COD destruction', `${fmt2(m.COD_destruction_pct)} %`],
                      ['NH₄ in centrate', m.NH4_out_mg_L > 500 ? `${fmt2(m.NH4_out_mg_L)} mg/L ⚠` : `${fmt2(m.NH4_out_mg_L)} mg/L`],
                      bg ? ['CH₄ yield',   `${fmt2(bg.CH4_m3_d)} m³/d (${fmt2(bg.CH4_pct)} %)`] : null,
                      bg ? ['Biogas total',`${fmt2(bg.volume_m3_d)} m³/d`] : null,
                      bg ? ['MWh/yr',      `${fmt2(bg.energy_MWh_yr, 0)}`] : null,
                    ].filter(Boolean).map(([l, v]) => (
                      <tr key={l}>
                        <td style={{ color: '#6B7280', padding: '2px 0', paddingRight: 8 }}>{l}</td>
                        <td style={{ fontWeight: 600, color: m.centrate_NH4_concern && l === 'NH₄ in centrate' ? '#DC2626' : '#111' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {m.warnings?.length > 0 && m.warnings.map((w,i) => (
                  <div key={i} style={{ fontSize: 11, color: '#92400E', background: '#FFFBEB', borderRadius: 4, padding: '3px 7px', marginTop: 4 }}>{w}</div>
                ))}
              </div>
            ); })()}
            {/* ── Session 9 — Step 40: Advanced EBPR (UCT/JHB) detail card ── */}
            {EBPR && (() => {
              const m  = EBPR[1].metrics;
              const em = m.ebpr || {};
              const config = em.config || m.config;
              const isJHB  = config === 'jhb';
              const zv     = m.zone_volumes_m3 || {};
              const zh     = m.zone_HRT_h || {};
              const titleIcon = isJHB ? '🔀' : '🔄';
              const title = isJHB ? 'JHB Biological Nutrient Removal' : 'UCT Biological Nutrient Removal';
              const fmt2 = (n, dp=1) => n != null ? Number(n).toFixed(dp) : '—';
              return (
                <div style={S.panelSection}>
                  <div style={S.secTitle}>{titleIcon} {title}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                    <div style={{ background: '#EFF6FF', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>TP Effluent</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: Number(em.TP_effluent_mg_L) <= 1 ? '#166534' : '#1E40AF' }}>
                        {fmt2(em.TP_effluent_mg_L)} mg/L
                      </div>
                    </div>
                    <div style={{ background: '#F0FDF4', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>P Removed</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#166534' }}>
                        {fmt2(em.P_removal_mg_L)} mg/L
                      </div>
                    </div>
                  </div>
                  {em.NO3_suppression_warning && (
                    <div style={{ fontSize: 11, color: '#92400E', background: '#FFFBEB', borderRadius: 4, padding: '4px 8px', marginBottom: 6 }}>
                      ⚠ NO₃ entering anaerobic zone ({fmt2(em.NO3_in_anaerobic_mg_L)} mg/L) — PAO activity at {fmt2(em.NO3_suppression_factor*100,0)}% effectiveness. Consider ↑ MLR ratio or ↑ SRT.
                    </div>
                  )}
                  {em.mlr_denitrification_ok === false && (
                    <div style={{ fontSize: 11, color: '#92400E', background: '#FFF7ED', borderRadius: 4, padding: '4px 8px', marginBottom: 6 }}>
                      ⚠ MLR NO₃ load may exceed anoxic denitrification capacity — consider ↓ MLR ratio or ↑ anoxic zone fraction.
                    </div>
                  )}
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginBottom: 8 }}>
                    <tbody>
                      {[
                        ['Config',              config?.toUpperCase()],
                        ['MLR ratio',           `${em.MLR_ratio}× Qin (${fmt2(em.MLR_flow_m3_d, 0)} m³/d)`],
                        ['VFA consumed',        `${fmt2(em.VFA_consumed_mg_L)} mg/L`],
                        ['P released (anaer.)', `${fmt2(em.P_released_mg_L)} mg/L`],
                        ['NO₃ → anaerobic',     `${fmt2(em.NO3_in_anaerobic_mg_L)} mg/L`],
                        isJHB ? ['NO₃ after pre-anox', `${fmt2(em.NO3_after_preanox_mg_L)} mg/L`] : null,
                        ['N removed total',     `${fmt2(em.N_removed_total_mg_L)} mg/L`],
                        ['PAO fraction',        `${((em.PAO_fraction||0)*100).toFixed(0)}% of MLVSS`],
                      ].filter(Boolean).map(([l, v]) => (
                        <tr key={l}>
                          <td style={{ color: '#6B7280', padding: '2px 0', paddingRight: 8 }}>{l}</td>
                          <td style={{ fontWeight: 600, color: '#111' }}>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {Object.keys(zv).length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Zone Sizing</div>
                      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ color: '#9CA3AF' }}>
                            <th style={{ textAlign: 'left', paddingBottom: 2 }}>Zone</th>
                            <th style={{ textAlign: 'right', paddingBottom: 2 }}>Vol (m³)</th>
                            <th style={{ textAlign: 'right', paddingBottom: 2 }}>HRT (h)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(zv).map(([zone, vol]) => {
                            const color = zone.includes('anaerobic') ? '#7C3AED'
                                        : zone.includes('anoxic')    ? '#1D4ED8'
                                        : zone.includes('aerobic')   ? '#059669'
                                        : '#374151';
                            return (
                              <tr key={zone} style={{ borderTop: '1px solid #F3F4F6' }}>
                                <td style={{ padding: '3px 0', color, fontWeight: 600, textTransform: 'capitalize' }}>
                                  {zone.replace(/_/g,' ')}
                                </td>
                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(vol).toLocaleString()}</td>
                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{zh[zone] || '—'}</td>
                              </tr>
                            );
                          })}
                          <tr style={{ borderTop: '2px solid #E5E7EB', fontWeight: 700 }}>
                            <td style={{ padding: '3px 0' }}>Total</td>
                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                              {Object.values(zv).reduce((a,b) => a + Number(b), 0).toLocaleString()}
                            </td>
                            <td style={{ textAlign: 'right', color: '#6B7280' }}>{fmt2(m.HRT_h)} h</td>
                          </tr>
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              );
            })()}
          </>
        );
      })()}

      {warnings.length > 0 && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Warnings ({warnings.length})</div>
          {warnings.map((w,i) => (
            <div key={i} style={{ fontSize: 11, color: '#92400E', background: '#FFFBEB', borderRadius: 4, padding: '3px 7px', marginBottom: 4 }}>{w}</div>
          ))}
        </div>
      )}

      {/* Export buttons */}
      {runId && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid #F3F4F6' }}>
          <div style={S.secTitle}>Export</div>
          {/* View Report button — links to full ReportPage */}
          <a
            href={`/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/report`}
            style={{
              display: 'block', width: '100%', textAlign: 'center',
              padding: '7px 12px', marginBottom: 8, borderRadius: 6,
              background: '#1E3A8A', color: '#fff', fontSize: 12,
              fontWeight: 700, textDecoration: 'none', letterSpacing: '0.02em',
            }}
          >
            📊 View Full Report & Export PDF
          </a>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href={exportURL('csv')} download style={S.exportBtn}>
              📄 CSV
            </a>
            <a href={exportURL('json')} download style={{ ...S.exportBtn, background: '#EEF2FF', color: '#3730A3', borderColor: '#C7D2FE' }}>
              {} JSON
            </a>
          </div>
        </div>
      )}

      <div style={{ padding: '8px 16px', fontSize: 11, color: '#9CA3AF' }}>
        {summary.solvedNodes} nodes · {summary.edgeCount} streams
        {summary.recycleEdges > 0 && ` · ${summary.recycleEdges} recycle(s), ${summary.iterations} iter.`}
      </div>
    </div>
  );
});

// ── Dynamic Panel ──────────────────────────────────────────────────────────────

const FLAT_PROFILE = Array.from({ length: 24 }, (_, h) => ({
  hour: h, Q_scale: 1, BOD_scale: 1, TN_scale: 1, TP_scale: 1, TSS_scale: 1,
}));

const DEFAULT_PROFILE = Array.from({ length: 24 }, (_, h) => ({
  hour: h,
  Q_scale:   [0.60,0.55,0.52,0.50,0.52,0.58,0.80,1.10,1.30,1.40,1.45,1.50,1.45,1.35,1.25,1.20,1.20,1.25,1.30,1.25,1.10,0.95,0.80,0.68][h],
  BOD_scale: [0.55,0.50,0.48,0.46,0.48,0.55,0.80,1.10,1.30,1.40,1.45,1.50,1.45,1.35,1.25,1.20,1.20,1.25,1.30,1.25,1.10,0.95,0.80,0.65][h],
  TN_scale:  [0.60,0.55,0.52,0.50,0.52,0.58,0.80,1.10,1.30,1.35,1.40,1.45,1.40,1.30,1.20,1.15,1.15,1.20,1.25,1.20,1.05,0.90,0.75,0.65][h],
}));

function DynamicPanel({ running, results, onRun, onClose }) {
  const [profile, setProfile] = useState(DEFAULT_PROFILE.map(p => ({ ...p })));
  const [hours, setHours]     = useState(24);
  const [constantInlet, setConstantInlet] = useState(false);
  const [activeChart, setActiveChart] = useState('Q');

  const updateScale = (hour, key, val) => {
    setProfile(p => p.map((r, i) => i === hour ? { ...r, [key]: val } : r));
  };

  const handleRun = () => {
    onRun({ profile: constantInlet ? FLAT_PROFILE : profile, hoursToSimulate: hours });
  };

  const chartData = results?.results?.steps?.map(s => ({
    hour: `${s.hour}h`,
    'Inf Q': s.summary?.influent?.Q ?? null,
    'Eff Q': s.summary?.effluent?.Q ?? null,
    'Eff BOD': s.summary?.effluent?.BOD ?? null,
    'Eff TN': s.summary?.effluent?.TN ?? null,
    'Eff NH₄': s.summary?.effluent?.NH4 ?? null,
    'Eff NO₃': s.summary?.effluent?.NO3 ?? null,
  })) || [];

  const CHART_LINES = {
    Q:   [{ key: 'Inf Q', color: '#2563EB' }, { key: 'Eff Q', color: '#7C3AED' }],
    BOD: [{ key: 'Eff BOD', color: '#D97706' }],
    N:   [{ key: 'Eff TN', color: '#059669' }, { key: 'Eff NH₄', color: '#DC2626' }, { key: 'Eff NO₃', color: '#7C3AED' }],
  };

  return (
    <div>
      <div style={S.panelHdr}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>📈 Dynamic Simulation</div>
        <button style={S.closeBtn} onClick={onClose}>✕</button>
      </div>

      {/* Config */}
      <div style={S.panelSection}>
        <div style={S.secTitle}>Configuration</div>
        <div style={S.paramRow}>
          <label style={S.paramLabel}>Hours to simulate</label>
          <input type="number" style={S.paramInput} min={1} max={48} step={1}
            value={hours} onChange={e => setHours(Number(e.target.value))} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer', marginTop: 6 }}>
          <input type="checkbox" checked={constantInlet} onChange={e => setConstantInlet(e.target.checked)} />
          Constant Inlet (disable diurnal variation)
        </label>
        <button
          style={{ ...S.btn, background: '#7C3AED', color: '#fff', width: '100%', marginTop: 8, opacity: running ? 0.7 : 1 }}
          onClick={handleRun}
          disabled={running}
        >
          {running ? '⏳ Running Dynamic…' : '▶ Run Dynamic Simulation'}
        </button>
      </div>

      {/* Diurnal profile editor */}
      {!constantInlet && <div style={{ ...S.panelSection, padding: '10px 0' }}>
        <div style={{ ...S.secTitle, padding: '0 16px' }}>24-Hour Loading Profile</div>
        <div style={{ overflowX: 'auto', padding: '0 8px' }}>
          <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ background: '#F9FAFB' }}>
                <th style={S.thCell}>Hr</th>
                <th style={S.thCell}>Q×</th>
                <th style={S.thCell}>BOD×</th>
                <th style={S.thCell}>TN×</th>
              </tr>
            </thead>
            <tbody>
              {profile.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #F3F4F6' }}>
                  <td style={{ ...S.tdCell, color: '#6B7280', fontWeight: 600 }}>{row.hour}</td>
                  {['Q_scale','BOD_scale','TN_scale'].map(k => (
                    <td key={k} style={S.tdCell}>
                      <input
                        type="number" step={0.05} min={0.1} max={3}
                        style={{ width: 46, padding: '1px 3px', border: '1px solid #E5E7EB', borderRadius: 3, fontSize: 11, textAlign: 'right' }}
                        value={row[k]}
                        onChange={e => updateScale(i, k, parseFloat(e.target.value) || row[k])}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}

      {/* Results charts */}
      {results && chartData.length > 0 && (
        <div style={S.panelSection}>
          <div style={S.secTitle}>Results — {results?.results?.stepCount || chartData.length} steps</div>

          {/* Chart selector */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {[['Q','Flow'],['BOD','BOD'],['N','Nitrogen']].map(([k,label]) => (
              <button
                key={k}
                style={{ ...S.btn, padding: '3px 8px', fontSize: 11,
                  background: activeChart === k ? '#7C3AED' : '#F3F4F6',
                  color: activeChart === k ? '#fff' : '#374151' }}
                onClick={() => setActiveChart(k)}
              >
                {label}
              </button>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
              <XAxis dataKey="hour" tick={{ fontSize: 9 }} interval={3} />
              <YAxis tick={{ fontSize: 9 }} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
              {CHART_LINES[activeChart].map(l => (
                <Line key={l.key} type="monotone" dataKey={l.key}
                  stroke={l.color} dot={false} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {/* Peak/min summary */}
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280' }}>
              <span>Peak Eff BOD:</span>
              <span style={{ fontWeight: 700, color: '#D97706' }}>
                {Math.max(...chartData.map(d => d['Eff BOD'] ?? 0)).toFixed(1)} mg/L
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', marginTop: 3 }}>
              <span>Peak Eff TN:</span>
              <span style={{ fontWeight: 700, color: '#059669' }}>
                {Math.max(...chartData.map(d => d['Eff TN'] ?? 0)).toFixed(1)} mg/L
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', marginTop: 3 }}>
              <span>Peak/Avg Q ratio:</span>
              <span style={{ fontWeight: 700, color: '#2563EB' }}>
                {(() => {
                  const qs = chartData.map(d => d['Inf Q'] ?? 0).filter(v => v > 0);
                  if (!qs.length) return '—';
                  return (Math.max(...qs) / (qs.reduce((a, b) => a + b, 0) / qs.length)).toFixed(2);
                })()}×
              </span>
            </div>
          </div>
        </div>
      )}

      {results?.warnings?.length > 0 && (
        <div style={{ padding: '8px 16px', fontSize: 11, color: '#92400E' }}>
          {results.warnings[0]}
        </div>
      )}
    </div>
  );
}

// ── Scenarios Panel ────────────────────────────────────────────────────────────

const DEFAULT_SCENARIOS = [
  { name: 'Baseline',    nodeParams: {} },
  { name: 'High Load',   nodeParams: {} },
  { name: 'Low SRT',     nodeParams: {} },
];

function ScenariosPanel({ nodes, running, results, onRun, onClose }) {
  const [scenarios, setScenarios] = useState(DEFAULT_SCENARIOS.map(s => ({ ...s })));
  const [activeScenario, setActiveScenario] = useState(0);
  const [compareParam, setCompareParam] = useState('BOD');

  // Inlet nodes for per-scenario overrides
  const inletNodes = nodes.filter(n => n.data?.opType === 'inlet');
  const asNodes    = nodes.filter(n => ['activated_sludge','membrane_bioreactor','uct_reactor','jhb_reactor'].includes(n.data?.opType));

  const addScenario = () => {
    if (scenarios.length >= 6) return;
    setScenarios(s => [...s, { name: `Scenario ${s.length + 1}`, nodeParams: {} }]);
  };

  const removeScenario = (i) => {
    if (scenarios.length <= 1) return;
    setScenarios(s => s.filter((_, idx) => idx !== i));
    if (activeScenario >= i) setActiveScenario(Math.max(0, activeScenario - 1));
  };

  const updateScenarioName = (i, name) => {
    setScenarios(s => s.map((sc, idx) => idx === i ? { ...sc, name } : sc));
  };

  const updateScenarioParam = (i, nodeId, key, value) => {
    setScenarios(s => s.map((sc, idx) => {
      if (idx !== i) return sc;
      const np = { ...sc.nodeParams, [nodeId]: { ...(sc.nodeParams[nodeId] || {}), [key]: value } };
      return { ...sc, nodeParams: np };
    }));
  };

  const handleRun = () => {
    onRun(scenarios.map(s => ({ name: s.name, nodeParams: s.nodeParams })));
  };

  // Build chart data from scenario results
  const COMPARE_PARAMS = {
    BOD:        { label: 'Eff BOD (mg/L)',    getter: s => s?.summary?.effluent?.BOD ?? 0, color: '#2563EB' },
    TN:         { label: 'Eff TN (mg/L)',     getter: s => s?.summary?.effluent?.TN  ?? 0, color: '#2563EB' },
    NH4:        { label: 'Eff NH₄ (mg/L)',    getter: s => s?.summary?.effluent?.NH4 ?? 0, color: '#2563EB' },
    NO3:        { label: 'Eff NO₃ (mg/L)',    getter: s => s?.summary?.effluent?.NO3 ?? 0, color: '#2563EB' },
    TP:         { label: 'Eff TP (mg/L)',     getter: s => s?.summary?.effluent?.TP  ?? 0, color: '#2563EB' },
    cost_yr:    { label: 'Annual Cost ($k/yr)', getter: s => (s?.costBreakdown?.total_USD_yr ?? 0) / 1000, color: '#D97706', isCost: true, fmt: v => `$${v.toFixed(0)}k` },
    cost_m3:    { label: 'Cost per m³ ($)',   getter: s => s?.costBreakdown?.cost_per_m3_treated_USD ?? 0, color: '#7C3AED', isCost: true, fmt: v => `$${v.toFixed(3)}` },
    energy_kwh: { label: 'Energy (MWh/yr)',   getter: s => (s?.costBreakdown?.energy?.total_kWh_yr ?? 0) / 1000, color: '#059669', isCost: true, fmt: v => `${v.toFixed(0)} MWh` },
  };

  const barData = results?.scenarios
    ?.filter(s => s.status === 'completed')
    .map(s => ({
      name:  s.name,
      value: +(COMPARE_PARAMS[compareParam]?.getter(s.results) ?? 0).toFixed(3),
    })) || [];

  const activeCp = COMPARE_PARAMS[compareParam];

  // Comparison table columns
  const tableParams = ['BOD','TN','NH4','NO3','TP','TSS'];

  return (
    <div>
      <div style={S.panelHdr}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>⚖ Scenario Comparison</div>
        <button style={S.closeBtn} onClick={onClose}>✕</button>
      </div>

      {/* Scenario list */}
      <div style={S.panelSection}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={S.secTitle}>Scenarios ({scenarios.length})</div>
          {scenarios.length < 6 && (
            <button onClick={addScenario} style={{ ...S.btn, padding: '2px 8px', fontSize: 11, background: '#F0FDF4', color: '#16A34A', border: '1px solid #BBF7D0' }}>
              + Add
            </button>
          )}
        </div>
        {scenarios.map((sc, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5,
            background: activeScenario === i ? '#EFF6FF' : 'transparent',
            borderRadius: 5, padding: '3px 4px', cursor: 'pointer',
          }}
            onClick={() => setActiveScenario(i)}
          >
            <div style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
              background: ['#2563EB','#D97706','#059669','#DC2626','#7C3AED','#0891B2'][i % 6] }} />
            <input
              style={{ flex: 1, border: '1px solid #E5E7EB', borderRadius: 4, padding: '2px 5px', fontSize: 12 }}
              value={sc.name}
              onChange={e => updateScenarioName(i, e.target.value)}
              onClick={e => e.stopPropagation()}
            />
            {scenarios.length > 1 && (
              <button onClick={e => { e.stopPropagation(); removeScenario(i); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 14 }}>×</button>
            )}
          </div>
        ))}
      </div>

      {/* Active scenario param overrides */}
      <div style={S.panelSection}>
        <div style={S.secTitle}>Params — {scenarios[activeScenario]?.name}</div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 6 }}>
          Override inlet / process params for this scenario (empty = use canvas defaults)
        </div>

        {inletNodes.map(n => (
          <div key={n.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 3 }}>
              Inlet: {n.data.label}
            </div>
            {[['Q','Flow (m³/d)',100],['BOD','BOD (mg/L)',5],['TN','TN (mg/L)',1]].map(([k,lbl,step]) => (
              <div key={k} style={S.paramRow}>
                <label style={{ ...S.paramLabel, fontSize: 11 }}>{lbl}</label>
                <input
                  type="number" step={step} style={{ ...S.paramInput, width: 70, fontSize: 11 }}
                  value={scenarios[activeScenario]?.nodeParams?.[n.id]?.[k] ?? ''}
                  placeholder="default"
                  onChange={e => updateScenarioParam(activeScenario, n.id, k, e.target.value === '' ? undefined : Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        ))}

        {asNodes.map(n => (
          <div key={n.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 3 }}>
              Bioreactor: {n.data.label}
            </div>
            {[['SRT_d','SRT (days)',1],['MLSS_mg_L','MLSS (mg/L)',100]].map(([k,lbl,step]) => (
              <div key={k} style={S.paramRow}>
                <label style={{ ...S.paramLabel, fontSize: 11 }}>{lbl}</label>
                <input
                  type="number" step={step} style={{ ...S.paramInput, width: 70, fontSize: 11 }}
                  value={scenarios[activeScenario]?.nodeParams?.[n.id]?.[k] ?? ''}
                  placeholder="default"
                  onChange={e => updateScenarioParam(activeScenario, n.id, k, e.target.value === '' ? undefined : Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        ))}

        <button
          style={{ ...S.btn, background: '#B45309', color: '#fff', width: '100%', marginTop: 8, opacity: running ? 0.7 : 1 }}
          onClick={handleRun}
          disabled={running}
        >
          {running ? '⏳ Running…' : `▶ Run ${scenarios.length} Scenario${scenarios.length > 1 ? 's' : ''}`}
        </button>
      </div>

      {/* Results */}
      {results && (
        <>
          {/* Parameter selector */}
          <div style={{ ...S.panelSection, paddingBottom: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={S.secTitle}>Comparison Chart</div>
              <select
                style={{ fontSize: 11, border: '1px solid #E5E7EB', borderRadius: 4, padding: '2px 5px' }}
                value={compareParam}
                onChange={e => setCompareParam(e.target.value)}
              >
                <optgroup label="Effluent Quality">
                  {['BOD','TN','NH4','NO3','TP'].map(k => (
                    <option key={k} value={k}>{COMPARE_PARAMS[k].label}</option>
                  ))}
                </optgroup>
                <optgroup label="Cost &amp; Energy">
                  {['cost_yr','cost_m3','energy_kwh'].map(k => (
                    <option key={k} value={k}>{COMPARE_PARAMS[k].label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={barData} margin={{ top: 16, right: 8, left: -20, bottom: 22 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} angle={-20} textAnchor="end" />
                <YAxis tick={{ fontSize: 9 }} />
                <Tooltip
                  contentStyle={{ fontSize: 11 }}
                  formatter={(v) => [activeCp?.fmt ? activeCp.fmt(v) : v.toFixed(2), activeCp?.label]}
                />
                <Bar dataKey="value" fill={activeCp?.color ?? '#2563EB'}
                  label={{ position: 'top', fontSize: 9,
                    formatter: v => activeCp?.fmt ? activeCp.fmt(v) : v.toFixed(1) }}
                />
              </BarChart>
            </ResponsiveContainer>
            {activeCp?.isCost && (
              <p style={{ fontSize: 10, color: '#9CA3AF', margin: '4px 0 0', textAlign: 'center' }}>
                ⚠ Cost estimates are parametric — review unit costs in simulation settings
              </p>
            )}
          </div>

          {/* Comparison table */}
          <div style={{ ...S.panelSection, padding: '10px 0' }}>
            <div style={{ ...S.secTitle, padding: '0 16px', marginBottom: 6 }}>Effluent Quality Table</div>
            <div style={{ overflowX: 'auto', padding: '0 4px' }}>
              <table style={{ fontSize: 10, borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr style={{ background: '#F9FAFB' }}>
                    <th style={{ ...S.thCell, textAlign: 'left' }}>Scenario</th>
                    {tableParams.map(p => <th key={p} style={S.thCell}>{p}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {results.scenarios.map((sc, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #F3F4F6',
                      background: i % 2 === 0 ? '#fff' : '#F9FAFB' }}>
                      <td style={{ padding: '3px 6px', fontWeight: 600, color: '#374151',
                        borderLeft: `3px solid ${['#2563EB','#D97706','#059669','#DC2626','#7C3AED','#0891B2'][i % 6]}` }}>
                        {sc.name}
                        {sc.status === 'failed' && <span style={{ color: '#DC2626' }}> ⚠</span>}
                      </td>
                      {tableParams.map(p => (
                        <td key={p} style={{ padding: '3px 5px', textAlign: 'right', color: '#111' }}>
                          {sc.results?.summary?.effluent?.[p] != null
                            ? (+sc.results.summary.effluent[p]).toFixed(1)
                            : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Permit compliance per scenario */}
          <div style={{ ...S.panelSection }}>
            <div style={S.secTitle}>Permit Status</div>
            {results.scenarios.map((sc, i) => {
              const c = sc.results?.summary?.compliant;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%',
                    background: ['#2563EB','#D97706','#059669','#DC2626','#7C3AED','#0891B2'][i % 6] }} />
                  <span style={{ flex: 1, color: '#374151' }}>{sc.name}</span>
                  <span style={{ fontWeight: 700,
                    color: c == null ? '#6B7280' : c ? '#065F46' : '#991B1B' }}>
                    {c == null ? '—' : c ? '✓ OK' : '⚠ Fail'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Cost comparison table */}
          {results.scenarios.some(s => s.results?.costBreakdown) && (
            <div style={{ ...S.panelSection, padding: '10px 0' }}>
              <div style={{ ...S.secTitle, padding: '0 16px', marginBottom: 6 }}>💰 Cost Comparison</div>
              <div style={{ overflowX: 'auto', padding: '0 4px' }}>
                <table style={{ fontSize: 10, borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr style={{ background: '#FEF9C3' }}>
                      <th style={{ ...S.thCell, textAlign: 'left' }}>Scenario</th>
                      <th style={S.thCell}>$/yr</th>
                      <th style={S.thCell}>$/m³</th>
                      <th style={S.thCell}>Energy</th>
                      <th style={S.thCell}>Chemicals</th>
                      <th style={S.thCell}>Sludge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.scenarios.map((sc, i) => {
                      const cb = sc.results?.costBreakdown;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #F3F4F6',
                          background: i % 2 === 0 ? '#fff' : '#FEFCE8' }}>
                          <td style={{ padding: '3px 6px', fontWeight: 600, color: '#374151', fontSize: 10,
                            borderLeft: `3px solid ${['#2563EB','#D97706','#059669','#DC2626','#7C3AED','#0891B2'][i % 6]}` }}>
                            {sc.name}
                          </td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#92400E', fontWeight: 600 }}>
                            {cb ? `$${(cb.total_USD_yr/1000).toFixed(0)}k` : '—'}
                          </td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#111' }}>
                            {cb ? `$${cb.cost_per_m3_treated_USD.toFixed(3)}` : '—'}
                          </td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#111' }}>
                            {cb?.energy ? `$${(cb.energy.cost_USD_yr/1000).toFixed(0)}k` : '—'}
                          </td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#111' }}>
                            {cb?.chemicals ? `$${(cb.chemicals.total_USD_yr/1000).toFixed(0)}k` : '—'}
                          </td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#111' }}>
                            {cb?.sludge ? `$${(cb.sludge.cost_USD_yr/1000).toFixed(0)}k` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 9, color: '#9CA3AF', padding: '4px 8px 0', fontStyle: 'italic' }}>
                All figures USD/yr. Costs are parametric OPEX estimates only.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ParamRow({ def, value, onChange }) {
  if (def.type === 'select') {
    return (
      <div style={S.paramRow}>
        <label style={S.paramLabel}>{def.label}</label>
        <select style={S.paramInput} value={value ?? def.options[0]} onChange={e => onChange(e.target.value)}>
          {def.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  return (
    <div style={S.paramRow}>
      <label style={S.paramLabel}>{def.label}</label>
      <input
        style={S.paramInput}
        type="number"
        step={def.step || 1}
        min={def.min}
        max={def.max}
        value={value ?? ''}
        placeholder="default"
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </div>
  );
}

function StreamTable({ stream }) {
  if (!stream) return null;
  const ROWS = [
    ['Q',   'Flow',   'm³/d'],
    ['BOD', 'BOD',    'mg/L'],
    ['COD', 'COD',    'mg/L'],
    ['TSS', 'TSS',    'mg/L'],
    ['TN',  'TN',     'mg/L'],
    ['NH4', 'NH₄-N',  'mg/L'],
    ['NO3', 'NO₃-N',  'mg/L'],
    ['TP',  'TP',     'mg/L'],
    ['pH',  'pH',     ''],
    ['temp','Temp',   '°C'],
  ];
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <tbody>
        {ROWS.map(([k, label, unit]) => (
          <tr key={k} style={{ borderBottom: '1px solid #F3F4F6' }}>
            <td style={{ padding: '3px 8px', color: '#6B7280' }}>{label}</td>
            <td style={{ padding: '3px 8px', fontWeight: 600, color: '#111', textAlign: 'right' }}>
              {stream[k] ?? '—'}{unit ? ' ' + unit : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  shell:       { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  toolbar:     { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#fff', borderBottom: '1px solid #E5E7EB', flexShrink: 0, overflowX: 'auto' },
  backBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: '#2E75B6', fontWeight: 600, fontSize: 14, flexShrink: 0, minHeight: 36, padding: '4px 8px' },
  title:       { fontSize: 14, fontWeight: 700, color: '#111', flex: 1, minWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tbRight:     { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  modeToggle:  { display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #D1D5DB', flexShrink: 0 },
  modeActive:  { padding: '5px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer', border: 'none', background: '#1F4E79', color: '#fff' },
  modeInactive:{ padding: '5px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer', border: 'none', background: '#F3F4F6', color: '#6B7280' },
  unsaved:     { fontSize: 11, color: '#F59E0B', fontWeight: 500, whiteSpace: 'nowrap' },
  btn:         { border: 'none', borderRadius: 6, padding: '5px 10px', fontWeight: 600, cursor: 'pointer', fontSize: 12, flexShrink: 0, minHeight: 34 },
  body:        { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 },
  canvasWrap:  { flex: 1, position: 'relative', minWidth: 0 },
  hint:        { background: 'rgba(255,255,255,0.92)', border: '1px solid #E5E7EB', borderRadius: 6, padding: '5px 10px', fontSize: 11, color: '#6B7280' },
  errBanner:   { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: '#FEF2F2', borderBottom: '1px solid #FECACA', color: '#991B1B', fontSize: 13 },
  dismissBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#991B1B', marginLeft: 'auto', fontSize: 16 },
  rightPanel:  { width: 300, maxWidth: '85vw', background: '#fff', borderLeft: '1px solid #E5E7EB', overflowY: 'auto', flexShrink: 0 },
  panelHdr:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #E5E7EB' },
  closeBtn:    { background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 },
  panelSection:{ padding: '10px 14px', borderBottom: '1px solid #F3F4F6' },
  secTitle:    { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 },
  noParams:    { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic', margin: 0 },
  paramRow:    { display: 'flex', alignItems: 'center', marginBottom: 7, gap: 8 },
  paramLabel:  { fontSize: 12, color: '#374151', flex: 1 },
  paramInput:  { width: 90, padding: '6px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 14, textAlign: 'right' },
  metricRow:   { display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 },
  metricKey:   { color: '#6B7280', flex: 1 },
  metricVal:   { fontWeight: 600, color: '#111' },
  exportBtn:   { display: 'inline-block', padding: '6px 12px', borderRadius: 5, border: '1px solid #BBF7D0', background: '#ECFDF5', color: '#065F46', fontSize: 12, fontWeight: 600, textDecoration: 'none' },
  thCell:      { padding: '4px 5px', fontWeight: 700, color: '#6B7280', textAlign: 'right', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' },
  tdCell:      { padding: '2px 5px', textAlign: 'right', color: '#111' },
};
