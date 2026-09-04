import { Bell, BellRing } from 'lucide-react';
import { severityMeta, describeRule } from './alarmState';

/**
 * AlarmBell — the per-parameter alarm affordance in the node params panel.
 *
 * It sits on the SAME row as the PLC bind button (Link2) and the ⓘ InfoTip and
 * must never crowd either out: same 14px ghost-icon idiom, same 2px padding,
 * same `flexShrink: 0`.
 *
 * Four states, each one glanceable without reading the label:
 *
 *   none    outlined grey bell        — no rule on this parameter (click: create)
 *   set     filled blue bell          — a rule exists (click: edit)
 *   would   dashed severity outline   — a PREVIEW breach: this rule WOULD fire on
 *                                       the values currently on screen. Never the
 *                                       same paint as a persisted event, because
 *                                       nothing has actually happened yet.
 *   active  severity-coloured ringing — a persisted alarm_event is open
 *
 * `data-alarm-state` carries the state for tests and for anyone inspecting the
 * DOM; the aria-label says it in words, because colour is never the only channel.
 *
 * Viewers (below engineer) get a non-interactive badge instead of a button —
 * they can see that a limit exists and whether it is breaching, but the rule is
 * not theirs to change. That is the same `['admin','engineer']` gate
 * PLCConnectionsTab uses for `canEdit`.
 */
export default function AlarmBell({
  rule,                 // alarm_rules row on this param, or null
  activeEvent,          // open alarm_event for that rule, or null
  previewAlarm,         // preview breach for that rule, or null
  paramLabel,
  nodeLabel,
  canEdit = true,
  onClick,
}) {
  const state = activeEvent ? 'active' : previewAlarm ? 'would' : rule ? 'set' : 'none';

  // A viewer with nothing to look at gets no affordance at all — an inert grey
  // bell on every row would be pure noise.
  if (!canEdit && state === 'none') return null;

  const severity = activeEvent?.severity || previewAlarm?.severity || rule?.severity || 'warning';
  const sev = severityMeta(severity);
  const labels = rule && nodeLabel ? { [rule.node_id ?? rule.nodeId]: nodeLabel } : undefined;
  const sentence = rule ? describeRule(rule, labels) : '';

  const Icon = state === 'active' ? BellRing : Bell;

  const title =
    state === 'active' ? `${sev.label} alarm active — ${activeEvent.message || sentence}`
      : state === 'would' ? `Would fire on the current values — ${previewAlarm.message || sentence}`
        : state === 'set' ? `${sentence}${canEdit ? ' — click to edit' : ''}`
          : `Set an alarm limit on ${paramLabel}`;

  const label =
    state === 'active' ? `${sev.label} alarm active on ${paramLabel}${canEdit ? ' — edit alarm rule' : ''}`
      : state === 'would' ? `Alarm on ${paramLabel} would fire${canEdit ? ' — edit alarm rule' : ''}`
        : state === 'set' ? (canEdit ? `Edit alarm rule on ${paramLabel}` : `Alarm rule set on ${paramLabel}`)
          : `Add alarm rule on ${paramLabel}`;

  const tone =
    state === 'active' ? { background: sev.bg, color: sev.color, border: `1px solid ${sev.border}` }
      : state === 'would' ? { background: 'transparent', color: sev.color, border: `1px dashed ${sev.border}` }
        : state === 'set' ? { background: '#DBEAFE', color: '#1D4ED8', border: '1px solid transparent' }
          : { background: 'transparent', color: '#9CA3AF', border: '1px solid transparent' };

  const shared = {
    'data-alarm-state': state,
    'data-severity': state === 'none' ? undefined : severity,
    title,
    style: { ...BTN, ...tone },
  };

  if (!canEdit) {
    return (
      <span {...shared} style={{ ...shared.style, cursor: 'default' }} role="img" aria-label={label}>
        <Icon size={14} aria-hidden="true" />
      </span>
    );
  }

  return (
    <button
      type="button"
      /* `ws-alarm-bell` (canvas-motion.css) carries the same 1.0s steps(1, end)
         blink as the card ring. It is NOT `.ws-anim`-gated: that gate is scoped
         to `.ws-sheet`, and this button lives in the right rail. */
      className={['nodrag', state === 'active' ? 'ws-alarm-bell' : null].filter(Boolean).join(' ')}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      aria-label={label}
      {...shared}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}

const BTN = {
  cursor: 'pointer', borderRadius: 4, padding: 2, marginLeft: 4,
  display: 'inline-flex', alignItems: 'center', flexShrink: 0, lineHeight: 0,
};
