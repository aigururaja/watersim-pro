/**
 * LiveConfigPanel — bind each node parameter to a live data source.
 *
 * A binding lives on node.data.liveBindings[paramKey]:
 *   { enabled, protocol, config: {...}, poll_ms, scale: { factor, offset } }
 *
 * The frontend captures the full connection config for every supported
 * protocol. A backend device-gateway service polls these sources and pushes
 * the (scaled) values, which override the parameter for live runs.
 */
import { useMemo, useState } from 'react';
import api from '../../utils/api';

// Supported connection types and their configuration fields.
const PROTOCOLS = [
  { id: 'siemens_s7', label: 'Siemens S7 PLC (Snap7)', pkg: 'node-snap7', fields: [
    { k: 'host', label: 'IP address', ph: '192.168.0.1' },
    { k: 'rack', label: 'Rack', type: 'number', def: 0 },
    { k: 'slot', label: 'Slot', type: 'number', def: 1 },
    { k: 'area', label: 'Area', type: 'select', options: ['DB', 'M (Flag)', 'I (Input)', 'Q (Output)'], def: 'DB' },
    { k: 'db', label: 'DB number', type: 'number', def: 1 },
    { k: 'byte', label: 'Byte offset', type: 'number', def: 0 },
    { k: 'bit', label: 'Bit (BOOL only)', type: 'number', def: 0 },
    { k: 'dtype', label: 'Data type', type: 'select', options: ['REAL', 'INT', 'DINT', 'WORD', 'BOOL'], def: 'REAL' },
  ]},
  { id: 'modbus_tcp', label: 'Modbus TCP', pkg: 'modbus-serial', fields: [
    { k: 'host', label: 'IP address', ph: '192.168.0.10' },
    { k: 'port', label: 'Port', type: 'number', def: 502 },
    { k: 'unitId', label: 'Unit / Slave ID', type: 'number', def: 1 },
    { k: 'regType', label: 'Register', type: 'select', options: ['Holding (4x)', 'Input (3x)', 'Coil (0x)', 'Discrete (1x)'], def: 'Holding (4x)' },
    { k: 'address', label: 'Address', type: 'number', def: 0 },
    { k: 'dtype', label: 'Data type', type: 'select', options: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'BOOL'], def: 'FLOAT32' },
    { k: 'wordOrder', label: 'Word order', type: 'select', options: ['Big-endian', 'Little-endian', 'Word-swapped'], def: 'Big-endian' },
  ]},
  { id: 'modbus_rtu', label: 'Modbus RTU (Serial)', pkg: 'modbus-serial', fields: [
    { k: 'serialPort', label: 'Serial port', ph: 'COM3 / /dev/ttyUSB0' },
    { k: 'baud', label: 'Baud rate', type: 'select', options: ['9600', '19200', '38400', '57600', '115200'], def: '9600' },
    { k: 'parity', label: 'Parity', type: 'select', options: ['none', 'even', 'odd'], def: 'none' },
    { k: 'unitId', label: 'Unit / Slave ID', type: 'number', def: 1 },
    { k: 'regType', label: 'Register', type: 'select', options: ['Holding (4x)', 'Input (3x)', 'Coil (0x)', 'Discrete (1x)'], def: 'Holding (4x)' },
    { k: 'address', label: 'Address', type: 'number', def: 0 },
    { k: 'dtype', label: 'Data type', type: 'select', options: ['INT16', 'UINT16', 'INT32', 'FLOAT32', 'BOOL'], def: 'FLOAT32' },
  ]},
  { id: 'opc_ua', label: 'OPC UA', pkg: 'node-opcua', fields: [
    { k: 'endpoint', label: 'Endpoint URL', ph: 'opc.tcp://host:4840' },
    { k: 'nodeId', label: 'Node ID', ph: 'ns=2;s=Tag' },
    { k: 'security', label: 'Security', type: 'select', options: ['None', 'Sign', 'SignAndEncrypt'], def: 'None' },
  ]},
  { id: 'ethernet_ip', label: 'EtherNet/IP (Allen-Bradley)', pkg: 'ethernet-ip', fields: [
    { k: 'host', label: 'IP address', ph: '192.168.0.20' },
    { k: 'tag', label: 'Tag name', ph: 'Program:Main.Level' },
    { k: 'dtype', label: 'Data type', type: 'select', options: ['REAL', 'DINT', 'INT', 'BOOL'], def: 'REAL' },
  ]},
  { id: 'mqtt', label: 'MQTT', pkg: 'mqtt', fields: [
    { k: 'broker', label: 'Broker URL', ph: 'mqtt://host:1883' },
    { k: 'topic', label: 'Topic', ph: 'plant/tank1/level' },
    { k: 'jsonPath', label: 'JSON path (optional)', ph: '$.value' },
    { k: 'qos', label: 'QoS', type: 'select', options: ['0', '1', '2'], def: '0' },
  ]},
  { id: 'http_rest', label: 'HTTP / REST', pkg: 'axios', fields: [
    { k: 'url', label: 'URL', ph: 'http://host/api/value' },
    { k: 'method', label: 'Method', type: 'select', options: ['GET', 'POST'], def: 'GET' },
    { k: 'jsonPath', label: 'JSON path', ph: '$.data.value' },
  ]},
  { id: 'serial_embedded', label: 'Embedded board (Arduino / ESP32)', pkg: 'serialport', fields: [
    { k: 'serialPort', label: 'Serial port', ph: 'COM4 / /dev/ttyUSB0' },
    { k: 'baud', label: 'Baud rate', type: 'select', options: ['9600', '57600', '115200'], def: '115200' },
    { k: 'format', label: 'Line format', type: 'select', options: ['Plain number', 'CSV field', 'JSON key'], def: 'Plain number' },
    { k: 'key', label: 'Field / key (CSV index or JSON key)', ph: 'e.g. temp or 2' },
  ]},
  { id: 'generic_tcp', label: 'Generic TCP socket', pkg: 'net', fields: [
    { k: 'host', label: 'Host', ph: '192.168.0.30' },
    { k: 'port', label: 'Port', type: 'number', def: 9000 },
    { k: 'query', label: 'Request string (optional)', ph: 'READ\\n' },
    { k: 'parse', label: 'Parse as', type: 'select', options: ['Plain number', 'JSON path'], def: 'Plain number' },
    { k: 'jsonPath', label: 'JSON path', ph: '$.value' },
  ]},
  { id: 'bacnet', label: 'BACnet/IP', pkg: 'node-bacnet', fields: [
    { k: 'host', label: 'Device IP', ph: '192.168.0.40' },
    { k: 'deviceId', label: 'Device ID', type: 'number', def: 0 },
    { k: 'objectType', label: 'Object', type: 'select', options: ['analog-input', 'analog-value', 'binary-input', 'binary-value'], def: 'analog-input' },
    { k: 'instance', label: 'Instance', type: 'number', def: 0 },
  ]},
];

const PROTO_BY_ID = Object.fromEntries(PROTOCOLS.map(p => [p.id, p]));

function Field({ f, value, onChange }) {
  const val = value ?? f.def ?? '';
  return (
    <label style={s.field}>
      <span style={s.flabel}>{f.label}</span>
      {f.type === 'select' ? (
        <select style={s.input} value={val} onChange={e => onChange(e.target.value)}>
          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input style={s.input} type={f.type === 'number' ? 'number' : 'text'} placeholder={f.ph || ''}
          value={val}
          onChange={e => onChange(f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
      )}
    </label>
  );
}

function addressSummary(b) {
  const c = b.config || {};
  switch (b.protocol) {
    case 'siemens_s7':   return `${c.host || '?'} · ${c.area || 'DB'}${c.db ?? ''}.${c.byte ?? 0} (${c.dtype || 'REAL'})`;
    case 'modbus_tcp':   return `${c.host || '?'}:${c.port || 502} · ${c.regType || ''} @${c.address ?? 0}`;
    case 'modbus_rtu':   return `${c.serialPort || '?'} · id ${c.unitId ?? 1} @${c.address ?? 0}`;
    case 'opc_ua':       return `${c.nodeId || c.endpoint || '?'}`;
    case 'ethernet_ip':  return `${c.host || '?'} · ${c.tag || ''}`;
    case 'mqtt':         return `${c.topic || '?'}`;
    case 'http_rest':    return `${c.method || 'GET'} ${c.url || '?'}`;
    case 'serial_embedded': return `${c.serialPort || '?'} @${c.baud || ''}`;
    case 'generic_tcp':  return `${c.host || '?'}:${c.port || ''}`;
    case 'bacnet':       return `${c.host || '?'} · ${c.objectType || ''} ${c.instance ?? ''}`;
    default:             return '';
  }
}

function BindingEditor({ paramLabel, binding, onChange }) {
  const b = binding || {};
  const enabled = !!b.enabled;
  const proto = PROTO_BY_ID[b.protocol] || PROTOCOLS[0];

  const set    = (patch)   => onChange({ ...b, ...patch });
  const setCfg = (k, v)    => onChange({ ...b, config: { ...(b.config || {}), [k]: v } });
  const setScale = (k, v)  => onChange({ ...b, scale: { ...(b.scale || {}), [k]: v } });

  const [testing, setTesting] = useState(false);
  const [result, setResult]   = useState(null);
  const runTest = async () => {
    setTesting(true); setResult(null);
    try {
      const { data } = await api.post('/live/test', { protocol: b.protocol, config: b.config || {}, scale: b.scale });
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: e.response?.data?.error || e.message });
    } finally { setTesting(false); }
  };

  return (
    <div style={s.card}>
      <label style={s.cardHdr}>
        <input type="checkbox" checked={enabled}
          onChange={e => set({ enabled: e.target.checked, protocol: b.protocol || PROTOCOLS[1].id, config: b.config || {} })} />
        <span style={s.paramName}>{paramLabel}</span>
        {enabled
          ? <span style={{ ...s.dot, background: '#059669' }} title="Live source bound" />
          : <span style={s.muted}>simulated</span>}
      </label>

      {enabled && (
        <div style={s.cardBody}>
          <label style={s.field}>
            <span style={s.flabel}>Connection type</span>
            <select style={s.input} value={b.protocol || proto.id} onChange={e => set({ protocol: e.target.value, config: {} })}>
              {PROTOCOLS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <div style={s.pkgNote}>driver: <code>{proto.pkg}</code></div>

          <div style={s.grid}>
            {proto.fields.map(f => (
              <Field key={f.k} f={f} value={b.config?.[f.k]} onChange={v => setCfg(f.k, v)} />
            ))}
          </div>

          <div style={s.subTitle}>Scaling &amp; polling</div>
          <div style={s.grid}>
            <Field f={{ label: 'Poll interval (ms)', type: 'number', def: 1000 }} value={b.poll_ms} onChange={v => set({ poll_ms: v })} />
            <Field f={{ label: 'Scale factor', type: 'number', def: 1 }} value={b.scale?.factor} onChange={v => setScale('factor', v)} />
            <Field f={{ label: 'Offset', type: 'number', def: 0 }} value={b.scale?.offset} onChange={v => setScale('offset', v)} />
          </div>

          <div style={s.bound}>value = raw × factor + offset &nbsp;·&nbsp; {addressSummary(b)}</div>

          <div style={s.testRow}>
            <button type="button" style={s.testBtn} onClick={runTest} disabled={testing}>
              {testing ? 'Reading…' : 'Test connection'}
            </button>
            {result && (result.ok
              ? <span style={s.ok}>✓ {Number(result.value).toFixed(2)} <span style={s.rawNote}>(raw {String(result.raw)})</span></span>
              : <span style={s.err}>✕ {result.error}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LiveConfigPanel({ node, defs, onUpdateBinding }) {
  const bindings = node.data.liveBindings || {};
  const boundCount = useMemo(
    () => Object.values(bindings).filter(b => b?.enabled).length,
    [bindings]
  );

  if (!defs.length) {
    return <p style={s.empty}>This unit has no parameters to bind.</p>;
  }

  return (
    <div>
      <div style={s.intro}>
        Bind any parameter to a live device. A value pulled from the field
        <b> overrides the simulation input</b> for that parameter during live runs.
        {boundCount > 0 && <span style={s.count}>{boundCount} bound</span>}
      </div>
      {defs.map(def => (
        <BindingEditor
          key={def.key}
          paramLabel={def.label || def.key}
          binding={bindings[def.key]}
          onChange={(b) => onUpdateBinding(node.id, def.key, b)}
        />
      ))}
    </div>
  );
}

const s = {
  intro:    { fontSize: 12, color: '#4B5563', padding: '10px 16px', background: '#F0F9FF', borderBottom: '1px solid #E0F2FE', lineHeight: 1.5 },
  count:    { marginLeft: 8, fontWeight: 700, color: '#0891B2' },
  empty:    { fontSize: 12, color: '#9CA3AF', padding: 16 },
  card:     { margin: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden' },
  cardHdr:  { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', background: '#F9FAFB', cursor: 'pointer', fontSize: 13 },
  paramName:{ fontWeight: 600, color: '#111827', flex: 1 },
  muted:    { fontSize: 11, color: '#9CA3AF' },
  dot:      { width: 9, height: 9, borderRadius: '50%' },
  cardBody: { padding: '10px 11px', display: 'flex', flexDirection: 'column', gap: 4 },
  field:    { display: 'flex', flexDirection: 'column', gap: 3 },
  flabel:   { fontSize: 10.5, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' },
  input:    { width: '100%', padding: '6px 8px', border: '1px solid #D1D5DB', borderRadius: 7, fontSize: 12.5, color: '#111', boxSizing: 'border-box' },
  grid:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  pkgNote:  { fontSize: 10.5, color: '#9CA3AF', margin: '2px 0 4px' },
  subTitle: { fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 8 },
  bound:    { fontSize: 10.5, color: '#0891B2', fontFamily: 'ui-monospace, Consolas, monospace', marginTop: 6, wordBreak: 'break-all' },
  testRow:  { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  testBtn:  { padding: '6px 12px', background: '#0891B2', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  ok:       { fontSize: 12.5, fontWeight: 700, color: '#059669' },
  err:      { fontSize: 11.5, color: '#DC2626' },
  rawNote:  { fontWeight: 400, color: '#9CA3AF' },
};
