/**
 * PidImport — upload a P&ID picture and let AI build the flowsheet from it
 * ─────────────────────────────────────────────────────────────────────────────
 * The user uploads a picture of their P&ID (⋯ → Upload P&ID picture…, or
 * "Import from P&ID" on the project page, which arrives here with `autoRead`)
 * and the server immediately reads it with Claude, returning a PROPOSED flowsheet that
 * is shown here for review. Nothing is created until the user confirms; the
 * canvas then adds the blocks and lines (and, with "Create & simulate", saves
 * and runs). "Build diagram" in the bar at the top-left re-reads the picture.
 *
 * The picture is not drawn on the canvas. Its stored `placement` only sets
 * where the created blocks land: each unit's position in the picture is
 * mapped onto that area of the sheet, so the layout follows the drawing.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * One picture per flowsheet at `…/flowsheets/:id/background`, apart from
 * canvas_data so the autosave never resends it. The browser downsizes the file
 * before upload.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Panel } from 'reactflow';
import { ImagePlus, Trash2, Wand2, Loader2, X } from 'lucide-react';
import api from '../../services/api';
import { PID_ACCEPT, uploadPidPicture, pidErrorText } from '../../utils/pidImage';
import { TAG } from './symbols';

const PidImport = forwardRef(function PidImport({ projectId, flowsheetId, onBuild, autoRead = false, onAutoRead }, ref) {
  const url = `/projects/${projectId}/flowsheets/${flowsheetId}/background`;
  const [pid, setPid] = useState(null);         // { width, height, fileName, placement }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false);
  const [proposal, setProposal] = useState(null); // AI reading awaiting review
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setPid(null);
    api.get(url)
      .then(({ status, data }) => { if (!cancelled && status === 200) setPid(data); })
      .catch(() => { /* no picture is not an error worth showing */ });
    return () => { cancelled = true; };
  }, [url]);

  const openPicker = useCallback(() => fileRef.current?.click(), []);
  useImperativeHandle(ref, () => ({ openPicker }), [openPicker]);

  /** Ask the server to read the stored picture with AI; show the result for review. */
  const readDrawing = async () => {
    setReading(true); setError(null);
    try {
      const { data } = await api.post(`${url}/read`);
      setProposal(data);
    } catch (err) {
      setError(pidErrorText(err));
    } finally {
      setReading(false);
    }
  };

  // Opened from the project page's "Import from P&ID": the picture is already
  // stored, so read it as soon as it has loaded — once, then tell the canvas.
  const autoReadDone = useRef(false);
  useEffect(() => {
    if (!autoRead || !pid || autoReadDone.current) return;
    autoReadDone.current = true;
    onAutoRead?.();
    readDrawing();
  }, [autoRead, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Upload, then start reading straight away: the user lands on the review
  // window without a second click. Build diagram stays in the bar to re-read.
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    let uploaded = false;
    try {
      setPid(await uploadPidPicture(projectId, flowsheetId, file));
      uploaded = true;
    } catch (err) {
      setError(pidErrorText(err));
    } finally {
      setBusy(false);
    }
    if (uploaded) await readDrawing();
  };

  const remove = async () => {
    if (!window.confirm('Remove the P&ID picture from this flowsheet? Blocks already created stay where they are.')) return;
    setBusy(true); setError(null);
    try {
      await api.delete(url);
      setPid(null);
    } catch (err) {
      setError(pidErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const createFromProposal = (simulate) => {
    const p = proposal;
    setProposal(null);
    onBuild?.(p, pid, { simulate });
  };

  return (
    <>
      <input ref={fileRef} type="file" accept={PID_ACCEPT} style={{ display: 'none' }} onChange={onFile} />

      {(pid || busy || error) && (
        <Panel position="top-left">
          <div style={S.bar} className="nodrag">
            <span style={S.title} title={pid?.fileName || 'P&ID picture'}>
              P&amp;ID{pid?.fileName ? ` · ${pid.fileName}` : ''}
            </span>
            {busy && <span style={S.muted}>Uploading…</span>}
            {pid && (
              <>
                <button type="button" style={{ ...S.btn, ...S.btnAi }} onClick={readDrawing} disabled={reading || busy}
                        title="Let AI read the drawing and create the blocks and lines for you">
                  {reading
                    ? <><Loader2 size={13} className="animate-spin" />Reading drawing…</>
                    : <><Wand2 size={13} />Build diagram</>}
                </button>
                <button type="button" style={S.btn} onClick={openPicker} disabled={busy || reading} title="Replace with another picture" aria-label="Replace P&ID">
                  <ImagePlus size={13} />
                </button>
                <button type="button" style={{ ...S.btn, color: '#DC2626' }} onClick={remove} disabled={busy || reading} title="Remove the picture" aria-label="Remove P&ID">
                  <Trash2 size={13} />
                </button>
              </>
            )}
            {error && (
              <span style={S.error} role="alert">
                {error}
                <button type="button" style={S.dismiss} onClick={() => setError(null)} aria-label="Dismiss">✕</button>
              </span>
            )}
          </div>
        </Panel>
      )}

      {proposal && createPortal(
        <ReviewDialog
          proposal={proposal}
          onCancel={() => setProposal(null)}
          onCreate={() => createFromProposal(false)}
          onCreateAndSimulate={() => createFromProposal(true)}
        />,
        document.body,
      )}
    </>
  );
});

/** What the AI found, for the user to confirm before anything is created. */
function ReviewDialog({ proposal, onCancel, onCreate, onCreateAndSimulate }) {
  const { units, connections, skipped, warnings, notes } = proposal;
  const labelOf = Object.fromEntries(units.map((u) => [u.id, u.label]));
  const empty = units.length === 0;
  return (
    <div style={S.backdrop} role="dialog" aria-modal="true" aria-labelledby="pid-review-title">
      <div style={S.dialog}>
        <div style={S.dlgHead}>
          <h2 id="pid-review-title" style={S.dlgTitle}>What the AI found on the drawing</h2>
          <button type="button" style={S.close} onClick={onCancel} aria-label="Close"><X size={16} /></button>
        </div>
        <div style={S.dlgBody}>
          <section>
            <h3 style={S.h3}>Blocks to create ({units.length})</h3>
            {empty ? <p style={S.muted}>None.</p> : (
              <ul style={S.list}>
                {units.map((u) => (
                  <li key={u.id} style={S.item}>
                    <span style={S.tag}>{TAG[u.type] || '—'}</span>
                    <strong>{u.label}</strong>
                    <span style={S.muted}>{u.type.replace(/_/g, ' ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {connections.length > 0 && (
            <section>
              <h3 style={S.h3}>Connections ({connections.length})</h3>
              <ul style={S.list}>
                {connections.map((c, i) => (
                  <li key={i} style={S.item}>
                    {labelOf[c.from]} → {labelOf[c.to]}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {skipped.length > 0 && (
            <section>
              <h3 style={S.h3}>Left out — not simulated ({skipped.length})</h3>
              <ul style={S.list}>
                {skipped.map((s, i) => <li key={i} style={S.item}><span>{s.label}</span><span style={S.muted}>{s.reason}</span></li>)}
              </ul>
            </section>
          )}
          {(warnings.length > 0 || notes) && (
            <section style={S.warnBox}>
              <h3 style={{ ...S.h3, color: '#92400E' }}>Please check</h3>
              {warnings.map((w, i) => <p key={i} style={S.warnLine}>⚠ {w}</p>)}
              {notes && <p style={S.warnLine}>{notes}</p>}
            </section>
          )}
          <p style={S.muted}>
            The blocks are laid out as on the drawing, with default settings. Flows, sizes and pressures are rarely on a P&amp;ID:
            click a block to enter your own values before trusting the results.
          </p>
        </div>
        <div style={S.dlgFoot}>
          <button type="button" style={S.btn} onClick={onCancel}>Cancel</button>
          <button type="button" style={S.btn} onClick={onCreate} disabled={empty}>Create blocks</button>
          <button type="button" style={{ ...S.btn, ...S.btnPrimary }} onClick={onCreateAndSimulate} disabled={empty}>
            Create &amp; simulate
          </button>
        </div>
      </div>
    </div>
  );
}

export default PidImport;

const S = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', maxWidth: 560,
    background: 'rgba(255,255,255,.95)', border: '1px solid #E2E8F0', borderRadius: 8,
    padding: '5px 8px', boxShadow: '0 1px 3px rgba(15,23,42,.08)', fontSize: 12,
  },
  title: { fontWeight: 700, color: '#1F4E79', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  muted: { color: '#64748B' },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 8px',
    border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', color: '#1E293B',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  btnAi: { background: '#1F4E79', color: '#fff', borderColor: '#1F4E79' },
  btnPrimary: { background: '#16A34A', color: '#fff', borderColor: '#16A34A' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  dialog: { background: '#fff', borderRadius: 12, width: 'min(560px, 100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(15,23,42,.3)' },
  dlgHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #E2E8F0' },
  dlgTitle: { fontSize: 16, fontWeight: 700, color: '#0B1220', margin: 0 },
  close: { border: 'none', background: 'none', cursor: 'pointer', color: '#64748B', padding: 4 },
  dlgBody: { padding: '12px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
  dlgFoot: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid #E2E8F0' },
  h3: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#475569', margin: '0 0 6px' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  item: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  tag: { fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 700, color: '#94A3B8', minWidth: 30 },
  warnBox: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px' },
  warnLine: { margin: '2px 0', color: '#92400E' },
  error: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#991B1B', background: '#FEE2E2', borderRadius: 6, padding: '2px 8px' },
  dismiss: { border: 'none', background: 'none', color: '#991B1B', cursor: 'pointer', padding: 0 },
};
