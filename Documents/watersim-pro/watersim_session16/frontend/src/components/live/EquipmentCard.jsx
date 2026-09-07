/**
 * EquipmentCard — one drive or valve on the Areas view, drawn with the SAME
 * machines as the schematic (components/mimic/MimicSymbols.jsx), in its
 * MEASURED state.
 *
 * The plan's rule for Phase 3: run/stop and open/closed from XS / ZSO / ZSC
 * are measured states and may drive a symbol's state directly, with no
 * simulation round-trip. A running pump spins, a stopped one parks, a
 * tripped one wears the alarm ring, an open valve turns its handwheel. The
 * source is printed on the card: "measured", never "modelled".
 *
 * <MimicDefs/> must be mounted once on the page for the gradients.
 */
import { useState } from 'react';
import { Play, Square, AlertTriangle, Radio } from 'lucide-react';
import '../mimic/mimic.css';
import MimicSymbol, { InstrumentSymbol, TankSymbol } from '../mimic/MimicSymbols';
import { familyOf, NODE_W, NODE_H } from '../mimic/mimicLayout';
import { relTime } from '../alarms/alarmState';

const EMPTY = Object.freeze({});

/** The canvas-shaped snapshot the old line-art symbols read; kept for callers that still build one. */
export function measuredSnapshot(e) {
  const running = e.running === true;
  const metrics = {};
  let derived = EMPTY;
  let refs = EMPTY;
  if (e.opType === 'valve') {
    const status = e.opened === true ? 'OPEN'
      : e.closed === true ? 'CLOSED'
        : (e.opened === false && e.closed === false) ? 'THROTTLED'
          : (e.opened === false && e.closed == null) ? 'CLOSED' : null;
    if (status) metrics.status = status;
    metrics.opening_pct = status === 'OPEN' ? 100 : status === 'CLOSED' ? 0 : 50;
  } else if (e.opType === 'blower') {
    metrics.status = running ? 'ON' : 'OFF';
    derived = Object.freeze({ servedCount: 1, O2_served: running ? 1 : 0 });
    refs = Object.freeze({ O2ref: 1 });
  } else {
    metrics.status = running ? 'ON' : 'OFF';
    metrics.speed_pct = running ? 100 : 0;
  }
  return Object.freeze({
    id: e.key, live: true, seq: 1, changedSeq: 1, hasResults: true,
    type: e.opType, opType: e.opType, metrics: Object.freeze(metrics), biogas: null, outputs: EMPTY, derived, refs,
  });
}

/** The node state, from the measured contacts. */
export function measuredState(e) {
  if (e.tripped === true) return 'alarm';
  if (e.quality === 'stale' || e.quality === 'bad') return 'error';
  if (e.opType === 'valve') return e.opened == null && e.closed == null ? 'nomodel' : 'rest';
  if (e.running == null) return 'nomodel';
  return e.running ? 'rest' : 'off';
}

export function describeState(e) {
  if (e.tripped === true) return { label: 'Tripped', tone: 'text-red-700 bg-red-50 border-red-200' };
  if (e.quality === 'stale') return { label: 'Stale', tone: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (e.quality === 'bad') return { label: 'Bad read', tone: 'text-red-700 bg-red-50 border-red-200' };
  if (e.opType === 'valve') {
    if (e.opened === true) return { label: 'Open', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
    if (e.closed === true) return { label: 'Closed', tone: 'text-gray-700 bg-gray-50 border-gray-200' };
    if (e.opened === false && e.closed === false) return { label: 'Travelling', tone: 'text-amber-700 bg-amber-50 border-amber-200' };
    if (e.opened === false && e.closed == null) return { label: 'Closed', tone: 'text-gray-700 bg-gray-50 border-gray-200' };
    return { label: 'No data', tone: 'text-gray-500 bg-gray-50 border-gray-200' };
  }
  if (e.running === true) return { label: 'Running', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
  if (e.running === false) return { label: 'Stopped', tone: 'text-gray-700 bg-gray-50 border-gray-200' };
  return { label: 'No data', tone: 'text-gray-500 bg-gray-50 border-gray-200' };
}

const fmtValue = (v, dp) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const digits = dp ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};

export default function EquipmentCard({ equipment: e, canControl = false, onControl }) {
  const [hover, setHover] = useState(false);
  const state = measuredState(e);
  const st = describeState(e);
  const isValve = e.opType === 'valve';
  const canAct = canControl && !!e.command;
  const nextAction = isValve ? (e.opened === true ? 'close' : 'open') : (e.running === true ? 'stop' : 'start');
  const family = familyOf(e.opType);
  const s = { running: e.running, tripped: e.tripped, opened: e.opened, closed: e.closed, quality: e.quality };

  return (
    <div
      className={`card p-2 w-[188px] flex-shrink-0 ${e.tripped ? 'border-red-300' : ''}`}
      data-equipment={e.key}
      data-state={state}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-[11px] font-semibold text-gray-900 truncate" title={e.name}>{e.key}</span>
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border ${st.tone}`}>
          {e.tripped ? <AlertTriangle className="w-2.5 h-2.5" /> : null}{st.label}
        </span>
      </div>
      <div className="mimic-root my-1 mx-auto rounded-lg bg-[#eef1f4]" style={{ width: 172, height: 100 }}>
        <svg viewBox={`0 8 ${NODE_W} ${NODE_H - 16}`} width="172" height="100" aria-hidden="true" focusable="false">
          <MimicSymbol family={family} opType={e.opType} s={s} label={null} />
        </svg>
      </div>
      <div className="text-[10px] text-gray-500 truncate" title={e.name}>{e.name}</div>
      <div className="flex items-center justify-between mt-1">
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-400" title={e.at ? `Last read ${new Date(e.at).toLocaleTimeString()}` : 'No sample yet'}>
          <Radio className={`w-3 h-3 ${e.quality === 'good' ? 'text-emerald-500' : 'text-gray-300'}`} /> measured{e.at ? ` · ${relTime(e.at)}` : ''}
        </span>
        {canAct && (
          <button
            onClick={() => onControl?.(e, nextAction)}
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
              nextAction === 'start' || nextAction === 'open'
                ? 'text-emerald-700 border-emerald-300 hover:bg-emerald-50'
                : 'text-red-700 border-red-300 hover:bg-red-50'} ${hover ? '' : 'opacity-80'}`}
            aria-label={`${nextAction} ${e.key}`}
          >
            {nextAction === 'start' || nextAction === 'open' ? <Play className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            {nextAction[0].toUpperCase() + nextAction.slice(1)}
          </button>
        )}
      </div>
    </div>
  );
}

const KIND = { LT: 'level', PT: 'pressure', FT: 'flow', AT: 'ph', TT: 'temperature' };
const UNIT = { LT: '%', FT: 'm³/d', AT: 'pH', PT: 'bar', TT: '°C' };

/**
 * InstrumentCard — an analogue point drawn as its instrument: a level
 * transmitter as the tank it measures, a flow meter or analyser as the LCD
 * readout on the line, a pressure transmitter as a dial.
 */
export function InstrumentCard({ tag: t }) {
  const fn = t.fn || (t.tag || '').split('.').pop()?.replace(/-[A-Z]$/, '') || 'FT';
  const unit = t.engUnit || UNIT[fn] || t.signal || '';
  const reading = { value: t.value, quality: t.quality, rangeMin: t.rangeMin, rangeMax: t.rangeMax };
  const isLevel = fn === 'LT';
  const label = `${t.tag} ${fmtValue(t.value)}${unit ? ` ${unit}` : ''}`;
  return (
    <div className="card p-2 w-[188px] flex-shrink-0" data-tag={t.tag} data-quality={t.quality || 'unknown'}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-[11px] font-semibold text-gray-900 truncate" title={t.name}>{t.tag}</span>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.quality === 'good' ? 'bg-emerald-500' : t.quality === 'stale' ? 'bg-amber-500' : 'bg-gray-300'}`} title={`PLC ${t.quality || 'unknown'}`} />
      </div>
      <div className="mimic-root my-1 mx-auto rounded-lg bg-[#eef1f4]" style={{ width: 172, height: 100 }}>
        <svg viewBox={`0 8 ${NODE_W} ${NODE_H - 16}`} width="172" height="100" role="img" aria-label={label}>
          {isLevel
            ? <TankSymbol s={{ level: t.value == null ? undefined : Number(t.value) }} label={`lvl-${t.id}`} sub={t.name?.split(' ')[0]} />
            : <InstrumentSymbol s={{}} reading={reading} unit={unit} kind={KIND[fn]} label={null} />}
        </svg>
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-gray-500 truncate" title={t.name}>{t.name}</span>
        <span className="font-mono text-gray-800 tabular-nums">{fmtValue(t.value)}{unit ? ` ${unit}` : ''}</span>
      </div>
    </div>
  );
}
