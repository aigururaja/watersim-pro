import { useMemo } from 'react';
import { Plus, BellRing, BellOff, Bell } from 'lucide-react';
import {
  severityMeta, describeRule, relTime, absTime, isActiveEvent,
} from './alarmState';

/**
 * AlarmsPanel — the canvas right-rail "Alarms" tab.
 *
 * Three sections, in the order an operator asks the questions:
 *   1. what limits exist on this flowsheet, and which are breaching NOW
 *   2. what WOULD fire on the values currently on screen (preview only)
 *   3. what has happened recently
 *
 * Section 2 is visually distinct from section 1 on purpose: a preview breach is
 * a consequence of an unsaved edit, not an event that occurred. Painting the two
 * the same would let a what-if look like a plant record.
 */
export default function AlarmsPanel({
  rules,
  events,
  previewById,
  activeById,
  nodeLabels,
  canEdit,
  loading,
  onAdd,
  onEditRule,
  onClose,
}) {
  const recent = useMemo(() => (events || []).slice(0, 20), [events]);

  const previewOnly = useMemo(
    () => (rules || []).filter((r) => previewById?.has(String(r.id)) && !activeById?.has(String(r.id))),
    [rules, previewById, activeById]
  );

  return (
    <div>
      <div style={S.panelHdr}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>Alarms</div>
        <button style={S.closeBtn} onClick={onClose} aria-label="Close alarms panel">✕</button>
      </div>

      {/* ── Rules ──────────────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secHead}>
          <div style={S.secTitle}>Rules on this flowsheet</div>
          {canEdit && (
            <button type="button" onClick={onAdd} style={S.addBtn}>
              <Plus size={12} />Add alarm rule
            </button>
          )}
        </div>

        {loading && !rules?.length && (
          <p style={S.muted}>Loading alarm rules…</p>
        )}

        {!loading && !rules?.length && (
          <p style={S.muted}>
            No alarm limits set. {canEdit
              ? 'Add one here, or click the 🔔 on any parameter in the Node tab.'
              : 'An engineer can set limits on any parameter of this flowsheet.'}
          </p>
        )}

        {(rules || []).map((rule) => {
          const id = String(rule.id);
          const active = activeById?.get(id);
          const would = !active && previewById?.get(id);
          const sev = severityMeta(active?.severity || rule.severity);
          const disabled = rule.enabled === false;

          return (
            <div
              key={id}
              style={{
                ...S.ruleRow,
                borderLeft: `3px solid ${active ? sev.color : disabled ? '#E5E7EB' : '#CBD5E1'}`,
                background: active ? sev.bg : 'transparent',
                opacity: disabled ? 0.6 : 1,
              }}
              data-rule-state={active ? 'active' : would ? 'would' : disabled ? 'disabled' : 'ok'}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={S.ruleName}>
                  {active ? <BellRing size={12} color={sev.color} aria-hidden="true" />
                    : disabled ? <BellOff size={12} color="#9CA3AF" aria-hidden="true" />
                      : <Bell size={12} color="#9CA3AF" aria-hidden="true" />}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{rule.name}</span>
                </div>
                <div style={S.ruleDesc}>{describeRule(rule, nodeLabels)}</div>
                {active && (
                  <div style={{ ...S.ruleState, color: sev.color }}>
                    {sev.label} · active {relTime(active.triggeredAt)}
                    <span style={S.ruleMsg} title={absTime(active.triggeredAt)}>{active.message}</span>
                  </div>
                )}
                {would && (
                  <div style={S.wouldChip}>
                    would fire — {would.message}
                  </div>
                )}
                {disabled && <div style={S.ruleState}>disabled</div>}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onEditRule(rule)}
                  style={S.editBtn}
                  aria-label={`Edit alarm rule ${rule.name}`}
                >
                  Edit
                </button>
              )}
            </div>
          );
        })}

        {previewOnly.length > 0 && (
          <div style={S.previewNote}>
            {previewOnly.length} rule{previewOnly.length === 1 ? '' : 's'} would fire on the
            values currently on the canvas. Nothing is recorded until a real run.
          </div>
        )}
      </div>

      {/* ── Recent events ──────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Recent events</div>
        {!recent.length && <p style={S.muted}>No alarm events on this flowsheet yet.</p>}
        {recent.map((e) => {
          const sev = severityMeta(e.severity);
          const open = isActiveEvent(e);
          return (
            <div key={e.id} style={S.eventRow}>
              <span
                style={{ ...S.sevPill, background: sev.bg, color: sev.color, borderColor: sev.border }}
                title={`${sev.label} · ${open ? 'active' : 'cleared'}`}
              >
                {sev.label}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={S.eventMsg}>{e.message}</div>
                <div style={S.eventMeta} title={absTime(e.triggeredAt)}>
                  {e.ruleName ? `${e.ruleName} · ` : ''}
                  {open ? 'active' : `cleared ${relTime(e.clearedAt)}`}
                  {' · '}{relTime(e.triggeredAt)}
                  {e.source === 'plc' ? ' · PLC' : ''}
                </div>
              </div>
              {open && <span style={{ ...S.dot, background: sev.color }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const S = {
  panelHdr: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #E5E7EB' },
  closeBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 },
  section: { padding: '10px 14px', borderBottom: '1px solid #F3F4F6' },
  secHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  secTitle: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 },
  addBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', marginBottom: 6, flexShrink: 0 },
  muted: { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic', margin: '2px 0 0' },
  ruleRow: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, marginBottom: 5 },
  ruleName: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: '#111827', minWidth: 0 },
  ruleDesc: { fontSize: 11, color: '#6B7280', marginTop: 1 },
  ruleState: { fontSize: 10.5, fontWeight: 600, marginTop: 2, color: '#9CA3AF' },
  ruleMsg: { display: 'block', fontWeight: 400, color: '#374151', marginTop: 1 },
  wouldChip: { display: 'inline-block', marginTop: 3, fontSize: 10.5, fontWeight: 600, color: '#92400E', background: 'transparent', border: '1px dashed #FCD34D', borderRadius: 4, padding: '1px 6px' },
  editBtn: { background: 'none', border: 'none', color: '#2E75B6', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: '2px 4px', flexShrink: 0 },
  previewNote: { marginTop: 6, fontSize: 10.5, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '5px 8px' },
  eventRow: { display: 'flex', alignItems: 'flex-start', gap: 7, padding: '5px 0', borderBottom: '1px solid #F8FAFC' },
  sevPill: { fontSize: 9.5, fontWeight: 700, borderRadius: 10, padding: '1px 6px', border: '1px solid', flexShrink: 0, lineHeight: '14px' },
  eventMsg: { fontSize: 11.5, color: '#111827', lineHeight: 1.35 },
  eventMeta: { fontSize: 10, color: '#9CA3AF', marginTop: 1 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 4 },
};
