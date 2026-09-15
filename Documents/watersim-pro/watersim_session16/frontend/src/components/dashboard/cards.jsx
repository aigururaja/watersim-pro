/**
 * Dashboard cards — one component per section the server may send
 * (backend routes/dashboard.js decides which sections a role gets). Each
 * card takes the section's data and draws it; none fetches anything.
 */
import { Link } from 'react-router-dom';
import {
  ChevronRight, Activity, Bell, ClipboardList, Boxes, Cpu, FolderOpen, Play, Gauge, Send, Users, Plug, ScrollText, Server,
  AlertTriangle, Check, Radio, Timer, Monitor, ShieldCheck,
} from 'lucide-react';
import { relTime, absTime, severityMeta } from '../alarms/alarmState';
import { baseForKind } from '../../utils/projectBase';

// ── Shared bits (the console card grammar) ───────────────────────────────────

/** A white card with a semibold heading and a "Manage ›" style link on the right. */
export function Card({ title, icon: Icon, to, toLabel = 'Open', children, className = '', badge = null, testId }) {
  return (
    <section className={`card p-4 flex flex-col gap-3 min-w-0 h-full ${className}`} aria-label={title} data-testid={testId}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-ink flex items-center gap-2 min-w-0">
          {Icon && <Icon className="w-4 h-4 text-ink-3 flex-shrink-0" aria-hidden="true" />}
          <span className="truncate">{title}</span>
          {badge}
        </h3>
        {to && (
          <Link to={to} className="inline-flex items-center gap-0.5 text-[13px] font-semibold text-ink-2 hover:text-ink flex-shrink-0 whitespace-nowrap">
            {toLabel} <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

// Tones the sections pass in, mapped onto the console palette.
const STAT_TONE = {
  'text-ink': 'text-ink', 'text-danger': 'text-danger', 'text-warn': 'text-warn',
  'text-ok': 'text-ok', 'text-accent-ink': 'text-accent-ink', 'text-ink-3': 'text-ink-3',
};

/** An uppercase 11px label above an extrabold number. */
export function Stat({ label, value, tone = 'text-ink', hint, small = false }) {
  return (
    <div className="min-w-0">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${small ? 'text-xl' : 'text-2xl'} ${STAT_TONE[tone] || tone}`}>{value ?? '—'}</div>
      {hint && <div className="text-[11px] text-ink-3 truncate">{hint}</div>}
    </div>
  );
}

export const Empty = ({ children }) => <p className="text-[13px] text-ink-3">{children}</p>;

export const fmt = (v, dp) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const digits = dp ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits });
};

export function SeverityPill({ severity }) {
  const m = severityMeta(severity);
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide" style={{ background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>{m.label}</span>;
}

const PRIORITY = {
  urgent: 'bg-danger-soft text-danger', high: 'bg-warn-soft text-warn',
  medium: 'bg-accent-soft text-accent-ink', low: 'bg-ground text-ink-2 border border-line',
};
export function PriorityPill({ priority }) {
  return <span className={`pill uppercase tracking-wide ${PRIORITY[priority] || PRIORITY.medium}`}>{priority || 'medium'}</span>;
}

export function StatePill({ state }) {
  const tone = state === 'completed' ? 'bg-accent-soft text-accent-ink'
    : state === 'in_progress' ? 'bg-ink text-white'
      : state === 'rejected' ? 'bg-danger-soft text-danger'
        : state === 'approved' ? 'bg-ok-soft text-ok' : 'bg-ground text-ink-2 border border-line';
  return <span className={`pill ${tone}`}>{String(state || '').replace('_', ' ')}</span>;
}

export const QualityDot = ({ quality, title }) => (
  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${quality === 'good' ? 'bg-emerald-500' : quality === 'stale' ? 'bg-amber-500' : quality === 'bad' ? 'bg-red-500' : 'bg-gray-300'}`} title={title || `PLC ${quality || 'unknown'}`} />
);

const StatusDot = ({ ok, warn = false }) => <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500'}`} aria-hidden="true" />;

// ── Plant strip: the same numbers for everyone, across the top ───────────────

export function PlantStrip({ data }) {
  const b = data.bindings || {};
  const d = data.drives || {};
  const v = data.valves || {};
  const a = data.alarms || {};
  const t = data.tasks || {};
  const commsOk = b.total > 0 && b.good === b.total;
  return (
    <section className="card p-4" aria-label="Plant at a glance" data-testid="plant-strip">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-3 mb-1"><Plug className="w-3.5 h-3.5" aria-hidden="true" /> PLC points</div>
          <div className={`text-2xl font-bold tabular-nums ${commsOk ? 'text-ok' : b.total ? 'text-warn' : 'text-ink-3'}`}>{b.good ?? 0}<span className="text-sm text-ink-3 font-medium"> / {b.total ?? 0}</span></div>
          <div className="flex flex-wrap gap-x-2 text-[10px] text-ink-3">
            {(data.connections || []).map((c) => <span key={c.id} className="inline-flex items-center gap-1"><StatusDot ok={c.status === 'online'} warn={c.status === 'unknown'} />{c.name}</span>)}
            {!(data.connections || []).length && <span>no PLC connection</span>}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-3 mb-1"><Activity className="w-3.5 h-3.5" aria-hidden="true" /> Drives running</div>
          <div className="text-2xl font-bold tabular-nums text-ink">{d.running ?? 0}<span className="text-sm text-ink-3 font-medium"> / {d.total ?? 0}</span></div>
          <div className="text-[10px] text-ink-3">{d.tripped ? <span className="text-danger font-semibold">{d.tripped} tripped</span> : `${d.stopped ?? 0} stopped`}</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-3 mb-1"><Gauge className="w-3.5 h-3.5" aria-hidden="true" /> Valves open</div>
          <div className="text-2xl font-bold tabular-nums text-ink">{v.open ?? 0}<span className="text-sm text-ink-3 font-medium"> / {v.total ?? 0}</span></div>
          <div className="text-[10px] text-ink-3">{v.closed ?? 0} closed</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-3 mb-1"><Bell className="w-3.5 h-3.5" aria-hidden="true" /> Alarms</div>
          <div className={`text-2xl font-bold tabular-nums ${a.critical ? 'text-danger' : a.warning ? 'text-warn' : 'text-ok'}`}>{(a.critical || 0) + (a.warning || 0) + (a.info || 0)}</div>
          <div className="text-[10px] text-ink-3">{a.critical || 0} critical · {a.warning || 0} warning · {a.unacknowledged || 0} unack</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-3 mb-1"><ClipboardList className="w-3.5 h-3.5" aria-hidden="true" /> Tasks open</div>
          <div className={`text-2xl font-bold tabular-nums ${t.overdue ? 'text-danger' : 'text-ink'}`}>{t.open ?? 0}</div>
          <div className="text-[10px] text-ink-3">{t.overdue || 0} overdue · {t.awaitingApproval || 0} awaiting approval</div>
        </div>
        <div className="min-w-0 flex flex-col justify-between">
          <div className="text-[11px] text-ink-3 flex items-center gap-2"><Monitor className="w-3.5 h-3.5" aria-hidden="true" /> {data.flowsheet?.name || 'No plant bound yet'}</div>
          <div className="flex flex-wrap gap-2 mt-1">
            <Link to="/live" className="btn-primary text-xs py-1 px-2">Live plant</Link>
            <Link to="/alarms" className="btn-secondary text-xs py-1 px-2">Alarms</Link>
          </div>
          <div className="text-[10px] text-ink-3 mt-1">{data.areas || 0} areas · updated {relTime(data.at)}</div>
        </div>
      </div>
    </section>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

export function AlarmsCard({ data, role }) {
  const c = data.counts || {};
  const d = data.last24h;
  return (
    <Card title="Alarms" icon={Bell} to="/alarms" toLabel="All alarms" testId="card-alarms">
      <div className="grid grid-cols-4 gap-2">
        <Stat small label="critical" value={c.critical ?? 0} tone={c.critical ? 'text-danger' : 'text-ink'} />
        <Stat small label="warning" value={c.warning ?? 0} tone={c.warning ? 'text-warn' : 'text-ink'} />
        <Stat small label="unack" value={c.unacknowledged ?? 0} tone={c.unacknowledged ? 'text-danger' : 'text-ink'} />
        <Stat small label="ack time" value={data.mttaMinutes == null ? '—' : `${fmt(data.mttaMinutes, 0)} min`} hint="7 d average" />
      </div>
      {d && <div className="text-[11px] text-ink-3">Last 24 h: {d.critical} critical, {d.warning} warning, {d.info} info raised · {d.cleared} cleared</div>}
      <ul className="divide-y divide-line text-xs" aria-label="Active alarms">
        {(data.active || []).slice(0, 5).map((a) => (
          <li key={a.id} className="py-1.5 flex items-center gap-2">
            <SeverityPill severity={a.severity} />
            <span className="flex-1 min-w-0 truncate text-ink" title={a.message}>{a.message}</span>
            <span className="text-[10px] text-ink-3 whitespace-nowrap" title={absTime(a.triggeredAt)}>{relTime(a.triggeredAt)}</span>
            {a.acknowledged ? <Check className="w-3 h-3 text-ok" aria-label="acknowledged" /> : <AlertTriangle className="w-3 h-3 text-red-500" aria-label="unacknowledged" />}
          </li>
        ))}
        {!(data.active || []).length && <li className="py-1.5"><Empty>No active alarms.</Empty></li>}
      </ul>
      {['engineer', 'manager'].includes(role) && (data.noisy || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-ink-3 mb-1">Noisiest rules · 7 d</div>
          <ul className="text-xs space-y-0.5">
            {data.noisy.map((r) => <li key={r.ruleId} className="flex items-center justify-between gap-2"><span className="truncate text-ink-2">{r.name}</span><span className="tabular-nums text-ink-3">{r.n}×</span></li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
AlarmsCard.span = 2;

export function DrivesCard({ data }) {
  return (
    <Card title="Drives" icon={Activity} to="/live" toLabel="Live plant" testId="card-equipment">
      <div className="grid grid-cols-3 gap-2">
        <Stat small label="running" value={data.running ?? 0} tone="text-ok" />
        <Stat small label="tripped" value={(data.tripped || []).length} tone={(data.tripped || []).length ? 'text-danger' : 'text-ink'} />
        <Stat small label="of" value={data.total ?? 0} />
      </div>
      {(data.tripped || []).length > 0 && (
        <ul className="text-xs space-y-1" aria-label="Tripped drives">
          {data.tripped.map((e) => <li key={e.key} className="flex items-center gap-2 text-danger"><AlertTriangle className="w-3 h-3" aria-hidden="true" /><span className="font-mono">{e.key}</span><span className="truncate text-ink-2">{e.name}</span></li>)}
        </ul>
      )}
      {(data.stopped || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-ink-3 mb-1">Stopped</div>
          <ul className="text-xs space-y-0.5" aria-label="Stopped drives">
            {data.stopped.map((e) => <li key={e.key} className="flex items-center gap-2"><span className="font-mono text-ink-2">{e.key}</span><span className="truncate text-ink-3">{e.name}</span></li>)}
          </ul>
        </div>
      )}
      {!(data.tripped || []).length && !(data.stopped || []).length && <Empty>Every drive with a status contact is running.</Empty>}
    </Card>
  );
}

function TaskRow({ t, extra }) {
  return (
    <li className="py-1.5 flex items-center gap-2 text-xs">
      <span className="font-mono text-ink-3 w-10 flex-shrink-0">#{t.number}</span>
      <span className="flex-1 min-w-0 truncate text-ink" title={t.title}>{t.title}</span>
      {extra}
      <PriorityPill priority={t.priority} />
      {t.dueAt && <span className={`text-[10px] whitespace-nowrap ${t.overdue ? 'text-danger font-semibold' : 'text-ink-3'}`} title={absTime(t.dueAt)}>{t.overdue ? 'overdue' : `due ${relTime(t.dueAt)}`}</span>}
    </li>
  );
}

export function MyTasksCard({ data }) {
  return (
    <Card title="My tasks" icon={ClipboardList} to="/tasks" toLabel="Task board" testId="card-my-tasks"
      badge={data.overdue ? <span className="text-[10px] font-semibold text-danger bg-danger-soft border border-danger/30 rounded-full px-1.5">{data.overdue} overdue</span> : null}>
      <ul className="divide-y divide-line" aria-label="My tasks">
        {(data.items || []).map((t) => <TaskRow key={t.id} t={t} extra={!t.mine ? <span className="text-[10px] text-ink-3">for your role</span> : null} />)}
        {!(data.items || []).length && <li className="py-1.5"><Empty>Nothing on your desk.</Empty></li>}
      </ul>
      {data.total > (data.items || []).length && <div className="text-[11px] text-ink-3">{data.total - data.items.length} more on the board</div>}
    </Card>
  );
}

export function ApprovalsCard({ data }) {
  const c = data.counts || {};
  return (
    <Card title="Awaiting approval" icon={ShieldCheck} to="/tasks?state=completed" toLabel="Review" testId="card-approvals">
      <div className="grid grid-cols-4 gap-2">
        <Stat small label="to approve" value={c.awaiting ?? 0} tone={c.awaiting ? 'text-accent-ink' : 'text-ink'} />
        <Stat small label="overdue" value={c.overdue ?? 0} tone={c.overdue ? 'text-danger' : 'text-ink'} />
        <Stat small label="open" value={c.open ?? 0} />
        <Stat small label="approved 7 d" value={c.approved7d ?? 0} tone="text-ok" />
      </div>
      <ul className="divide-y divide-line" aria-label="Tasks awaiting approval">
        {(data.awaiting || []).map((t) => (
          <TaskRow key={t.id} t={{ ...t, dueAt: null }} extra={<span className="text-[10px] text-ink-3 whitespace-nowrap">{t.assignedToName || '—'} · {relTime(t.completedAt)}</span>} />
        ))}
        {!(data.awaiting || []).length && <li className="py-1.5"><Empty>Nothing waiting for a signature.</Empty></li>}
      </ul>
      {(data.overdue || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-danger mb-1">Overdue</div>
          <ul className="divide-y divide-line" aria-label="Overdue tasks">
            {data.overdue.map((t) => <TaskRow key={t.id} t={{ ...t, overdue: true }} extra={<span className="text-[10px] text-ink-3 whitespace-nowrap">{t.assignedToName || t.assignedRole || 'unassigned'}</span>} />)}
          </ul>
        </div>
      )}
    </Card>
  );
}
ApprovalsCard.span = 2;

export function TwinCard({ data }) {
  return (
    <Card title="Digital twin" icon={Boxes} to="/twin" toLabel="Twin" testId="card-twin">
      <ul className="divide-y divide-line" aria-label="Twins">
        {(data.items || []).map((t) => (
          <li key={t.flowsheetId} className="py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <StatusDot ok={t.enabled && !t.error} warn={!t.enabled} />
              <Link to={`/twin/${t.flowsheetId}`} className="font-medium text-ink hover:underline truncate">{t.projectName}</Link>
              {t.imported && <span className="text-[10px] text-ok inline-flex items-center gap-0.5"><Radio className="w-3 h-3" /> live</span>}
            </div>
            <div className="text-[11px] text-ink-3 flex flex-wrap gap-x-2">
              <span>{t.enabled ? `every ${t.cadenceS} s` : 'paused'}</span>
              <span>{t.solvedAt ? `solved ${relTime(t.solvedAt)}` : 'never solved'}</span>
              <span>{t.residuals} residuals</span>
              {t.worst && <span className={Math.abs(t.worst.z) > (t.driftZ || 3) ? 'text-danger font-semibold' : ''}>worst z {fmt(t.worst.z, 2)} · {t.worst.tag}</span>}
              {t.driftAlarms > 0 && <span className="text-danger font-semibold">{t.driftAlarms} drift</span>}
              {t.error && <span className="text-danger" title={t.error}>error</span>}
            </div>
          </li>
        ))}
        {!(data.items || []).length && <li className="py-1.5"><Empty>No twin yet. Import the plant under Digital Twin → Projects.</Empty></li>}
      </ul>
    </Card>
  );
}

export function PlcCard({ data }) {
  const b = data.bindings || {};
  return (
    <Card title="PLC health" icon={Plug} to="/settings" toLabel="Settings" testId="card-plc">
      <ul className="text-xs space-y-1" aria-label="PLC connections">
        {(data.connections || []).map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <StatusDot ok={c.status === 'online'} warn={c.status === 'unknown'} />
            <span className="font-medium text-ink truncate">{c.name}</span>
            <span className="text-ink-3">{c.protocol}{c.mode === 'shadow' ? ' · shadow' : ''}</span>
            <span className="ml-auto tabular-nums text-ink-3">{c.good}/{c.bindings}</span>
          </li>
        ))}
        {!(data.connections || []).length && <li><Empty>No PLC connection configured.</Empty></li>}
      </ul>
      <div className="text-[11px] text-ink-3">{b.good ?? 0} good · {b.stale ?? 0} stale · {b.bad ?? 0} bad · {b.unknown ?? 0} unread</div>
      {(data.unhealthy || []).length > 0 && (
        <ul className="text-xs space-y-0.5" aria-label="Unhealthy points">
          {data.unhealthy.map((p) => <li key={p.tag} className="flex items-center gap-2"><QualityDot quality={p.quality} /><span className="font-mono text-ink-2 truncate">{p.tag}</span><span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap">{p.lastReadAt ? relTime(p.lastReadAt) : 'never read'}</span></li>)}
        </ul>
      )}
    </Card>
  );
}

export function CountersCard({ data }) {
  return (
    <Card title={`Run hours · ${data.days || 7} d`} icon={Timer} to="/twin" toLabel="Twin" testId="card-counters">
      {(data.items || []).length ? (
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] text-ink-3 text-left"><th className="font-medium">Drive</th><th className="font-medium text-right">h</th><th className="font-medium text-right">starts</th><th className="font-medium text-right">trips</th></tr></thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-1 font-mono text-ink-2 truncate" title={r.name}>{r.key}</td>
                <td className="py-1 text-right tabular-nums">{fmt(r.runHours, 1)}</td>
                <td className="py-1 text-right tabular-nums">{r.starts}</td>
                <td className={`py-1 text-right tabular-nums ${r.trips ? 'text-danger font-semibold' : ''}`}>{r.trips}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Empty>No run-hour counters yet — they build from the plant's XS and XA contacts.</Empty>}
    </Card>
  );
}

export function ProjectsCard({ data }) {
  return (
    <Card title="Projects" icon={FolderOpen} to="/monitoring/projects" toLabel="All projects" testId="card-projects">
      <div className="grid grid-cols-2 gap-2">
        <Stat small label="monitoring" value={data.monitoring ?? 0} />
        <Stat small label="twin" value={data.twin ?? 0} />
      </div>
      <ul className="text-xs space-y-1" aria-label="Recent projects">
        {(data.recent || []).map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            {p.kind === 'monitoring' ? <Monitor className="w-3 h-3 text-brand-500" aria-hidden="true" /> : <Boxes className="w-3 h-3 text-brand-500" aria-hidden="true" />}
            <Link to={`${baseForKind(p.kind)}/${p.id}`} className="truncate text-ink hover:underline">{p.name}</Link>
            <span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap">{p.flowsheets} fs · {relTime(p.updatedAt)}</span>
          </li>
        ))}
        {!(data.recent || []).length && <li><Empty>No projects yet.</Empty></li>}
      </ul>
    </Card>
  );
}

export function RunsCard({ data }) {
  return (
    <Card title="Recent simulation runs" icon={Play} to="/reports" toLabel="Reports" testId="card-runs">
      <ul className="divide-y divide-line text-xs" aria-label="Recent runs">
        {(data.items || []).map((r) => (
          <li key={r.id} className="py-1.5 flex items-center gap-2">
            <StatusDot ok={r.status === 'completed'} warn={r.status !== 'failed'} />
            <Link to={`${baseForKind(r.kind)}/${r.projectId}/flowsheets/${r.flowsheetId}/simulate/${r.id}/report`} className="truncate text-ink hover:underline">{r.flowsheetName}</Link>
            <span className="text-ink-3 truncate">{r.projectName}</span>
            <span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap">{r.mode} · {relTime(r.createdAt)}</span>
          </li>
        ))}
        {!(data.items || []).length && <li className="py-1.5"><Empty>No runs yet.</Empty></li>}
      </ul>
    </Card>
  );
}

export function ReadingsCard({ data }) {
  return (
    <Card title="Key readings" icon={Gauge} to="/trends" toLabel="Trends" testId="card-readings">
      {(data.items || []).length ? (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2" role="list" aria-label="Key readings">
          {data.items.map((r) => {
            const span = r.rangeMax != null && r.rangeMin != null && r.rangeMax > r.rangeMin;
            const frac = span && r.value != null ? Math.max(0, Math.min(1, (r.value - r.rangeMin) / (r.rangeMax - r.rangeMin))) : null;
            return (
              <div key={r.id} role="listitem" className="rounded-xl border border-line bg-ground p-2 min-w-0" data-tag={r.tag}>
                <div className="flex items-center justify-between gap-1"><span className="font-mono text-[10px] text-ink-3 truncate">{r.tag}</span><QualityDot quality={r.quality} /></div>
                <div className="font-mono text-lg font-bold tabular-nums text-ink leading-tight">{fmt(r.value)}<span className="text-[10px] text-ink-3 font-medium"> {r.unit}</span></div>
                <div className="text-[10px] text-ink-3 truncate" title={r.name}>{r.name}</div>
                {frac != null && <div className="h-1 rounded bg-line mt-1"><div className="h-1 rounded bg-brand-500" style={{ width: `${frac * 100}%` }} /></div>}
              </div>
            );
          })}
        </div>
      ) : <Empty>No analogue points bound yet.</Empty>}
    </Card>
  );
}
ReadingsCard.span = 2;

export function NotificationsCard({ data }) {
  const d = data.last24h || {};
  const s = data.subscriptions || {};
  return (
    <Card title="Notifications · 24 h" icon={Send} to="/settings" toLabel="Policy" testId="card-notifications">
      <div className="grid grid-cols-4 gap-2">
        <Stat small label="sent" value={d.sent ?? 0} tone="text-ok" />
        <Stat small label="pending" value={d.pending ?? 0} />
        <Stat small label="failed" value={d.failed ?? 0} tone={d.failed ? 'text-warn' : 'text-ink'} />
        <Stat small label="dead" value={d.dead ?? 0} tone={d.dead ? 'text-danger' : 'text-ink'} />
      </div>
      <div className="text-[11px] text-ink-3">{d.email ?? 0} email · {d.whatsapp ?? 0} WhatsApp · {d.webhook ?? 0} webhook · {s.enabled ?? 0} of {s.n ?? 0} policies enabled</div>
    </Card>
  );
}

export function TeamCard({ data }) {
  const roles = ['admin', 'manager', 'engineer', 'operator', 'viewer'];
  return (
    <Card title="Team" icon={Users} to="/admin" toLabel="Members" testId="card-team">
      <div className="flex flex-wrap gap-1.5">
        {roles.map((r) => <span key={r} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-line bg-ground text-ink-2 capitalize">{r} <b className="tabular-nums">{data.byRole?.[r]?.total ?? 0}</b></span>)}
      </div>
      <ul className="text-xs space-y-0.5" aria-label="Recent logins">
        {(data.recentLogins || []).map((u) => <li key={u.id} className="flex items-center gap-2"><span className={`truncate ${u.active ? 'text-ink' : 'text-ink-3 line-through'}`}>{u.name}</span><span className="text-[10px] text-ink-3 capitalize">{u.role}</span><span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap">{u.lastLoginAt ? relTime(u.lastLoginAt) : 'never signed in'}</span></li>)}
      </ul>
      <div className="text-[11px] text-ink-3">{data.active ?? 0} of {data.total ?? 0} accounts active</div>
    </Card>
  );
}

export function IntegrationsCard({ data }) {
  const k = data.apiKeys || {};
  return (
    <Card title="Integrations" icon={Cpu} to="/settings" toLabel="Keys & webhooks" testId="card-integrations">
      <div className="grid grid-cols-2 gap-2">
        <Stat small label="API keys active" value={k.active ?? 0} hint={k.lastUsedAt ? `last used ${relTime(k.lastUsedAt)}` : 'never used'} />
        <Stat small label="webhooks" value={(data.webhooks || []).length} />
      </div>
      <ul className="text-xs space-y-0.5" aria-label="Webhooks">
        {(data.webhooks || []).map((h) => <li key={h.id} className="flex items-center gap-2"><StatusDot ok={h.healthy} warn={!h.enabled} /><span className="truncate text-ink">{h.name}</span><span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap">{h.lastStatus ? `HTTP ${h.lastStatus}` : 'no delivery yet'}{h.failures ? ` · ${h.failures} failing` : ''}</span></li>)}
        {!(data.webhooks || []).length && <li><Empty>No webhook endpoints. The CMMS boundary is idle.</Empty></li>}
      </ul>
    </Card>
  );
}

export function AuditCard({ data }) {
  return (
    <Card title="Audit trail" icon={ScrollText} to="/audit" toLabel="Full log" testId="card-audit">
      <ul className="divide-y divide-line text-xs" aria-label="Recent audit entries">
        {(data.items || []).map((e) => (
          <li key={e.id} className="py-1 flex items-center gap-2">
            <span className="font-mono text-ink-2 truncate">{e.action}</span>
            <span className="text-ink-3 truncate">{e.actor}</span>
            <span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap" title={absTime(e.at)}>{relTime(e.at)}</span>
          </li>
        ))}
        {!(data.items || []).length && <li className="py-1"><Empty>Nothing recorded yet.</Empty></li>}
      </ul>
    </Card>
  );
}

const fmtUptime = (s) => (s == null ? '—' : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);

export function SystemCard({ data }) {
  return (
    <Card title="System" icon={Server} testId="card-system">
      <div className="grid grid-cols-3 gap-2">
        <Stat small label="uptime" value={fmtUptime(data.uptimeS)} hint={data.node} />
        <Stat small label="samples / h" value={data.samplesLastHour == null ? '—' : fmt(data.samplesLastHour, 0)} />
        <Stat small label="partitions" value={data.partitions ?? '—'} hint="tag_samples" />
      </div>
      <ul className="text-xs space-y-0.5" aria-label="Historian jobs">
        {(data.historian || []).map((j) => (
          <li key={j.name} className="flex items-center gap-2">
            <StatusDot ok={!j.lastError} />
            <span className="font-mono text-ink-2">{j.name}</span>
            <span className="ml-auto text-[10px] text-ink-3 whitespace-nowrap" title={j.lastError || ''}>{j.lastError ? 'error' : j.lastRunAt ? `ran ${relTime(j.lastRunAt)}` : 'not yet'}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
