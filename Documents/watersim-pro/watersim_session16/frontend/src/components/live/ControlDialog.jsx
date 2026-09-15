/**
 * ControlDialog — the confirmation before a write reaches the PLC.
 *
 * A start, stop, open or close from the live screen is a real control
 * action: it goes through POST …/plc-bindings/:id/write (operator and above,
 * audited on the server). The dialog says exactly which tag and which value,
 * and needs an explicit acknowledgement before the button is enabled.
 */
import { useState } from 'react';
import { X, Loader2, ShieldAlert } from 'lucide-react';

const VERB = { start: 'Start', stop: 'Stop', open: 'Open', close: 'Close' };
const VALUE = { start: 1, stop: 0, open: 1, close: 0 };

export default function ControlDialog({ equipment, action, onClose, onConfirm, busy = false, error = null }) {
  const [ack, setAck] = useState(false);
  const value = VALUE[action];
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${VERB[action]} ${equipment.key}`}>
      <div className="card p-5 w-full max-w-md bg-white space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-ink">{VERB[action]} {equipment.key}?</h3>
          <button type="button" onClick={onClose} className="p-1 text-ink-3 hover:text-ink-2" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-sm text-ink-2">{equipment.name}</p>
        <dl className="text-xs grid grid-cols-[7rem_1fr] gap-y-1 bg-ground rounded-xl p-3">
          <dt className="text-ink-3">Command tag</dt><dd className="font-mono text-ink">{equipment.command?.tag}</dd>
          <dt className="text-ink-3">Value written</dt><dd className="font-mono text-ink">{value}</dd>
          <dt className="text-ink-3">Current state</dt><dd className="text-ink">{equipment.running === true ? 'running' : equipment.running === false ? 'stopped' : equipment.opened === true ? 'open' : equipment.closed === true ? 'closed' : 'unknown'}</dd>
        </dl>
        <div className="flex items-start gap-2 text-xs text-warn bg-warn-soft border border-warn/30 rounded-xl px-3 py-2">
          <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          This writes to the PLC. The action is recorded against your name in the audit trail.
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-brand-600" />
          I am authorised to operate this equipment
        </label>
        {error && <div role="alert" className="text-sm text-danger bg-danger-soft border border-danger/30 rounded-xl px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button type="button" onClick={() => onConfirm(value)} disabled={!ack || busy}
            className={`text-sm ${action === 'stop' || action === 'close' ? 'btn-secondary' : 'btn-primary'} disabled:opacity-50`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {VERB[action]} {equipment.key}
          </button>
        </div>
      </div>
    </div>
  );
}
