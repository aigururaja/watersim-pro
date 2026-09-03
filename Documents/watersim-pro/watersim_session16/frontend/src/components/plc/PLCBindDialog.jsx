import { useEffect, useState } from 'react';
import api from '../../services/api';

/**
 * PLCBindDialog — modal to bind one node parameter to a PLC tag.
 *
 * Save always POSTs the upsert endpoint (the backend upserts per node+param);
 * Remove DELETEs the existing binding.
 */

const DIRECTIONS = [
  { value: 'read',       label: 'Read (PLC → model)' },
  { value: 'write',      label: 'Write (model → PLC)' },
  { value: 'read_write', label: 'Read / Write' },
];

export default function PLCBindDialog({
  projectId, flowsheetId,
  nodeId, paramKey, paramLabel, nodeLabel,
  binding,               // existing binding row or null
  onClose, onSaved, onRemoved,
}) {
  const [connections, setConnections] = useState(null); // null = loading
  const [protocols, setProtocols]     = useState([]);
  const [loadError, setLoadError]     = useState(null);

  const [connectionId, setConnectionId] = useState(binding?.connection_id ?? '');
  const [address, setAddress]           = useState(binding?.address ?? '');
  const [direction, setDirection]       = useState(binding?.direction ?? 'read');
  const [scale, setScale]               = useState(binding?.scale ?? 1);
  const [offset, setOffset]             = useState(binding?.offset_val ?? 0);
  const [pollMs, setPollMs]             = useState(binding?.poll_interval_ms ?? '');
  const [enabled, setEnabled]           = useState(binding ? binding.enabled !== false : true);

  const [saving, setSaving]     = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError]       = useState(null);

  // Load enabled connections + protocol metadata (for address hints).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [connRes, protoRes] = await Promise.allSettled([
        api.get('/plc/connections'),
        api.get('/plc/protocols'),
      ]);
      if (cancelled) return;
      if (connRes.status === 'fulfilled' && Array.isArray(connRes.value.data)) {
        const enabledConns = connRes.value.data.filter(c => c.enabled !== false);
        setConnections(enabledConns);
        setConnectionId(prev => {
          // Previously bound connection was deleted/disabled — reset so Save
          // can't post a dead UUID (a hint is rendered below the select).
          if (prev !== '' && !enabledConns.some(c => String(c.id) === String(prev))) return '';
          // Auto-select the first enabled connection when creating a new binding
          if (prev === '' && enabledConns.length) return enabledConns[0].id;
          return prev;
        });
      } else {
        setConnections([]);
        setLoadError('Could not load PLC connections — the PLC backend may not be available yet.');
      }
      if (protoRes.status === 'fulfilled' && Array.isArray(protoRes.value.data)) {
        setProtocols(protoRes.value.data);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedConn = (connections || []).find(c => String(c.id) === String(connectionId));
  const selectedProto = protocols.find(p => p.protocol === selectedConn?.protocol);
  const addressHint = selectedProto?.addressHint || '';
  const protoLabel = (key) => protocols.find(p => p.protocol === key)?.label || key;

  const canSave = !saving && !removing && connectionId !== '' && String(address).trim() !== '';

  const save = async (e) => {
    e?.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/flowsheets/${flowsheetId}/plc-bindings`, {
        nodeId,
        paramKey,
        connectionId,
        address: String(address).trim(),
        direction,
        scale: Number.isFinite(Number(scale)) && String(scale) !== '' ? Number(scale) : 1,
        offset: Number.isFinite(Number(offset)) && String(offset) !== '' ? Number(offset) : 0,
        pollIntervalMs: pollMs === '' || pollMs == null ? null : Number(pollMs),
        enabled,
      });
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!binding?.id) return;
    if (!window.confirm('Remove this PLC binding? The parameter will stop receiving live values.')) return;
    setRemoving(true);
    setError(null);
    try {
      await api.delete(`/projects/${projectId}/flowsheets/${flowsheetId}/plc-bindings/${binding.id}`);
      onRemoved?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Remove failed');
      setRemoving(false);
    }
  };

  return (
    <div style={S.overlay} role="dialog" aria-modal="true" aria-label="Bind parameter to PLC">
      <div style={S.box}>
        <div style={S.header}>
          <h2 style={S.title}>🔗 Bind Parameter to PLC</h2>
          <button style={S.closeBtn} onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div style={S.context}>
          <strong>{nodeLabel || nodeId}</strong> · {paramLabel || paramKey}
          {binding && <span style={{ color: '#065F46', marginLeft: 6 }}>(bound)</span>}
        </div>

        {error && <div style={S.errorBox}>⚠ {error}</div>}
        {loadError && <div style={S.warnBox}>{loadError}</div>}

        <form onSubmit={save}>
          {/* Connection */}
          <label style={S.label} htmlFor="plc-bind-connection">PLC connection *</label>
          {connections === null ? (
            <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 12 }}>Loading connections…</div>
          ) : connections.length === 0 ? (
            <div style={S.warnBox}>
              No enabled PLC connections. Create one in Settings → PLC Connections first.
            </div>
          ) : (
            <select
              id="plc-bind-connection"
              style={S.input}
              value={connectionId}
              onChange={e => setConnectionId(e.target.value)}
            >
              {connectionId === '' && <option value="">— choose a connection —</option>}
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({protoLabel(c.protocol)})
                </option>
              ))}
            </select>
          )}
          {binding?.connection_id && connections !== null &&
            !connections.some(c => String(c.id) === String(binding.connection_id)) && (
            <div style={{ fontSize: 11.5, color: '#B45309', margin: '-6px 0 10px' }}>
              Previous connection is no longer available — choose another.
            </div>
          )}

          {/* Address */}
          <label style={S.label} htmlFor="plc-bind-address">Address *</label>
          <input
            id="plc-bind-address"
            style={S.input}
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder={addressHint || 'PLC tag address'}
            autoFocus
          />
          {addressHint && (
            <div style={S.hint}>Address format: {addressHint}</div>
          )}

          {/* Direction */}
          <label style={S.label} htmlFor="plc-bind-direction">Direction</label>
          <select
            id="plc-bind-direction"
            style={S.input}
            value={direction}
            onChange={e => setDirection(e.target.value)}
          >
            {DIRECTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>

          {/* Scale / Offset */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label} htmlFor="plc-bind-scale">Scale</label>
              <input
                id="plc-bind-scale"
                type="number" step="any" style={S.input}
                value={scale}
                onChange={e => setScale(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label} htmlFor="plc-bind-offset">Offset</label>
              <input
                id="plc-bind-offset"
                type="number" step="any" style={S.input}
                value={offset}
                onChange={e => setOffset(e.target.value)}
              />
            </div>
          </div>
          <div style={S.hint}>engineering value = raw × scale + offset (defaults 1 / 0)</div>

          {/* Poll interval */}
          <label style={S.label} htmlFor="plc-bind-poll">Poll interval (ms) — optional</label>
          <input
            id="plc-bind-poll"
            type="number" min={100} step={100} style={S.input}
            value={pollMs}
            onChange={e => setPollMs(e.target.value)}
            placeholder="connection default"
          />

          {/* Enabled */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', margin: '4px 0 14px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
            />
            Enabled
          </label>

          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              {binding && (
                <button
                  type="button"
                  onClick={remove}
                  disabled={removing || saving}
                  style={{ ...S.btn, background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', opacity: removing ? 0.7 : 1 }}
                >
                  {removing ? 'Removing…' : 'Remove binding'}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" style={{ ...S.btn, background: '#F3F4F6', color: '#374151' }} onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSave}
                style={{ ...S.btn, background: '#1D4ED8', color: '#fff', opacity: canSave ? 1 : 0.6 }}
              >
                {saving ? 'Saving…' : 'Save binding'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const S = {
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  box:      { background: '#fff', borderRadius: 12, padding: '24px 28px', width: 460, maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  header:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title:    { fontSize: 17, fontWeight: 700, margin: 0, color: '#111' },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF', minWidth: 32, minHeight: 32 },
  context:  { background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#1E40AF' },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, marginBottom: 10, boxSizing: 'border-box', background: '#fff' },
  hint:     { fontSize: 11, color: '#9CA3AF', marginTop: -6, marginBottom: 10 },
  btn:      { padding: '8px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  errorBox: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12 },
  warnBox:  { background: '#FFFBEB', border: '1px solid #FCD34D', color: '#92400E', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12 },
};
