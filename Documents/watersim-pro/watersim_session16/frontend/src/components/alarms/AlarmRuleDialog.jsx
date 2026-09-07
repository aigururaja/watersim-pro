import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import {
  SEVERITIES, severityMeta, targetKey, ruleKey,
  describeRule, limitError, serverErrorMessage,
} from './alarmState';

/**
 * AlarmRuleDialog — create or edit one alarm rule.
 *
 * Structurally the sibling of PLCBindDialog: same overlay, same
 * `Promise.allSettled` load, same error box, same footer, same `S` style table.
 *
 * ── THE TARGET PICKER IS THE POINT ───────────────────────────────────────────
 * The product rule is "limits only on valid parameters", and the backend derives
 * the legal set from the flowsheet's own canvas (GET /alarm-targets — 189 rows on
 * the demo train). This dialog is the reason a user can never *reach* an invalid
 * target, rather than merely being told off for one:
 *
 *   1. The option list is built ONLY from the fetched `targets` array. Nothing
 *      constructs an option from anything the user typed.
 *   2. The <select>'s value is a `targetKey`, not a parameter name. A key is
 *      meaningless unless it matches a row the server sent.
 *   3. On submit the key is resolved BACK through the same array
 *      (`targets.find(t => targetKey(t) === selectedKey)`), and the POST body is
 *      assembled from that resolved row's own fields — never from form text.
 *   4. `canSave` is false while that resolution yields nothing, so the button
 *      cannot even be pressed with an unresolvable target.
 *
 * The filter box narrows which of the server's options are *rendered*. It is not
 * a target field: it has no path into the payload at all, and clearing it brings
 * every option back. There is deliberately NO "advanced / type it yourself" mode.
 *
 * The server's 422 and 409 messages are surfaced VERBATIM — they name the fault
 * ("'chamberType' is not a numeric parameter of a Grit Chamber (valid: HRT_min)")
 * and were written to be read by users.
 */

const GROUPS = [
  { type: 'param', label: 'Node parameters', hint: 'A numeric setting on a unit — the value you typed in' },
  { type: 'node_output', label: 'Water leaving a node', hint: 'Quality of the stream flowing out of a unit' },
  { type: 'effluent', label: 'Plant effluent', hint: 'Quality of the final discharge' },
];

/** Case-insensitive substring match across everything a user might type. */
function matchesFilter(t, needle) {
  if (!needle) return true;
  const hay = `${t.label} ${t.nodeLabel} ${t.paramKey} ${t.kind}`.toLowerCase();
  return hay.includes(needle);
}

export default function AlarmRuleDialog({
  projectId, flowsheetId,
  rule,                  // existing alarm_rules row, or null to create
  prefill,               // { targetType, nodeId, paramKey } from a param row's bell
  onClose, onSaved, onDeleted,
}) {
  const editing = !!rule?.id;

  const [targets, setTargets] = useState(null);   // null = loading
  const [loadError, setLoadError] = useState(null);

  // The selected target is held as a KEY, resolved through `targets` on save.
  const [selectedKey, setSelectedKey] = useState(() => {
    if (rule) return ruleKey(rule);
    if (prefill) return targetKey(prefill);
    return '';
  });
  const [filter, setFilter] = useState('');

  const [name, setName] = useState(rule?.name ?? '');
  const [minValue, setMinValue] = useState(rule?.min_value ?? rule?.minValue ?? '');
  const [maxValue, setMaxValue] = useState(rule?.max_value ?? rule?.maxValue ?? '');
  // Since Phase 1 a rule is ONE limit. A value rule's kind (high, low, range)
  // follows from which limits are filled — the server settles it — so a
  // HIGH-critical rule and a LOW-warning rule can sit on the same target. The
  // comms-loss (quality) rule is the other kind: it watches a PLC-bound point
  // going quiet, and has a time limit instead of a value limit.
  const [kind, setKind] = useState(() => ((rule?.kind ?? rule?.kindOf) === 'quality' ? 'quality' : 'value'));
  const [staleAfterS, setStaleAfterS] = useState(rule?.stale_after_s ?? rule?.staleAfterS ?? 60);
  const [severity, setSeverity] = useState(rule?.severity ?? 'warning');
  // Task policy (Phase 2). Sent only when the person touched it (or wants a
  // task on a new rule), so an untouched rule's PATCH carries the same body
  // it always did. A new critical rule defaults to raising a task.
  const [createTask, setCreateTask] = useState(rule ? !!(rule.create_task ?? rule.createTask) : (rule?.severity ?? 'warning') === 'critical');
  const [taskRole, setTaskRole] = useState(rule?.task_assignee_role ?? rule?.taskAssigneeRole ?? 'engineer');
  const [taskDueH, setTaskDueH] = useState(rule?.task_due_within_h ?? rule?.taskDueWithinH ?? '');
  const [taskApproval, setTaskApproval] = useState(rule ? (rule.task_requires_approval ?? rule.taskRequiresApproval ?? true) : true);
  const policyTouched = useRef(false);
  const touchPolicy = (fn) => (v) => { policyTouched.current = true; fn(v); };
  const [enabled, setEnabled] = useState(rule ? rule.enabled !== false : true);
  // True once the user has typed a name, so the auto-suggested name stops
  // following the target picker and never overwrites their words.
  const nameTouched = useRef(!!rule?.name);

  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);

  // ── Load the legal targets ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [res] = await Promise.allSettled([
        api.get(`/projects/${projectId}/flowsheets/${flowsheetId}/alarm-targets`),
      ]);
      if (cancelled) return;
      if (res.status === 'fulfilled' && Array.isArray(res.value.data)) {
        setTargets(res.value.data);
      } else {
        setTargets([]);
        setLoadError('Could not load the alarm targets for this flowsheet. Without them no rule can be created — try again in a moment.');
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, flowsheetId]);

  // ── Grouping + filtering ──────────────────────────────────────────────────
  const needle = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const list = targets || [];
    return GROUPS.map((g) => ({
      ...g,
      total: list.filter((t) => t.targetType === g.type).length,
      items: list.filter((t) => t.targetType === g.type && matchesFilter(t, needle)),
    }));
  }, [targets, needle]);

  const shownCount = groups.reduce((n, g) => n + g.items.length, 0);
  const totalCount = groups.reduce((n, g) => n + g.total, 0);

  /**
   * THE resolution step. Everything downstream reads this object, so a key that
   * does not name a server-supplied row simply yields `null` and the save is
   * blocked.
   */
  const selectedTarget = useMemo(
    () => (targets || []).find((t) => targetKey(t) === selectedKey) || null,
    [targets, selectedKey]
  );

  // Editing a rule whose node has since been deleted from the canvas: the target
  // no longer exists, so it is NOT offered as an option. The rule's own target is
  // still described, and the target fields are simply left out of the PATCH.
  const orphanTarget = editing && targets != null && !selectedTarget && selectedKey === ruleKey(rule);

  // A filter that hides the current selection would silently submit something
  // the user cannot see — surfaced rather than auto-cleared.
  const selectionHidden = !!selectedTarget && !matchesFilter(selectedTarget, needle);

  // Suggest a name from the target until the user types their own.
  useEffect(() => {
    if (nameTouched.current || !selectedTarget) return;
    setName(selectedTarget.label);
  }, [selectedTarget]);

  // ── Validation (the same rule the server applies) ─────────────────────────
  const isQuality = kind === 'quality';
  const effTargetType = selectedTarget?.targetType ?? rule?.target_type ?? rule?.targetType;
  const limitMsg = isQuality
    ? (!(Number(staleAfterS) >= 5 && Number(staleAfterS) <= 86400)
        ? 'Comms-loss needs a limit between 5 and 86400 seconds'
        : effTargetType !== 'param'
          ? 'A comms-loss rule watches a node parameter that a PLC tag is bound to'
          : null)
    : limitError(minValue, maxValue);
  const targetOk = !!selectedTarget || orphanTarget;
  const canSave = !saving && !removing && targetOk && name.trim() !== '' && !limitMsg;

  const toLimit = (v) => (v === '' || v == null ? null : Number(v));
  // A comms-loss rule carries no value limits, whatever the boxes once held.
  const wireMin = isQuality ? null : toLimit(minValue);
  const wireMax = isQuality ? null : toLimit(maxValue);

  const save = async (e) => {
    e?.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // A value rule sends only its limits — the server settles high / low /
      // range from them, exactly as before Phase 1. Only the comms-loss rule
      // names its kind and carries a time limit.
      const base = {
        name: name.trim(),
        minValue: wireMin,
        maxValue: wireMax,
        ...(isQuality ? { kind: 'quality', staleAfterS: Number(staleAfterS) } : {}),
        severity,
        enabled,
        ...(policyTouched.current || (!editing && createTask) ? {
          createTask,
          taskAssigneeRole: createTask ? taskRole : null,
          taskRequiresApproval: createTask ? taskApproval : true,
          taskDueWithinH: createTask && taskDueH !== '' && Number.isFinite(Number(taskDueH)) ? Number(taskDueH) : null,
        } : {}),
      };
      if (editing) {
        // Target fields go on the wire only when the selection actually moved,
        // so re-saving a rule whose node was deleted edits the limits without
        // tripping the server's (correct) "node is not on this flowsheet".
        const moved = !!selectedTarget && ruleKey(rule) !== targetKey(selectedTarget);
        const body = moved
          ? { ...base, targetType: selectedTarget.targetType, nodeId: selectedTarget.nodeId, paramKey: selectedTarget.paramKey }
          : base;
        const { data } = await api.patch(
          `/projects/${projectId}/flowsheets/${flowsheetId}/alarms/${rule.id}`, body
        );
        onSaved?.(data);
      } else {
        // Assembled from the RESOLVED target row, never from typed text.
        const { data } = await api.post(
          `/projects/${projectId}/flowsheets/${flowsheetId}/alarms`,
          {
            ...base,
            targetType: selectedTarget.targetType,
            nodeId: selectedTarget.nodeId,
            paramKey: selectedTarget.paramKey,
          }
        );
        onSaved?.(data);
      }
    } catch (err) {
      // 422 (bad target / bad limits) and 409 (duplicate target) are shown as
      // the server worded them.
      setError(serverErrorMessage(err, 'Could not save this alarm rule'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!window.confirm(`Delete the alarm rule "${rule.name}"? Its event history is kept.`)) return;
    setRemoving(true);
    setError(null);
    try {
      await api.delete(`/projects/${projectId}/flowsheets/${flowsheetId}/alarms/${rule.id}`);
      onDeleted?.(rule);
    } catch (err) {
      setError(serverErrorMessage(err, 'Could not delete this alarm rule'));
      setRemoving(false);
    }
  };

  // Live preview of the sentence this rule will read as.
  const preview = describeRule(
    {
      targetType: selectedTarget?.targetType ?? rule?.target_type,
      nodeId: selectedTarget?.nodeId ?? rule?.node_id,
      paramKey: selectedTarget?.paramKey ?? rule?.param_key,
      kind: isQuality ? 'quality' : undefined,
      staleAfterS: isQuality ? Number(staleAfterS) : null,
      minValue: wireMin,
      maxValue: wireMax,
    },
    selectedTarget ? { [selectedTarget.nodeId]: selectedTarget.nodeLabel } : undefined
  );

  const sev = severityMeta(severity);

  return (
    <div style={S.overlay} role="dialog" aria-modal="true"
      aria-label={editing ? 'Edit alarm rule' : 'Add alarm rule'}>
      <div style={S.box}>
        <div style={S.header}>
          <h2 style={S.title}>🔔 {editing ? 'Edit alarm rule' : 'Add alarm rule'}</h2>
          <button style={S.closeBtn} onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div style={S.context}>
          Alarms can only be placed on parameters this flowsheet actually has.
          {totalCount > 0 && <> {totalCount} target{totalCount === 1 ? '' : 's'} available.</>}
        </div>

        {error && <div style={S.errorBox} role="alert">⚠ {error}</div>}
        {loadError && <div style={S.warnBox}>{loadError}</div>}

        <form onSubmit={save}>
          {/* ── Target ─────────────────────────────────────────────────── */}
          <label style={S.label} htmlFor="alarm-target-filter">What to watch *</label>

          <input
            id="alarm-target-filter"
            type="search"
            style={S.input}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter targets — node name, parameter…"
            aria-label="Filter targets"
            aria-describedby="alarm-target-filter-hint"
            autoComplete="off"
          />
          <div id="alarm-target-filter-hint" style={S.hint}>
            {targets === null
              ? 'Loading targets…'
              : `Showing ${shownCount} of ${totalCount} — the filter narrows the list below; it never creates a target.`}
          </div>

          {targets !== null && totalCount === 0 ? (
            <div style={S.warnBox}>
              This flowsheet has no alarmable parameters yet. Add unit operations to
              the canvas first.
            </div>
          ) : (
            <select
              id="alarm-target"
              style={{ ...S.input, marginBottom: 6 }}
              size={8}
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              aria-label="Alarm target"
              disabled={targets === null}
            >
              {selectedKey === '' && <option value="">— choose a parameter —</option>}
              {orphanTarget && (
                <option value={selectedKey}>
                  {describeRule(rule)} (no longer on this flowsheet)
                </option>
              )}
              {groups.map((g) => (
                g.items.length > 0 && (
                  <optgroup key={g.type} label={`${g.label} (${g.items.length})`} title={g.hint}>
                    {g.items.map((t) => (
                      <option key={targetKey(t)} value={targetKey(t)}>
                        {t.targetType === 'effluent'
                          ? `${t.paramKey} — ${t.label}`
                          : `${t.nodeLabel} · ${t.paramKey} — ${t.label}`}
                      </option>
                    ))}
                  </optgroup>
                )
              ))}
            </select>
          )}

          {targets !== null && totalCount > 0 && shownCount === 0 && (
            <div style={S.hint}>
              Nothing matches “{filter}”. Clear the filter to see all {totalCount} targets.
            </div>
          )}
          {selectionHidden && (
            <div style={S.noteBox}>
              The selected target is hidden by the current filter — it is still what
              will be saved: <strong>{selectedTarget.label}</strong>
            </div>
          )}
          {orphanTarget && (
            <div style={S.warnBox}>
              This rule points at a node that is no longer on the canvas. You can
              still edit its limits, or pick a new target above.
            </div>
          )}
          {/* ── Name ───────────────────────────────────────────────────── */}
          <label style={S.label} htmlFor="alarm-name">Name *</label>
          <input
            id="alarm-name"
            style={S.input}
            value={name}
            onChange={(e) => { nameTouched.current = true; setName(e.target.value); }}
            placeholder="e.g. Effluent nitrogen over permit"
            maxLength={120}
          />

          {/* ── Kind ───────────────────────────────────────────────────── */}
          <label style={S.label} htmlFor="alarm-kind">Limit type</label>
          <select
            id="alarm-kind"
            style={S.input}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="value">Value limit — a minimum, a maximum, or both</option>
            <option value="quality">Comms loss — the PLC point has gone quiet</option>
          </select>

          {/* ── Limits ─────────────────────────────────────────────────── */}
          {isQuality ? (
            <div>
              <label style={S.label} htmlFor="alarm-stale">Raise after (seconds without a good sample)</label>
              <input
                id="alarm-stale"
                type="number" step="1" min="5" max="86400" style={S.input}
                value={staleAfterS}
                onChange={(e) => setStaleAfterS(e.target.value)}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={S.label} htmlFor="alarm-min">Minimum</label>
                <input
                  id="alarm-min"
                  type="number" step="any" style={S.input}
                  value={minValue}
                  onChange={(e) => setMinValue(e.target.value)}
                  placeholder="no lower limit"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={S.label} htmlFor="alarm-max">Maximum</label>
                <input
                  id="alarm-max"
                  type="number" step="any" style={S.input}
                  value={maxValue}
                  onChange={(e) => setMaxValue(e.target.value)}
                  placeholder="no upper limit"
                />
              </div>
            </div>
          )}
          {limitMsg ? (
            <div style={S.noteBox} role="status">{limitMsg}</div>
          ) : (
            <div style={S.hint}>
              {isQuality
                ? 'Raises while no good PLC sample has arrived for this long; clears on the next good read. Needs a PLC binding on the target.'
                : 'Set at least one. A maximum alone is a HIGH rule, a minimum alone a LOW rule, both a RANGE — and a second rule of another kind may share the target, so HIGH-critical can sit beside LOW-warning.'}
            </div>
          )}

          {/* ── Severity ───────────────────────────────────────────────── */}
          <label style={S.label} htmlFor="alarm-severity">Severity</label>
          <select
            id="alarm-severity"
            style={{ ...S.input, borderLeft: `4px solid ${sev.color}` }}
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{severityMeta(s).label}</option>
            ))}
          </select>
          <div style={S.hint}>
            Critical rings the node card red · Warning rings it amber · Info is
            recorded without changing the canvas.
          </div>

          {/* ── Task policy ────────────────────────────────────────────── */}
          <label style={S.checkRow}>
            <input type="checkbox" checked={createTask} onChange={touchPolicy((e) => setCreateTask(e.target.checked))} />
            Raise a maintenance task when this alarm fires
          </label>
          {createTask && (
            <>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label} htmlFor="alarm-task-role">Assign to</label>
                  <select id="alarm-task-role" style={S.input} value={taskRole} onChange={touchPolicy((e) => setTaskRole(e.target.value))}>
                    <option value="operator">Least-loaded operator</option>
                    <option value="engineer">Least-loaded engineer</option>
                    <option value="manager">A manager</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.label} htmlFor="alarm-task-due">Due within (hours)</label>
                  <input
                    id="alarm-task-due"
                    type="number" min="1" max="8760" step="1" style={S.input}
                    value={taskDueH}
                    onChange={touchPolicy((e) => setTaskDueH(e.target.value))}
                    placeholder={severity === 'critical' ? '4' : severity === 'warning' ? '24' : '72'}
                  />
                </div>
              </div>
              <label style={S.checkRow}>
                <input type="checkbox" checked={taskApproval} onChange={touchPolicy((e) => setTaskApproval(e.target.checked))} />
                Needs a manager’s approval to close
              </label>
            </>
          )}

          {/* ── Enabled ────────────────────────────────────────────────── */}
          <label style={S.checkRow}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>

          {/* ── The sentence this rule reads as ────────────────────────── */}
          {targetOk && !limitMsg && (
            <div style={S.previewBox}>
              <span style={{ ...S.sevDot, background: sev.color }} aria-hidden="true" />
              {preview}
            </div>
          )}

          {/* ── Footer ─────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              {editing && (
                <button
                  type="button"
                  onClick={remove}
                  disabled={removing || saving}
                  style={{ ...S.btn, background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', opacity: removing ? 0.7 : 1 }}
                >
                  {removing ? 'Deleting…' : 'Delete rule'}
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
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create alarm'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// Overlay geometry and tokens intentionally identical to PLCBindDialog's `S`.
const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  box: { background: '#fff', borderRadius: 12, padding: '24px 28px', width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 17, fontWeight: 700, margin: 0, color: '#111' },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF', minWidth: 32, minHeight: 32 },
  context: { background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12.5, color: '#1E40AF' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, marginBottom: 10, boxSizing: 'border-box', background: '#fff' },
  hint: { fontSize: 11, color: '#9CA3AF', marginTop: -6, marginBottom: 10 },
  btn: { padding: '8px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  errorBox: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12 },
  warnBox: { background: '#FFFBEB', border: '1px solid #FCD34D', color: '#92400E', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12 },
  noteBox: { background: '#F8FAFC', border: '1px solid #E2E8F0', borderLeft: '3px solid #2E75B6', color: '#374151', borderRadius: 6, padding: '6px 10px', margin: '-4px 0 10px', fontSize: 11.5 },
  previewBox: { display: 'flex', alignItems: 'center', gap: 7, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', margin: '2px 0 14px', fontSize: 12.5, color: '#1E293B', fontWeight: 600 },
  sevDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', margin: '4px 0 12px', cursor: 'pointer' },
};
