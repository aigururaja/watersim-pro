import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../services/api';

/**
 * PLCConnectionsTab — org-level PLC connection manager (SettingsPage tab).
 *
 * The add/edit form is driven entirely by GET /plc/protocols: the protocol
 * select disables 'stub' drivers, and config fields render dynamically from
 * each protocol's configFields definition.
 */

const EMPTY_FORM = { name: '', protocol: '', config: {}, enabled: true };

export default function PLCConnectionsTab({ canEdit, showToast }) {
  const [protocols, setProtocols]     = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [loadError, setLoadError]     = useState(null);

  const [modal, setModal]     = useState(null);  // { mode:'create'|'edit', id?, data } | null
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(null);  // connection id
  const [toggling, setToggling] = useState(null);
  const [testing, setTesting]   = useState(null);
  const [testResults, setTestResults] = useState({}); // id -> { ok, message, latencyMs }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [p, c] = await Promise.all([api.get('/plc/protocols'), api.get('/plc/connections')]);
      setProtocols(Array.isArray(p.data) ? p.data : []);
      setConnections(Array.isArray(c.data) ? c.data : []);
    } catch (e) {
      setLoadError(e.response?.status === 404
        ? 'PLC endpoints are not available on this server yet.'
        : (e.response?.data?.error || 'Failed to load PLC connections'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const protocolByKey = useMemo(() => {
    const m = {};
    for (const p of protocols) m[p.protocol] = p;
    return m;
  }, [protocols]);

  const defaultConfigFor = (protoKey) => {
    const cfg = {};
    for (const f of protocolByKey[protoKey]?.configFields || []) {
      if (f.default !== undefined) cfg[f.key] = f.default;
    }
    return cfg;
  };

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openCreate = () => {
    const firstAvailable = protocols.find(p => p.status === 'available');
    setModal({
      mode: 'create',
      data: {
        ...EMPTY_FORM,
        protocol: firstAvailable?.protocol || '',
        config: firstAvailable ? defaultConfigFor(firstAvailable.protocol) : {},
      },
    });
  };

  const openEdit = (c) => setModal({
    mode: 'edit',
    id: c.id,
    data: {
      name: c.name || '',
      protocol: c.protocol || '',
      config: { ...(c.config || {}) },
      enabled: c.enabled !== false,
    },
  });

  const updateField = (key, value) => setModal(m => ({ ...m, data: { ...m.data, [key]: value } }));
  const updateConfig = (key, value) => setModal(m => ({
    ...m,
    data: { ...m.data, config: { ...m.data.config, [key]: value } },
  }));

  const changeProtocol = (protoKey) => setModal(m => ({
    ...m,
    data: { ...m.data, protocol: protoKey, config: defaultConfigFor(protoKey) },
  }));

  const configFields = modal ? (protocolByKey[modal.data.protocol]?.configFields || []) : [];
  const missingRequired = modal
    ? configFields.filter(f => f.required && (modal.data.config[f.key] == null || modal.data.config[f.key] === ''))
    : [];
  const formValid = modal
    && modal.data.name.trim() !== ''
    && modal.data.protocol !== ''
    && missingRequired.length === 0;

  const handleSave = async () => {
    if (!modal || !formValid) return;
    setSaving(true);
    try {
      const body = {
        name: modal.data.name.trim(),
        protocol: modal.data.protocol,
        config: modal.data.config,
        enabled: modal.data.enabled,
      };
      if (modal.mode === 'create') {
        await api.post('/plc/connections', body);
        showToast?.('PLC connection created');
      } else {
        await api.patch(`/plc/connections/${modal.id}`, body);
        showToast?.('PLC connection updated');
      }
      setModal(null);
      load();
    } catch (e) {
      showToast?.(e.response?.data?.error || 'Save failed', false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete PLC connection "${c.name}"? Parameter bindings using it will stop updating. This cannot be undone.`)) return;
    setDeleting(c.id);
    try {
      await api.delete(`/plc/connections/${c.id}`);
      showToast?.('Connection deleted');
      load();
    } catch (e) {
      showToast?.(e.response?.data?.error || 'Delete failed', false);
    } finally {
      setDeleting(null);
    }
  };

  const toggleEnabled = async (c) => {
    setToggling(c.id);
    try {
      await api.patch(`/plc/connections/${c.id}`, { enabled: !(c.enabled !== false) });
      showToast?.(c.enabled !== false ? 'Connection disabled' : 'Connection enabled');
      load();
    } catch (e) {
      showToast?.(e.response?.data?.error || 'Update failed', false);
    } finally {
      setToggling(null);
    }
  };

  const testConnection = async (c) => {
    setTesting(c.id);
    setTestResults(r => ({ ...r, [c.id]: undefined }));
    try {
      const { data } = await api.post(`/plc/connections/${c.id}/test`);
      setTestResults(r => ({ ...r, [c.id]: data && typeof data === 'object' ? data : { ok: false, message: 'No response' } }));
    } catch (e) {
      setTestResults(r => ({ ...r, [c.id]: { ok: false, message: e.response?.data?.error || e.message } }));
    } finally {
      setTesting(null);
    }
  };

  // Status dot: green when the driver reports a healthy status, red on
  // error states / last_error, gray when disabled or unknown.
  const statusDot = (c) => {
    if (c.enabled === false) return '#9CA3AF';
    const s = String(c.status || '').toLowerCase();
    if (['connected', 'ok', 'online', 'up', 'healthy'].includes(s)) return '#16A34A';
    if (['error', 'down', 'disconnected', 'failed', 'offline'].includes(s) || c.last_error) return '#DC2626';
    return '#9CA3AF';
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>🔌 PLC Connections</h2>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6B7280', maxWidth: 560 }}>
            Connect WaterSim to plant PLCs / SCADA. Bind node parameters to PLC tags from the
            canvas parameter panel to stream live process data into simulations.
          </p>
        </div>
        {canEdit && (
          <button style={S.primaryBtn} onClick={openCreate} disabled={loading}>
            + Add connection
          </button>
        )}
      </div>

      {loading && <div style={{ color: '#9CA3AF', fontSize: 14, padding: '20px 0' }}>Loading PLC connections…</div>}
      {loadError && !loading && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#92400E', marginBottom: 12 }}>
          ⚠ {loadError}
        </div>
      )}

      {!loading && !loadError && connections.length === 0 && (
        <div style={{ background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 8, padding: 24, textAlign: 'center', color: '#6B7280', fontSize: 14 }}>
          No PLC connections yet.{canEdit && ' Click "Add connection" to create one.'}
        </div>
      )}

      {/* Connection rows */}
      {!loading && connections.map(c => {
        const tr = testResults[c.id];
        return (
          <div key={c.id} style={S.row}>
            <span
              title={c.last_error || c.status || (c.enabled === false ? 'Disabled' : 'Status unknown')}
              aria-label={`Status: ${c.last_error || c.status || 'unknown'}`}
              style={{ width: 10, height: 10, borderRadius: '50%', background: statusDot(c), flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{c.name}</div>
              <div style={{ fontSize: 12, color: '#6B7280' }}>
                {protocolByKey[c.protocol]?.label || c.protocol}
                {c.last_seen && ` · last seen ${new Date(c.last_seen).toLocaleString()}`}
              </div>
              {tr && (
                <div style={{ fontSize: 12, marginTop: 3, color: tr.ok ? '#065F46' : '#DC2626', fontWeight: 600 }}>
                  {tr.ok
                    ? `✓ ${tr.message || 'Connection OK'}${tr.latencyMs != null ? ` · ${tr.latencyMs} ms` : ''}`
                    : `✗ ${tr.message || 'Connection failed'}`}
                </div>
              )}
            </div>

            {/* Enabled toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6B7280', cursor: canEdit ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                checked={c.enabled !== false}
                disabled={!canEdit || toggling === c.id}
                onChange={() => toggleEnabled(c)}
                aria-label={`${c.name} enabled`}
              />
              Enabled
            </label>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {/* Test hits an engineer-gated endpoint — hide it (like Edit/
                  Delete) from operators/viewers who would only ever get a 403. */}
              {canEdit && (
                <button
                  style={S.outlineBtn}
                  onClick={() => testConnection(c)}
                  disabled={testing === c.id}
                >
                  {testing === c.id ? 'Testing…' : 'Test'}
                </button>
              )}
              {canEdit && <button style={S.outlineBtn} onClick={() => openEdit(c)}>Edit</button>}
              {canEdit && (
                <button
                  style={{ ...S.outlineBtn, color: '#DC2626', borderColor: '#FECACA' }}
                  onClick={() => handleDelete(c)}
                  disabled={deleting === c.id}
                >
                  {deleting === c.id ? '…' : 'Delete'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Read-only notice */}
      {!canEdit && (
        <div style={{ background: '#F3F4F6', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: '#6B7280', marginTop: 12 }}>
          🔒 Operators can view PLC connections but cannot change them. Contact an Engineer or Admin to make changes.
        </div>
      )}

      {/* Add / edit modal */}
      {modal && (
        <div style={S.overlay} role="dialog" aria-modal="true" aria-label={modal.mode === 'create' ? 'New PLC connection' : 'Edit PLC connection'}>
          <div style={S.modalBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
                {modal.mode === 'create' ? '🔌 New PLC Connection' : '🔌 Edit PLC Connection'}
              </h2>
              <button style={S.closeBtn} onClick={() => setModal(null)} aria-label="Close">&times;</button>
            </div>

            {/* Name */}
            <label style={S.label} htmlFor="plc-conn-name">Connection name *</label>
            <input
              id="plc-conn-name"
              style={S.input}
              value={modal.data.name}
              onChange={e => updateField('name', e.target.value)}
              placeholder="e.g. Blower PLC — Train A"
              maxLength={80}
            />

            {/* Protocol (driven by /plc/protocols) */}
            <label style={S.label} htmlFor="plc-conn-protocol">Protocol *</label>
            <select
              id="plc-conn-protocol"
              style={S.input}
              value={modal.data.protocol}
              onChange={e => changeProtocol(e.target.value)}
            >
              <option value="" disabled>Select protocol…</option>
              {protocols.map(p => (
                <option key={p.protocol} value={p.protocol} disabled={p.status !== 'available'}>
                  {p.label}{p.status !== 'available' ? ' (driver not installed)' : ''}
                </option>
              ))}
            </select>

            {/* Dynamic config fields */}
            {configFields.map(f => (
              <div key={f.key}>
                <label style={S.label} htmlFor={`plc-cfg-${f.key}`}>
                  {f.label}{f.required ? ' *' : ''}
                </label>
                <input
                  id={`plc-cfg-${f.key}`}
                  style={S.input}
                  type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={modal.data.config[f.key] ?? ''}
                  placeholder={f.placeholder || (f.default != null ? `Default: ${f.default}` : '')}
                  onChange={e => updateConfig(
                    f.key,
                    f.type === 'number'
                      ? (e.target.value === '' ? '' : Number(e.target.value))
                      : e.target.value
                  )}
                  autoComplete={f.type === 'password' ? 'new-password' : 'off'}
                />
              </div>
            ))}

            {/* Enabled */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', margin: '4px 0 12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={modal.data.enabled}
                onChange={e => updateField('enabled', e.target.checked)}
              />
              Enabled (poll this connection)
            </label>

            {missingRequired.length > 0 && (
              <div style={{ fontSize: 12, color: '#92400E', marginBottom: 10 }}>
                Required: {missingRequired.map(f => f.label).join(', ')}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button style={{ ...S.btn, background: '#F3F4F6', color: '#374151' }} onClick={() => setModal(null)} disabled={saving}>
                Cancel
              </button>
              <button
                style={{ ...S.btn, background: '#1D4ED8', color: '#fff', opacity: formValid && !saving ? 1 : 0.6 }}
                onClick={handleSave}
                disabled={!formValid || saving}
              >
                {saving ? 'Saving…' : modal.mode === 'create' ? 'Create connection' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  primaryBtn: { background: '#1D4ED8', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 38 },
  outlineBtn: { background: '#fff', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', minHeight: 34 },
  row:        { display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '12px 14px', marginBottom: 10, flexWrap: 'wrap' },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modalBox:   { background: '#fff', borderRadius: 12, padding: '24px 28px', width: 460, maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  closeBtn:   { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF', minWidth: 32, minHeight: 32 },
  label:      { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:      { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, marginBottom: 10, boxSizing: 'border-box', background: '#fff' },
  btn:        { padding: '8px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 },
};
