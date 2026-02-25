import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import AppLayout from '../components/layout/AppLayout';
import { SkeletonFlowsheetCard } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { Cpu, Camera } from 'lucide-react';

// ── ProjectPage ────────────────────────────────────────────────────────────────

export default function ProjectPage() {
  const { projectId } = useParams();
  const navigate      = useNavigate();

  const [project, setProject]       = useState(null);
  const [flowsheets, setFlowsheets] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState('flowsheets'); // 'flowsheets' | 'snapshots'
  const [showNew, setShowNew]       = useState(false);
  const [newFs, setNewFs]           = useState({ name: '', description: '' });
  const [creating, setCreating]     = useState(false);
  const [toast, setToast]           = useState(null);

  // Snapshot state
  const [snapTarget, setSnapTarget]   = useState(null);
  const [snapName, setSnapName]       = useState('');
  const [snapping, setSnapping]       = useState(false);
  const [restoring, setRestoring]     = useState(null);
  const [deletingFs, setDeletingFs]   = useState(null);

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchAll = useCallback(async () => {
    try {
      const [proj, fs] = await Promise.all([
        api.get(`/projects/${projectId}`),
        api.get(`/projects/${projectId}/flowsheets`),
      ]);
      setProject(proj.data);
      const all = Array.isArray(fs.data) ? fs.data : (fs.data?.data ?? []);
      setFlowsheets(all);
    } catch {
      navigate('/dashboard');
    } finally {
      setLoading(false);
    }
  }, [projectId, navigate]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Derived lists ────────────────────────────────────────────────────────────
  const liveSheets = flowsheets.filter(f => !f.is_snapshot);
  const snapshots  = flowsheets.filter(f => f.is_snapshot);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const createFlowsheet = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const { data } = await api.post(`/projects/${projectId}/flowsheets`, newFs);
      navigate(`/projects/${projectId}/flowsheets/${data.id}`);
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to create flowsheet', false);
      setCreating(false);
    }
  };

  const takeSnapshot = async (e) => {
    e.preventDefault();
    if (!snapTarget || !snapName.trim()) return;
    setSnapping(true);
    try {
      await api.post(
        `/projects/${projectId}/flowsheets/${snapTarget.id}/snapshot`,
        { name: snapName.trim() }
      );
      showToast(`Snapshot "${snapName}" saved`);
      setSnapTarget(null);
      setSnapName('');
      fetchAll();
    } catch (err) {
      showToast(err.response?.data?.error || 'Snapshot failed', false);
    } finally {
      setSnapping(false);
    }
  };

  const restoreSnapshot = async (snap) => {
    if (!window.confirm(
      `Restore snapshot "${snap.name}" as a new flowsheet?\n\nThis creates a copy — your existing flowsheets are not modified.`
    )) return;
    setRestoring(snap.id);
    try {
      const { data: snapDetail } = await api.get(`/projects/${projectId}/flowsheets/${snap.id}`);
      const restored = await api.post(`/projects/${projectId}/flowsheets`, {
        name: `Restored: ${snap.name}`,
        description: `Restored from snapshot on ${new Date().toLocaleDateString()}`,
        canvas_data: snapDetail.canvas_data ?? snapDetail.data?.canvas_data,
      });
      showToast('Restored as new flowsheet');
      navigate(`/projects/${projectId}/flowsheets/${(restored.data.id ?? restored.data.data?.id)}`);
    } catch (err) {
      showToast(err.response?.data?.error || 'Restore failed', false);
    } finally {
      setRestoring(null);
    }
  };

  const deleteFlowsheet = async (fs) => {
    if (!window.confirm(`Delete "${fs.name}"? This cannot be undone.`)) return;
    setDeletingFs(fs.id);
    try {
      await api.delete(`/projects/${projectId}/flowsheets/${fs.id}`);
      showToast(`"${fs.name}" deleted`);
      fetchAll();
    } catch (err) {
      showToast(err.response?.data?.error || 'Delete failed', false);
    } finally {
      setDeletingFs(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <AppLayout>
      <div style={S.page}>
        <div style={{ ...S.grid, marginTop: 24 }} aria-busy="true" aria-label="Loading flowsheets">
          {[1, 2, 3].map(i => <SkeletonFlowsheetCard key={i} />)}
        </div>
      </div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div style={S.page}>

        {/* Toast */}
        {toast && (
          <div style={{ ...S.toast, background: toast.ok ? '#065F46' : '#991B1B' }}>
            {toast.ok ? '\u2713' : '\u26a0'} {toast.msg}
          </div>
        )}

        {/* Breadcrumb */}
        <div style={S.breadcrumb}>
          <span style={S.bc} onClick={() => navigate('/projects')}>Projects</span>
          <span style={{ color: '#9CA3AF' }}> / </span>
          <span style={{ color: '#111', fontWeight: 600 }}>{project?.name}</span>
        </div>

        {/* Header */}
        <div style={S.headerRow}>
          <div>
            <h1 style={S.title}>{project?.name}</h1>
            {project?.description && <p style={S.desc}>{project.description}</p>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...S.newBtn, background: '#F3F4F6', color: '#374151', border: '1px solid #D1D5DB' }}
              onClick={() => navigate(`/projects/${projectId}/settings`)}
            >⚙ Cost Settings</button>
            {tab === 'flowsheets' && (
              <button style={S.newBtn} onClick={() => setShowNew(true)}>+ New Flowsheet</button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div
          style={S.tabs}
          role="tablist"
          aria-label="Project sections"
          onKeyDown={e => {
            if (e.key === 'ArrowRight') { e.preventDefault(); setTab(tab === 'flowsheets' ? 'snapshots' : 'flowsheets'); }
            if (e.key === 'ArrowLeft')  { e.preventDefault(); setTab(tab === 'snapshots' ? 'flowsheets' : 'snapshots'); }
          }}
        >
          <button
            role="tab"
            aria-selected={tab === 'flowsheets'}
            aria-controls="panel-flowsheets"
            id="tab-flowsheets"
            style={{ ...S.tab, ...(tab === 'flowsheets' ? S.tabActive : {}) }}
            onClick={() => setTab('flowsheets')}
          >
            📄 Flowsheets
            <span style={S.tabBadge} aria-label={`${liveSheets.length} flowsheets`}>{liveSheets.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'snapshots'}
            aria-controls="panel-snapshots"
            id="tab-snapshots"
            style={{ ...S.tab, ...(tab === 'snapshots' ? S.tabActive : {}) }}
            onClick={() => setTab('snapshots')}
          >
            📸 Snapshots
            <span style={S.tabBadge} aria-label={`${snapshots.length} snapshots`}>{snapshots.length}</span>
          </button>
        </div>

        {/* Flowsheets tab */}
        {tab === 'flowsheets' && (
          <div id="panel-flowsheets" role="tabpanel" aria-labelledby="tab-flowsheets" style={S.grid}>
            {liveSheets.length === 0 ? (
              <div style={{ gridColumn: '1/-1' }}>
                <EmptyState
                  icon={Cpu}
                  title="No flowsheets yet"
                  description='Click "New Flowsheet" to start designing your treatment process.'
                  action={{ label: '+ New Flowsheet', onClick: () => setShowNew(true) }}
                />
              </div>
            ) : liveSheets.map(fs => (
              <FlowsheetCard
                key={fs.id}
                fs={fs}
                onOpen={() => navigate(`/projects/${projectId}/flowsheets/${fs.id}`)}
                onSnapshot={() => { setSnapTarget(fs); setSnapName(`${fs.name} — ${new Date().toLocaleDateString()}`); }}
                onDelete={() => deleteFlowsheet(fs)}
                deleting={deletingFs === fs.id}
              />
            ))}
          </div>
        )}

        {/* Snapshots tab */}
        {tab === 'snapshots' && (
          <div id="panel-snapshots" role="tabpanel" aria-labelledby="tab-snapshots">
            {snapshots.length === 0 ? (
              <EmptyState
                icon={Camera}
                title="No snapshots saved"
                description="Snapshots are read-only checkpoints. Open a flowsheet and click Save Snapshot, or use the quick buttons below."
              />
            ) : (
              <div style={S.grid}>
                {snapshots.map(snap => (
                  <SnapshotCard
                    key={snap.id}
                    snap={snap}
                    onRestore={() => restoreSnapshot(snap)}
                    onDelete={() => deleteFlowsheet(snap)}
                    restoring={restoring === snap.id}
                    deleting={deletingFs === snap.id}
                  />
                ))}
              </div>
            )}

            {liveSheets.length > 0 && (
              <div style={S.snapshotQuickBar}>
                <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>Quick snapshot: </span>
                {liveSheets.map(fs => (
                  <button
                    key={fs.id}
                    style={S.quickSnapBtn}
                    aria-label={`Save snapshot of ${fs.name}`}
                    onClick={() => { setSnapTarget(fs); setSnapName(`${fs.name} — ${new Date().toLocaleDateString()}`); }}
                  >
                    📸 {fs.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New Flowsheet Modal */}
      {showNew && (
        <div style={S.overlay} role="dialog" aria-modal="true" aria-labelledby="new-flowsheet-title" onKeyDown={e => e.key === 'Escape' && setShowNew(false)}>
          <div style={S.modal}>
            <h2 id="new-flowsheet-title" style={S.modalTitle}>New Flowsheet</h2>
            <form onSubmit={createFlowsheet}>
              <label style={S.label} htmlFor="fs-name">Flowsheet name *</label>
              <input id="fs-name" style={S.input} value={newFs.name}
                onChange={e => setNewFs(f => ({ ...f, name: e.target.value }))} required placeholder="Main Treatment Train" autoFocus />
              <label style={S.label} htmlFor="fs-desc">Description</label>
              <input id="fs-desc" style={S.input} value={newFs.description}
                onChange={e => setNewFs(f => ({ ...f, description: e.target.value }))} placeholder="Optional" />
              <div style={S.modalBtns}>
                <button type="button" style={S.cancelBtn} onClick={() => setShowNew(false)}>Cancel</button>
                <button type="submit" style={S.submitBtn} disabled={creating} aria-busy={creating}>
                  {creating ? 'Creating…' : 'Create & Open'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Snapshot Modal */}
      {snapTarget && (
        <div style={S.overlay} role="dialog" aria-modal="true" aria-labelledby="snapshot-title" onKeyDown={e => e.key === 'Escape' && setSnapTarget(null)}>
          <div style={S.modal}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 id="snapshot-title" style={S.modalTitle}>Save Snapshot</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9CA3AF' }}
                onClick={() => setSnapTarget(null)} aria-label="Close snapshot dialog">&times;</button>
            </div>

            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#065F46' }}>
              Capturing: <strong>{snapTarget.name}</strong> (v{snapTarget.version})
            </div>

            <form onSubmit={takeSnapshot}>
              <label style={S.label}>Snapshot name *</label>
              <input
                style={S.input}
                value={snapName}
                onChange={e => setSnapName(e.target.value)}
                required
                placeholder="e.g. Before SRT change, Design Review v1"
                autoFocus
              />
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: -8, marginBottom: 16 }}>
                A read-only copy of the current canvas is saved. You can restore it later as a new flowsheet.
              </p>
              <div style={S.modalBtns}>
                <button type="button" style={S.cancelBtn} onClick={() => setSnapTarget(null)}>Cancel</button>
                <button
                  type="submit"
                  style={{ ...S.submitBtn, background: '#059669', opacity: snapping || !snapName.trim() ? 0.7 : 1 }}
                  disabled={snapping || !snapName.trim()}
                >
                  {snapping ? 'Saving\u2026' : 'Save Snapshot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

// ── FlowsheetCard ──────────────────────────────────────────────────────────────

function FlowsheetCard({ fs, onOpen, onSnapshot, onDelete, deleting }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      style={{ ...S.card, cursor: 'pointer', boxShadow: hover ? '0 4px 12px rgba(0,0,0,0.12)' : S.card.boxShadow }}
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={S.cardHeader}>
        <span style={S.cardTitle}>{fs.name}</span>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          {hover && (
            <>
              <button title="Save snapshot" style={S.iconBtn} onClick={e => { e.stopPropagation(); onSnapshot(); }}>
                \u{1F4F8}
              </button>
              <button title="Delete flowsheet" style={{ ...S.iconBtn, color: '#DC2626' }}
                onClick={e => { e.stopPropagation(); onDelete(); }} disabled={deleting}>
                {deleting ? '\u2026' : '\u{1F5D1}'}
              </button>
            </>
          )}
        </div>
      </div>
      {fs.description && <p style={S.cardDesc}>{fs.description}</p>}
      <div style={S.cardMeta}>
        <span>v{fs.version}</span>
        <span>\u00b7</span>
        <span>{fs.created_by_name || 'Unknown'}</span>
        <span>\u00b7</span>
        <span>{new Date(fs.updated_at).toLocaleDateString()}</span>
      </div>
      {hover && <div style={{ marginTop: 10 }}><span style={S.openHint}>Open \u2192</span></div>}
    </div>
  );
}

// ── SnapshotCard ──────────────────────────────────────────────────────────────

function SnapshotCard({ snap, onRestore, onDelete, restoring, deleting }) {
  return (
    <div style={{ ...S.card, borderLeft: '4px solid #059669', cursor: 'default' }}>
      <div style={S.cardHeader}>
        <span style={S.cardTitle}>{snap.name}</span>
        <span style={{ fontSize: 11, background: '#D1FAE5', color: '#065F46', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
          SNAP
        </span>
      </div>
      {snap.description && <p style={S.cardDesc}>{snap.description}</p>}
      <div style={S.cardMeta}>
        <span>v{snap.version}</span>
        <span>\u00b7</span>
        <span>{snap.created_by_name || 'Unknown'}</span>
        <span>\u00b7</span>
        <span>{new Date(snap.created_at).toLocaleDateString()}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button style={S.restoreBtn} onClick={onRestore} disabled={restoring} title="Restore as a new flowsheet">
          {restoring ? 'Restoring\u2026' : '\u21a9 Restore as Flowsheet'}
        </button>
        <button style={{ ...S.iconBtn, color: '#DC2626', fontSize: 16 }} onClick={onDelete} disabled={deleting} title="Delete snapshot">
          {deleting ? '\u2026' : '\u{1F5D1}'}
        </button>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

// Responsive helper: clamp padding based on viewport
const isMobile = () => typeof window !== 'undefined' && window.innerWidth < 640;

const S = {
  page:       { padding: 'clamp(16px, 4vw, 40px)', maxWidth: 1100, margin: '0 auto' },
  breadcrumb: { fontSize: 14, color: '#6B7280', marginBottom: 20 },
  bc:         { cursor: 'pointer', color: '#2E75B6', fontWeight: 500 },
  headerRow:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 12, flexWrap: 'wrap' },
  title:      { fontSize: 'clamp(18px, 4vw, 26px)', fontWeight: 700, color: '#111', margin: 0 },
  desc:       { color: '#6B7280', marginTop: 4, fontSize: 14 },
  newBtn:     { background: '#1F4E79', color: '#fff', border: 'none', borderRadius: 7, padding: '10px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 14, flexShrink: 0, minHeight: 40 },

  tabs:      { display: 'flex', gap: 0, marginBottom: 24, borderBottom: '2px solid #E5E7EB', overflowX: 'auto' },
  tab:       { background: 'none', border: 'none', padding: '10px 16px', fontSize: 14, fontWeight: 500, color: '#6B7280', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '2px solid transparent', marginBottom: -2, whiteSpace: 'nowrap' },
  tabActive: { color: '#1D4ED8', borderBottomColor: '#1D4ED8', fontWeight: 700 },
  tabBadge:  { background: '#E5E7EB', color: '#374151', fontSize: 11, fontWeight: 700, borderRadius: 10, padding: '1px 7px' },

  grid:       { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 16 },
  card:       { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '16px 18px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', transition: 'box-shadow .15s' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle:  { fontSize: 15, fontWeight: 700, color: '#111' },
  cardDesc:   { fontSize: 13, color: '#6B7280', margin: '0 0 10px', lineHeight: 1.5 },
  cardMeta:   { display: 'flex', gap: 8, fontSize: 12, color: '#9CA3AF', flexWrap: 'wrap' },
  emptyCard:  { gridColumn: '1/-1', padding: '40px 24px', textAlign: 'center', background: '#fff', borderRadius: 10, border: '1px dashed #D1D5DB' },
  openHint:   { fontSize: 12, color: '#2563EB', fontWeight: 600 },

  iconBtn:    { background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '6px', borderRadius: 4, color: '#374151', minWidth: 32, minHeight: 32 },
  restoreBtn: { background: '#F0FDF4', color: '#065F46', border: '1px solid #BBF7D0', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  snapshotQuickBar: { marginTop: 24, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 16px' },
  quickSnapBtn:     { background: '#fff', border: '1px solid #D1D5DB', borderRadius: 5, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: '#374151', minHeight: 36 },

  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100 },
  modal:      { background: '#fff', borderRadius: '12px 12px 0 0', padding: 'clamp(20px, 5vw, 36px)', width: '100%', maxWidth: 520, boxShadow: '0 -4px 40px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' },
  modalTitle: { fontSize: 20, fontWeight: 700, margin: '0 0 4px', color: '#111' },
  label:      { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:      { width: '100%', padding: '10px 12px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 16 /* prevents iOS zoom */, marginBottom: 14, boxSizing: 'border-box' },
  modalBtns:  { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  cancelBtn:  { padding: '10px 18px', background: '#F3F4F6', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, minHeight: 40 },
  submitBtn:  { padding: '10px 18px', background: '#1F4E79', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, minHeight: 40 },

  toast: { position: 'fixed', bottom: 80, right: 16, left: 'auto', color: '#fff', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,.25)', maxWidth: 'calc(100vw - 32px)' },
};
