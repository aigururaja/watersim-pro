import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import AppLayout from '../components/layout/AppLayout';
import PLCConnectionsTab from '../components/plc/PLCConnectionsTab';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIMIT_FIELDS = [
  { key: 'BOD',     label: 'BOD₅',          unit: 'mg/L',  step: 1,   min: 0 },
  { key: 'TSS',     label: 'TSS',            unit: 'mg/L',  step: 1,   min: 0 },
  { key: 'TN',      label: 'TN (Total N)',   unit: 'mg/L',  step: 0.5, min: 0 },
  { key: 'TP',      label: 'TP (Total P)',   unit: 'mg/L',  step: 0.1, min: 0 },
  { key: 'NH4',     label: 'NH₄-N',         unit: 'mg/L',  step: 0.5, min: 0 },
  { key: 'NO3',     label: 'NO₃-N',         unit: 'mg/L',  step: 0.5, min: 0 },
  { key: 'pH_min',  label: 'pH minimum',     unit: 'S.U.', step: 0.1, min: 0, max: 14 },
  { key: 'pH_max',  label: 'pH maximum',     unit: 'S.U.', step: 0.1, min: 0, max: 14 },
];

const DEFAULT_LIMITS = { BOD: 30, TSS: 30, TN: 10, TP: 1, NH4: 5, NO3: null, pH_min: 6, pH_max: 9 };

const EMPTY_FORM = { name: '', description: '', permit_limits: { ...DEFAULT_LIMITS } };

// ── Cost Coefficient definitions ─────────────────────────────────────────────

const UNIT_COST_FIELDS = [
  {
    group: '⚡ Energy',
    fields: [
      { key: 'electricity_USD_per_kWh',  label: 'Electricity',           unit: '$/kWh',       step: 0.001,  min: 0, hint: 'Average grid rate (typically $0.08–0.18/kWh)' },
      { key: 'aeration_kWh_per_kgO2',    label: 'Aeration energy',       unit: 'kWh/kgO₂',    step: 0.05,   min: 0, hint: 'Blower efficiency — typical 1.0–2.0 kWh/kgO₂ transferred' },
      { key: 'pumping_kWh_per_m3',       label: 'Pumping energy',        unit: 'kWh/m³',       step: 0.002,  min: 0, hint: 'General pumping allowance' },
    ],
  },
  {
    group: '🧪 Chemicals',
    fields: [
      { key: 'coagulant_USD_per_kg',     label: 'Coagulant unit cost',   unit: '$/kg',         step: 0.01,   min: 0, hint: 'Alum / FeCl₃ delivered price' },
      { key: 'coagulant_dose_mg_per_L',  label: 'Coagulant dose',        unit: 'mg/L',         step: 1,      min: 0, hint: 'Default applied to full influent flow' },
      { key: 'polymer_USD_per_kg',       label: 'Polymer unit cost',     unit: '$/kg',         step: 0.05,   min: 0, hint: 'Flocculant polymer delivered price' },
      { key: 'polymer_dose_mg_per_L',    label: 'Polymer dose',          unit: 'mg/L',         step: 0.1,    min: 0, hint: 'Applied to WAS / thickened sludge flow' },
      { key: 'disinfectant_USD_per_kg',  label: 'Disinfectant unit cost',unit: '$/kg',         step: 0.01,   min: 0, hint: 'Sodium hypochlorite or equivalent' },
      { key: 'disinfectant_dose_mg_per_L',label:'Disinfectant dose',     unit: 'mg/L',         step: 0.5,    min: 0, hint: 'Applied to treated effluent flow' },
    ],
  },
  {
    group: '🪣 Sludge Disposal',
    fields: [
      { key: 'biosolids_USD_per_tonne_dry', label: 'Biosolids disposal', unit: '$/t dry',      step: 5,      min: 0, hint: 'Landfill / land application tipping fee' },
      { key: 'biosolids_dry_fraction',   label: 'Cake dry solids',       unit: 'fraction',     step: 0.01,   min: 0, max: 1, hint: 'Dewatered cake DS (e.g. 0.25 = 25 % DS)' },
    ],
  },
  {
    group: '👷 Labour & Capital',
    fields: [
      { key: 'operator_salary_USD_yr',   label: 'Operator salary',       unit: '$/yr',         step: 1000,   min: 0, hint: 'Average all-in cost per FTE operator' },
      { key: 'maintenance_pct_of_capex', label: 'Maintenance (% CAPEX)', unit: 'fraction',     step: 0.001,  min: 0, hint: 'Annual maintenance as fraction of CAPEX (e.g. 0.02 = 2 %)' },
      { key: 'capex_per_m3_daily_capacity', label: 'CAPEX rate',         unit: '$/m³·d',       step: 50,     min: 0, hint: 'Parametric CAPEX for maintenance base estimate' },
    ],
  },
];

// ── UnitCostsTab ─────────────────────────────────────────────────────────────

function UnitCostsTab({ projectId, canEdit, showToast }) {
  const [data, setData]       = useState(null);   // { defaults, overrides, effective }
  const [edits, setEdits]     = useState({});      // user's unsaved changes
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [dirty, setDirty]     = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data: d } = await api.get(`/projects/${projectId}/unit-costs`);
      setData(d);
      setEdits({ ...d.overrides });
      setDirty(false);
    } catch (e) {
      // If project has no unit-costs yet, synthesise from defaults endpoint
      try {
        const { data: def } = await api.get('/projects/default-unit-costs');
        const defaults = def.unitCosts || {};
        setData({ defaults, overrides: {}, effective: { ...defaults } });
        setEdits({});
        setDirty(false);
      } catch (_) {
        showToast('Could not load cost coefficients', false);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleChange = (key, raw) => {
    const val = raw === '' ? undefined : parseFloat(raw);
    setEdits(prev => {
      const next = { ...prev };
      if (val === undefined || isNaN(val)) {
        delete next[key]; // revert to default
      } else {
        next[key] = val;
      }
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const { data: d } = await api.put(`/projects/${projectId}/unit-costs`, edits);
      setData(d);
      setEdits({ ...d.overrides });
      setDirty(false);
      showToast('Cost coefficients saved — next simulation will use these values');
    } catch (e) {
      showToast(e.response?.data?.error || 'Save failed', false);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Reset all cost overrides to global defaults?')) return;
    setSaving(true);
    try {
      const { data: d } = await api.delete(`/projects/${projectId}/unit-costs`);
      setData(d);
      setEdits({});
      setDirty(false);
      showToast('Reset to defaults');
    } catch (e) {
      showToast('Reset failed', false);
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) return (
    <div style={{ padding: 32, color: '#6B7280', textAlign: 'center' }}>
      <p style={{ fontSize: 15 }}>💡 Unit-cost overrides are <strong>per-project</strong>.</p>
      <p style={{ marginTop: 8 }}>Open a project and navigate to its Settings to edit cost coefficients.</p>
    </div>
  );

  if (loading) return <div style={{ padding: 32, color: '#9CA3AF' }}>Loading…</div>;

  const defaults = data?.defaults || {};

  const displayVal = (key) => {
    if (edits[key] !== undefined) return edits[key];
    return defaults[key] ?? '';
  };

  const isOverridden = (key) => edits[key] !== undefined && edits[key] !== defaults[key];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>💰 Cost Coefficients</h2>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6B7280' }}>
            Overrides apply to <em>all simulations in this project</em>. Blank = use global default.
            Changes take effect on the next simulation run.
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={reset}
              disabled={saving || Object.keys(edits).length === 0}
              style={{ ...S.secondaryBtn, opacity: saving || Object.keys(edits).length === 0 ? 0.5 : 1 }}
            >
              ↺ Reset to Defaults
            </button>
            <button
              onClick={save}
              disabled={saving || !dirty}
              style={{ ...S.primaryBtn, opacity: saving || !dirty ? 0.7 : 1 }}
            >
              {saving ? 'Saving…' : dirty ? '💾 Save Changes' : 'Saved ✓'}
            </button>
          </div>
        )}
      </div>

      {/* Overrides count banner */}
      {Object.keys(edits).length > 0 && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#92400E' }}>
          ⚠ {Object.keys(edits).length} coefficient{Object.keys(edits).length !== 1 ? 's' : ''} override{Object.keys(edits).length === 1 ? 'd' : ''} from global defaults.
          {!dirty && ' All changes saved.'}
          {dirty && ' Unsaved changes — click Save to apply.'}
        </div>
      )}

      {/* Coefficient groups */}
      {UNIT_COST_FIELDS.map(group => (
        <div key={group.group} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid #E5E7EB' }}>
            {group.group}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {group.fields.map(f => {
              const overridden = isOverridden(f.key);
              return (
                <div key={f.key} style={{ background: overridden ? '#FFFBEB' : '#F9FAFB', border: `1px solid ${overridden ? '#FCD34D' : '#E5E7EB'}`, borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{f.label}</label>
                    <span style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'monospace' }}>{f.unit}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="number"
                      step={f.step}
                      min={f.min ?? 0}
                      max={f.max}
                      value={displayVal(f.key)}
                      onChange={e => handleChange(f.key, e.target.value)}
                      disabled={!canEdit}
                      style={{
                        flex: 1, border: `1px solid ${overridden ? '#F59E0B' : '#D1D5DB'}`,
                        borderRadius: 5, padding: '6px 8px', fontSize: 13,
                        background: overridden ? '#FFFBEB' : '#fff',
                        fontWeight: overridden ? 600 : 400,
                      }}
                      placeholder={`Default: ${defaults[f.key]}`}
                    />
                    {overridden && (
                      <button
                        title="Revert to default"
                        onClick={() => handleChange(f.key, '')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 14, padding: '2px 4px' }}
                      >✕</button>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>{f.hint}</div>
                  {overridden && (
                    <div style={{ fontSize: 11, color: '#92400E', marginTop: 3 }}>Default: {defaults[f.key]}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Read-only notice for operators */}
      {!canEdit && (
        <div style={{ background: '#F3F4F6', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: '#6B7280', marginTop: 8 }}>
          🔒 Operators can view cost coefficients but cannot edit them. Contact an Engineer or Admin to make changes.
        </div>
      )}
    </div>
  );
}

// ── SettingsPage ───────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user } = useAuth();
  const { projectId } = useParams();
  const canEdit   = ['admin', 'engineer'].includes(user?.role);
  const canDelete = user?.role === 'admin';

  // Per-project settings route (/projects/:projectId/settings) is for cost
  // coefficients — open that tab directly; the org-level route opens permits.
  const [activeTab, setActiveTab] = useState(projectId ? 'costs' : 'permits');

  const [templates, setTemplates]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [modal, setModal]           = useState(null); // null | { mode: 'create' | 'edit', data }
  const [saving, setSaving]         = useState(false);
  const [activating, setActivating] = useState(null);
  const [deleting, setDeleting]     = useState(null);
  const [toast, setToast]           = useState(null); // { msg, ok }

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchTemplates = useCallback(async () => {
    try {
      const { data } = await api.get('/permit-templates');
      setTemplates(Array.isArray(data) ? data : (data.data ?? []));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load permit templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const openCreate = () => setModal({ mode: 'create', data: JSON.parse(JSON.stringify(EMPTY_FORM)) });

  const openEdit = (tpl) => setModal({
    mode: 'edit',
    id: tpl.id,
    data: {
      name: tpl.name,
      description: tpl.description || '',
      permit_limits: { ...DEFAULT_LIMITS, ...tpl.permit_limits },
    },
  });

  const handleSave = async () => {
    if (!modal) return;
    setSaving(true);
    try {
      if (modal.mode === 'create') {
        await api.post('/permit-templates', modal.data);
        showToast('Template created');
      } else {
        await api.patch(`/permit-templates/${modal.id}`, modal.data);
        showToast('Template updated');
      }
      setModal(null);
      fetchTemplates();
    } catch (e) {
      showToast(e.response?.data?.error || 'Save failed', false);
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (id) => {
    setActivating(id);
    try {
      await api.post(`/permit-templates/${id}/activate`);
      showToast('Template activated — simulations will now use these limits');
      fetchTemplates();
    } catch (e) {
      showToast(e.response?.data?.error || 'Activation failed', false);
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this template? This cannot be undone.')) return;
    setDeleting(id);
    try {
      await api.delete(`/permit-templates/${id}`);
      showToast('Template deleted');
      fetchTemplates();
    } catch (e) {
      showToast(e.response?.data?.error || 'Delete failed', false);
    } finally {
      setDeleting(null);
    }
  };

  const updateLimit = (key, raw) => {
    setModal(m => ({
      ...m,
      data: {
        ...m.data,
        permit_limits: {
          ...m.data.permit_limits,
          [key]: raw === '' ? null : Number(raw),
        },
      },
    }));
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div style={S.page}>

        {/* Toast */}
        {toast && (
          <div style={{ ...S.toast, background: toast.ok ? '#065F46' : '#991B1B' }}>
            {toast.ok ? '✓' : '⚠'} {toast.msg}
          </div>
        )}

        {/* Page header */}
        <div style={S.pageHeader}>
          <div>
            <h1 style={S.pageTitle}>Settings</h1>
            <p style={S.pageSub}>Manage permit templates and per-project cost coefficients for simulation.</p>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #E5E7EB', marginBottom: 24 }}>
          {[
            { key: 'permits', label: '📋 Permit Templates' },
            { key: 'costs', label: '💰 Cost Coefficients' },
            { key: 'plc', label: '🔌 PLC Connections' },
          ].map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
              padding: '10px 22px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
              fontWeight: activeTab === tab.key ? 700 : 500,
              color: activeTab === tab.key ? '#1F4E79' : '#6B7280',
              borderBottom: `2px solid ${activeTab === tab.key ? '#1F4E79' : 'transparent'}`,
              marginBottom: -2,
            }}>{tab.label}</button>
          ))}
        </div>

        {activeTab === 'permits' && (<>

        {/* Section: Permit Templates */}
        <section style={S.section}>
          <div style={S.sectionHeader}>
            <div>
              <h2 style={S.sectionTitle}>📋 Permit Templates</h2>
              <p style={S.sectionSub}>
                The <strong>active</strong> template's limits are automatically applied to every
                steady-state simulation outlet node. One template is active at a time.
              </p>
            </div>
            {canEdit && (
              <button style={S.primaryBtn} onClick={openCreate}>+ New Template</button>
            )}
          </div>

          {loading && <div style={S.status}>Loading templates…</div>}
          {error   && <div style={{ ...S.status, color: '#DC2626' }}>{error}</div>}

          {!loading && !error && templates.length === 0 && (
            <div style={S.empty}>
              No permit templates yet.{canEdit && ' Click "New Template" to create one.'}
            </div>
          )}

          {!loading && templates.length > 0 && (
            <div style={S.cardGrid}>
              {templates.map(tpl => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  activating={activating === tpl.id}
                  deleting={deleting === tpl.id}
                  onEdit={() => openEdit(tpl)}
                  onActivate={() => handleActivate(tpl.id)}
                  onDelete={() => handleDelete(tpl.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Section: Role Reference */}
        <section style={S.section}>
          <h2 style={S.sectionTitle}>👥 Role Permissions</h2>
          <div style={S.roleTable}>
            {[
              ['Action', 'Admin', 'Engineer', 'Operator'],
              ['View templates', '✓', '✓', '✓'],
              ['Create / Edit templates', '✓', '✓', '—'],
              ['Activate template', '✓', '✓', '—'],
              ['Delete template', '✓', '—', '—'],
            ].map((row, i) => (
              <div key={i} style={{ ...S.roleRow, background: i === 0 ? '#F9FAFB' : i % 2 === 0 ? '#fff' : '#F9FAFB' }}>
                {row.map((cell, j) => (
                  <div key={j} style={{ ...S.roleCell, fontWeight: i === 0 || j === 0 ? 600 : 400,
                    color: cell === '✓' ? '#065F46' : cell === '—' ? '#9CA3AF' : '#111' }}>
                    {cell}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>
            Your current role: <strong style={{ color: '#1D4ED8' }}>{user?.role}</strong>
          </p>
        </section>

        </> )}  {/* end permits tab */}

        {activeTab === 'costs' && (
          <section style={S.section}>
            <UnitCostsTab projectId={projectId} canEdit={canEdit} showToast={showToast} />
          </section>
        )}

        {activeTab === 'plc' && (
          <section style={S.section}>
            <PLCConnectionsTab canEdit={canEdit} showToast={showToast} />
          </section>
        )}

      {/* Modal */}
      {modal && (
        <TemplateModal
          modal={modal}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={handleSave}
          onUpdateField={(k, v) => setModal(m => ({ ...m, data: { ...m.data, [k]: v } }))}
          onUpdateLimit={updateLimit}
        />
      )}
      </div>
    </AppLayout>
  );
}

// ── TemplateCard ───────────────────────────────────────────────────────────────

function TemplateCard({ tpl, canEdit, canDelete, activating, deleting, onEdit, onActivate, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const limits = tpl.permit_limits || {};

  return (
    <div style={{ ...S.card, borderLeft: `4px solid ${tpl.is_active ? '#059669' : '#E5E7EB'}` }}>
      {/* Card header */}
      <div style={S.cardTop}>
        <div style={{ flex: 1 }}>
          <div style={S.cardTitle}>
            {tpl.name}
            {tpl.is_active && (
              <span style={S.activeBadge}>● ACTIVE</span>
            )}
          </div>
          {tpl.description && <p style={S.cardDesc}>{tpl.description}</p>}
          <p style={S.cardMeta}>
            Created {new Date(tpl.created_at).toLocaleDateString()}
            {tpl.updated_at !== tpl.created_at && ` · Updated ${new Date(tpl.updated_at).toLocaleDateString()}`}
          </p>
        </div>
      </div>

      {/* Limit chips */}
      <div style={S.chipRow}>
        {LIMIT_FIELDS.filter(f => !['pH_min','pH_max'].includes(f.key)).map(f => {
          const val = limits[f.key];
          return (
            <span key={f.key} style={{ ...S.chip, opacity: val == null ? 0.4 : 1 }}>
              <span style={S.chipLabel}>{f.key}</span>
              <span style={S.chipVal}>{val != null ? `${val} ${f.unit}` : 'N/A'}</span>
            </span>
          );
        })}
        {(limits.pH_min != null || limits.pH_max != null) && (
          <span style={S.chip}>
            <span style={S.chipLabel}>pH</span>
            <span style={S.chipVal}>{limits.pH_min ?? '—'}–{limits.pH_max ?? '—'}</span>
          </span>
        )}
      </div>

      {/* Expanded detail table */}
      {expanded && (
        <div style={{ marginTop: 10, marginBottom: 6, overflowX: 'auto' }}>
          <table style={{ minWidth: 320, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#F9FAFB' }}>
                <th style={S.th}>Parameter</th>
                <th style={S.th}>Limit</th>
                <th style={S.th}>Unit</th>
                <th style={S.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {LIMIT_FIELDS.map(f => {
                const val = limits[f.key];
                return (
                  <tr key={f.key} style={{ borderBottom: '1px solid #F3F4F6' }}>
                    <td style={S.td}>{f.label}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{val != null ? val : '—'}</td>
                    <td style={{ ...S.td, color: '#6B7280' }}>{f.unit}</td>
                    <td style={S.td}>
                      <span style={{ color: val != null ? '#065F46' : '#9CA3AF', fontSize: 11 }}>
                        {val != null ? '✓ Regulated' : 'Not regulated'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      <div style={S.cardActions}>
        <button style={S.textBtn} onClick={() => setExpanded(e => !e)}>
          {expanded ? '▲ Hide limits' : '▼ Show limits'}
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          {!tpl.is_active && canEdit && (
            <button
              style={{ ...S.outlineBtn, color: '#059669', borderColor: '#BBF7D0' }}
              onClick={onActivate}
              disabled={activating}
            >
              {activating ? '…' : '✓ Activate'}
            </button>
          )}
          {canEdit && (
            <button style={S.outlineBtn} onClick={onEdit}>Edit</button>
          )}
          {canDelete && !tpl.is_active && (
            <button
              style={{ ...S.outlineBtn, color: '#DC2626', borderColor: '#FECACA' }}
              onClick={onDelete}
              disabled={deleting}
            >
              {deleting ? '…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── TemplateModal ──────────────────────────────────────────────────────────────

function TemplateModal({ modal, saving, onClose, onSave, onUpdateField, onUpdateLimit }) {
  const isEdit = modal.mode === 'edit';
  const { data } = modal;

  return (
    <div style={S.overlay}>
      <div style={S.modalBox}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>{isEdit ? 'Edit Template' : 'New Permit Template'}</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={S.modalBody}>
          {/* Name */}
          <div style={S.field}>
            <label style={S.label}>Template name *</label>
            <input
              style={S.input}
              value={data.name}
              onChange={e => onUpdateField('name', e.target.value)}
              placeholder="e.g. EPA Secondary, State NPDES Permit"
              maxLength={80}
            />
          </div>

          {/* Description */}
          <div style={S.field}>
            <label style={S.label}>Description</label>
            <input
              style={S.input}
              value={data.description}
              onChange={e => onUpdateField('description', e.target.value)}
              placeholder="Optional — permit number, jurisdiction, notes"
            />
          </div>

          {/* Limits grid */}
          <div style={S.field}>
            <label style={S.label}>Permit limits <span style={{ color: '#9CA3AF', fontWeight: 400 }}>(leave blank = not regulated)</span></label>
            <div style={S.limitsGrid}>
              {LIMIT_FIELDS.map(f => (
                <div key={f.key} style={S.limitItem}>
                  <label style={S.limitLabel}>{f.label}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="number"
                      step={f.step}
                      min={f.min ?? 0}
                      max={f.max}
                      style={S.limitInput}
                      value={data.permit_limits[f.key] ?? ''}
                      onChange={e => onUpdateLimit(f.key, e.target.value)}
                      placeholder="—"
                    />
                    <span style={S.unit}>{f.unit}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Quick presets */}
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>Quick presets: </span>
              {[
                { label: 'EPA Secondary', limits: { BOD: 30, TSS: 30, TN: null, TP: null, NH4: null, NO3: null, pH_min: 6, pH_max: 9 } },
                { label: 'Nutrient Removal', limits: { BOD: 10, TSS: 10, TN: 10, TP: 1, NH4: 3, NO3: 10, pH_min: 6, pH_max: 9 } },
                { label: 'Advanced Treatment', limits: { BOD: 5, TSS: 5, TN: 5, TP: 0.5, NH4: 1, NO3: 5, pH_min: 6.5, pH_max: 8.5 } },
              ].map(preset => (
                <button
                  key={preset.label}
                  style={S.presetBtn}
                  onClick={() => onUpdateField('permit_limits', { ...preset.limits })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={S.modalFooter}>
          <button style={S.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            style={{ ...S.primaryBtn, opacity: saving || !data.name.trim() ? 0.7 : 1 }}
            onClick={onSave}
            disabled={saving || !data.name.trim()}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  page:        { maxWidth: 900, margin: '0 auto', padding: 'clamp(16px, 4vw, 32px) clamp(12px, 3vw, 24px)' },
  pageHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 12, flexWrap: 'wrap' },
  pageTitle:   { fontSize: 'clamp(18px, 4vw, 24px)', fontWeight: 700, color: '#111827', margin: 0 },
  pageSub:     { color: '#6B7280', fontSize: 14, marginTop: 4 },

  section:       { marginBottom: 32 },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  sectionTitle:  { fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 4px' },
  sectionSub:    { fontSize: 13, color: '#6B7280', maxWidth: 560 },

  status: { color: '#9CA3AF', fontSize: 14, padding: '20px 0' },
  empty:  { background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 8, padding: 24, textAlign: 'center', color: '#6B7280', fontSize: 14 },

  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 14 },
  card:     { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 14, transition: 'box-shadow .15s' },
  cardTop:  { display: 'flex', gap: 12, marginBottom: 10 },
  cardTitle:{ fontSize: 14, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 8 },
  cardDesc: { fontSize: 12, color: '#6B7280', marginTop: 2, marginBottom: 4 },
  cardMeta: { fontSize: 11, color: '#9CA3AF' },
  cardActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid #F3F4F6', flexWrap: 'wrap', gap: 8 },

  activeBadge: { fontSize: 10, fontWeight: 700, color: '#065F46', background: '#D1FAE5', borderRadius: 4, padding: '2px 6px' },

  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  chip:    { display: 'inline-flex', alignItems: 'center', gap: 3, background: '#F3F4F6', borderRadius: 4, padding: '2px 6px' },
  chipLabel: { fontSize: 10, fontWeight: 700, color: '#374151' },
  chipVal:   { fontSize: 10, color: '#6B7280' },

  th: { padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#374151', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' },
  td: { padding: '5px 8px', fontSize: 12, color: '#111' },

  roleTable: { border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'hidden' },
  roleRow:   { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr' },
  roleCell:  { padding: '8px 10px', fontSize: 13, color: '#374151', borderRight: '1px solid #F3F4F6' },

  primaryBtn: { background: '#1D4ED8', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 38 },
  outlineBtn: { background: '#fff', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', minHeight: 34 },
  textBtn:    { background: 'none', border: 'none', color: '#6B7280', fontSize: 12, cursor: 'pointer', padding: '4px 0' },
  cancelBtn:  { background: '#F9FAFB', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 6, padding: '9px 16px', fontSize: 13, cursor: 'pointer', minHeight: 38 },
  presetBtn:  { background: '#F0FDF4', color: '#065F46', border: '1px solid #BBF7D0', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', marginRight: 6, marginTop: 4, minHeight: 30 },

  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000 },
  modalBox:  { background: '#fff', borderRadius: '12px 12px 0 0', width: '100%', maxWidth: 600, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 40px rgba(0,0,0,.25)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #E5E7EB' },
  modalTitle: { fontSize: 16, fontWeight: 700, color: '#111' },
  closeBtn:  { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF', minWidth: 36, minHeight: 36 },
  modalBody: { flex: 1, overflowY: 'auto', padding: '16px 20px' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #E5E7EB' },

  field:  { marginBottom: 16 },
  label:  { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input:  { width: '100%', border: '1px solid #D1D5DB', borderRadius: 6, padding: '10px', fontSize: 16 /* prevent iOS zoom */, boxSizing: 'border-box' },

  limitsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  limitItem:  { display: 'flex', flexDirection: 'column', gap: 3 },
  limitLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280' },
  limitInput: { width: '100%', border: '1px solid #D1D5DB', borderRadius: 5, padding: '7px', fontSize: 14 },
  unit:       { fontSize: 11, color: '#9CA3AF' },

  toast: { position: 'fixed', bottom: 72, right: 16, color: '#fff', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,.25)', maxWidth: 'calc(100vw - 32px)' },
};
