/**
 * SafeKrit — TasksPage
 * The maintenance board: every work item in the organisation by state, with
 * the detail panel where the work actually moves — assign, start, complete,
 * approve or reject, acknowledge a critical alarm — each action gated by the
 * same capability table the server enforces.
 *
 * Route: /tasks   (?open=<id> opens a task; ?mine=1 filters to my tasks)
 *
 * Data: GET /tasks (board), GET /tasks/:id (detail with transitions, comments
 * and the server's list of allowed actions), POST /tasks/:id/transition,
 * POST /tasks/:id/comments, POST /tasks, GET /tasks/assignees. The board
 * refreshes every 30 s and after every action.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ClipboardList, Plus, RefreshCw, Loader2, X, Search, User, Clock, AlertTriangle,
  Play, Check, CheckCheck, XCircle, RotateCcw, Ban, ShieldCheck, MessageSquare, Bell, ChevronRight,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import EmptyState from '../components/EmptyState';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { relTime, absTime } from '../components/alarms/alarmState';

export const COLUMNS = [
  { key: 'open',        label: 'Open',              states: ['open'] },
  { key: 'assigned',    label: 'Assigned',          states: ['assigned'] },
  { key: 'in_progress', label: 'In progress',       states: ['in_progress'] },
  { key: 'completed',   label: 'Awaiting approval', states: ['completed'] },
  { key: 'rejected',    label: 'Rejected',          states: ['rejected'] },
  { key: 'closed',      label: 'Closed',            states: ['approved', 'cancelled'], collapsed: true },
];

const PRIORITY = {
  urgent: { label: 'Urgent', cls: 'text-danger bg-danger-soft border-danger/30' },
  high:   { label: 'High',   cls: 'text-warn bg-warn-soft border-warn/30' },
  medium: { label: 'Medium', cls: 'text-accent-ink bg-accent-soft border-accent/30' },
  low:    { label: 'Low',    cls: 'text-ink-2 bg-ground border-line' },
};

const ACTION_META = {
  assign:      { label: 'Assign',      icon: User,        tone: 'btn-secondary' },
  start:       { label: 'Start work',  icon: Play,        tone: 'btn-primary' },
  complete:    { label: 'Complete',    icon: Check,       tone: 'btn-primary', note: 'optional', prompt: 'What was done?' },
  approve:     { label: 'Approve',     icon: CheckCheck,  tone: 'btn-primary' },
  reject:      { label: 'Reject',      icon: XCircle,     tone: 'btn-secondary', note: 'required', prompt: 'Why is it going back?' },
  acknowledge: { label: 'Acknowledge alarm', icon: ShieldCheck, tone: 'btn-secondary' },
  cancel:      { label: 'Cancel task', icon: Ban,         tone: 'btn-secondary', note: 'optional', prompt: 'Why cancel?' },
  reopen:      { label: 'Reopen',      icon: RotateCcw,   tone: 'btn-secondary' },
};

function PriorityPill({ priority }) {
  const p = PRIORITY[priority] || PRIORITY.medium;
  return <span data-priority={priority} className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${p.cls}`}>{p.label}</span>;
}

function Due({ task }) {
  if (!task.dueAt) return null;
  const over = task.overdue;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${over ? 'text-red-600 font-medium' : 'text-ink-3'}`} title={absTime(task.dueAt)}>
      {over ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
      {over ? 'overdue ' : 'due '}{relTime(task.dueAt)}
    </span>
  );
}

function TaskCard({ task, onOpen, active }) {
  return (
    <button
      onClick={() => onOpen(task.id)}
      data-task={task.number}
      className={`w-full text-left card p-3 hover:shadow-md transition-shadow border ${active ? 'border-brand-400 ring-1 ring-brand-200' : 'border-transparent'}`}
      aria-label={`${task.number} ${task.title}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-mono text-[11px] text-ink-3">{task.number}</span>
        <PriorityPill priority={task.priority} />
      </div>
      <div className="text-sm font-medium text-ink leading-snug line-clamp-2">{task.title}</div>
      <div className="flex items-center justify-between gap-2 mt-2 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1 truncate">
          <User className="w-3 h-3" aria-hidden="true" />
          {task.assignedToName || (task.assignedRole ? `any ${task.assignedRole}` : 'unassigned')}
        </span>
        <Due task={task} />
      </div>
      {(task.tag || task.requiresAck) && (
        <div className="flex items-center gap-2 mt-1.5 text-[10px]">
          {task.tag && <span className="font-mono text-ink-3">{task.tag}</span>}
          {task.requiresAck && !task.acknowledgedAt && (
            <span className="inline-flex items-center gap-1 text-red-600 font-medium"><Bell className="w-3 h-3" /> needs manager ack</span>
          )}
          {task.requiresAck && task.acknowledgedAt && (
            <span className="inline-flex items-center gap-1 text-ok"><ShieldCheck className="w-3 h-3" /> acknowledged</span>
          )}
        </div>
      )}
    </button>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function TaskDetail({ id, onClose, onChanged, showToast, assignees }) {
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [assignTo, setAssignTo] = useState('');
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/tasks/${id}`);
      if (!data || !data.id || !data.state) throw new Error('The task could not be read');
      setTask({ ...data, transitions: data.transitions || [], comments: data.comments || [], allowedActions: data.allowedActions || [] });
      setAssignTo(data.assignedTo || '');
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the task');
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (action) => {
    const meta = ACTION_META[action];
    let note = null;
    if (meta?.note) {
      note = window.prompt(meta.prompt || 'Note');
      if (note === null) return;
      if (meta.note === 'required' && !note.trim()) { showToast('A note is required', false); return; }
    }
    setBusy(action);
    try {
      const body = { action, note: note || undefined };
      if (action === 'assign') { if (!assignTo) { showToast('Pick an assignee first', false); return; } body.assignedTo = assignTo; }
      const { data } = await api.post(`/tasks/${id}/transition`, body);
      showToast(`${data.number}: ${meta?.label || action}`);
      await load();
      onChanged?.();
    } catch (err) {
      showToast(err.response?.data?.error || `${action} failed`, false);
    } finally {
      setBusy(null);
    }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setBusy('comment');
    try {
      await api.post(`/tasks/${id}/comments`, { body: comment.trim() });
      setComment('');
      await load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not add the comment', false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="card p-4 w-full lg:w-[28rem] flex-shrink-0 lg:sticky lg:top-4 max-h-[calc(100vh-6rem)] overflow-y-auto" aria-label="Task detail">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs text-ink-3">{task?.number || '…'}</div>
          <h3 className="text-base font-semibold text-ink leading-snug">{task?.title || 'Loading…'}</h3>
        </div>
        <button onClick={onClose} className="p-1 text-ink-3 hover:text-ink-2 rounded" aria-label="Close task"><X className="w-4 h-4" /></button>
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-soft border border-danger/30 rounded-xl px-3 py-2 mt-3">{error}</div>}
      {task && (
        <>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
            <PriorityPill priority={task.priority} />
            <span className="px-1.5 py-0.5 rounded bg-ground text-ink-2 capitalize">{String(task.state).replace('_', ' ')}</span>
            {task.severity && <span className="text-ink-3">from a {task.severity} alarm</span>}
            <Due task={task} />
          </div>
          {task.description && <p className="text-sm text-ink-2 mt-3 whitespace-pre-wrap">{task.description}</p>}

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-3 text-xs">
            <dt className="text-ink-3">Assigned to</dt><dd className="text-ink">{task.assignedToName || '—'}{task.assignedToRole ? ` (${task.assignedToRole})` : ''}</dd>
            <dt className="text-ink-3">Raised by</dt><dd className="text-ink">{task.createdByName || '—'}</dd>
            <dt className="text-ink-3">Flowsheet</dt>
            <dd className="text-ink truncate">
              {task.projectId && task.flowsheetId
                ? <Link className="text-brand-700 hover:underline" to={`/projects/${task.projectId}/flowsheets/${task.flowsheetId}`}>{task.flowsheetName}</Link>
                : task.flowsheetName || '—'}
            </dd>
            {task.tag && <><dt className="text-ink-3">Tag</dt><dd className="font-mono text-ink">{task.tag}</dd></>}
            {task.externalRef && <><dt className="text-ink-3">{task.externalSystem === 'cmms' ? 'CMMS work order' : task.externalSystem}</dt><dd className="font-mono text-ink">{task.externalRef}</dd></>}
            {task.event && <><dt className="text-ink-3">Alarm</dt><dd className="text-ink">{task.event.state === 'cleared' ? 'cleared' : 'still active'} · <Link className="text-brand-700 hover:underline" to="/alarms">history</Link></dd></>}
            {task.requiresAck && <><dt className="text-ink-3">Manager ack</dt><dd className={task.acknowledgedAt ? 'text-ok' : 'text-red-600'}>{task.acknowledgedAt ? `${task.acknowledgedByName} · ${relTime(task.acknowledgedAt)}` : 'pending'}</dd></>}
            {task.completionNote && <><dt className="text-ink-3">Completion</dt><dd className="text-ink">{task.completionNote}</dd></>}
            {task.rejectedReason && <><dt className="text-ink-3">Rejected</dt><dd className="text-danger">{task.rejectedReason}</dd></>}
            {task.approvedByName && <><dt className="text-ink-3">Approved by</dt><dd className="text-ok">{task.approvedByName} · {relTime(task.approvedAt)}</dd></>}
          </dl>

          {/* Actions */}
          {task.allowedActions?.length > 0 && (
            <div className="mt-4 space-y-2" aria-label="Actions">
              {task.allowedActions.includes('assign') && (
                <div className="flex gap-2">
                  <select className="input py-1.5 text-sm flex-1" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Assignee">
                    <option value="">Choose an engineer…</option>
                    {assignees.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role} · {a.openTasks} open</option>)}
                  </select>
                  <button onClick={() => act('assign')} disabled={!!busy || !assignTo} className="btn-secondary text-sm disabled:opacity-50">
                    {busy === 'assign' ? <Loader2 className="w-4 h-4 animate-spin" /> : <User className="w-4 h-4" />} Assign
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {task.allowedActions.filter((a) => a !== 'assign').map((a) => {
                  const m = ACTION_META[a] || { label: a, icon: ChevronRight, tone: 'btn-secondary' };
                  const Icon = m.icon;
                  return (
                    <button key={a} onClick={() => act(a)} disabled={!!busy} className={`${m.tone} text-sm disabled:opacity-50`}>
                      {busy === a ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />} {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Timeline */}
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mt-5 mb-2">History</h4>
          <ol className="space-y-1.5 text-xs" aria-label="History">
            {task.transitions.map((x) => (
              <li key={x.id} className="flex gap-2">
                <span className="text-ink-3 whitespace-nowrap w-16 flex-shrink-0" title={absTime(x.createdAt)}>{relTime(x.createdAt)}</span>
                <span className="text-ink">
                  <b className="capitalize">{x.action}</b>
                  {x.toState && x.fromState !== x.toState ? ` → ${x.toState.replace('_', ' ')}` : ''}
                  {x.actorName ? ` · ${x.actorName}` : ''}
                  {x.note ? <span className="block text-ink-3">“{x.note}”</span> : null}
                </span>
              </li>
            ))}
          </ol>

          {/* Comments */}
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mt-5 mb-2">Comments</h4>
          <ul className="space-y-2 text-xs">
            {task.comments.map((c) => (
              <li key={c.id} className="bg-ground rounded-xl px-3 py-2">
                <div className="text-ink-3">{c.authorName} · {relTime(c.createdAt)}</div>
                <div className="text-ink whitespace-pre-wrap">{c.body}</div>
              </li>
            ))}
            {!task.comments.length && <li className="text-ink-3">No comments yet.</li>}
          </ul>
          <div className="flex gap-2 mt-2">
            <input className="input py-1.5 text-sm flex-1" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addComment(); }} aria-label="Add a comment" />
            <button onClick={addComment} disabled={!!busy || !comment.trim()} className="btn-secondary text-sm disabled:opacity-50" aria-label="Post comment">
              <MessageSquare className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

// ── New task dialog ───────────────────────────────────────────────────────────

function NewTaskDialog({ onClose, onCreated, showToast, assignees }) {
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium', assignedTo: '', dueAt: '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    if (form.title.trim().length < 3) { showToast('Give the task a title', false); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/tasks', {
        title: form.title.trim(), description: form.description.trim() || null, priority: form.priority,
        assignedTo: form.assignedTo || null, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
      });
      showToast(`${data.number} created`);
      onCreated?.(data);
    } catch (err) {
      showToast(err.response?.data?.error || err.response?.data?.details?.[0]?.msg || 'Could not create the task', false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="New task">
      <form onSubmit={save} className="card p-5 w-full max-w-lg space-y-3 bg-white">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">New maintenance task</h3>
          <button type="button" onClick={onClose} className="p-1 text-ink-3 hover:text-ink-2" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <label className="block text-xs text-ink-2">Title
          <input className="input mt-1 w-full" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required aria-label="Title" />
        </label>
        <label className="block text-xs text-ink-2">Description
          <textarea className="input mt-1 w-full" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} aria-label="Description" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-ink-2">Priority
            <select className="input mt-1 w-full" value={form.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
              {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </select>
          </label>
          <label className="block text-xs text-ink-2">Due
            <input type="datetime-local" className="input mt-1 w-full" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} aria-label="Due" />
          </label>
        </div>
        <label className="block text-xs text-ink-2">Assign to
          <select className="input mt-1 w-full" value={form.assignedTo} onChange={(e) => set('assignedTo', e.target.value)} aria-label="Assign to">
            <option value="">Least-loaded engineer (automatic)</option>
            {assignees.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role} · {a.openTasks} open</option>)}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create task
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { user, can } = useAuth();
  const canCreate = typeof can === 'function' && can('task.create');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ tasks: [], counts: {}, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState(params.get('mine') === '1');
  const [showClosed, setShowClosed] = useState(false);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(params.get('open') || null);
  const [creating, setCreating] = useState(false);
  const [assignees, setAssignees] = useState([]);
  const [toast, setToast] = useState(null);
  const showToast = useCallback((msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); }, []);

  const reqRef = useRef(0);
  const load = useCallback(async (silent = false) => {
    const seq = ++reqRef.current;
    if (!silent) setLoading(true);
    try {
      const p = new URLSearchParams({ limit: '300' });
      if (mine) p.set('assignedTo', 'me');
      if (q.trim()) p.set('q', q.trim());
      const { data: d } = await api.get(`/tasks?${p.toString()}`);
      if (seq !== reqRef.current) return;
      setData({ tasks: d.tasks || [], counts: d.counts || {}, total: d.total || 0 });
      setError(null);
    } catch (err) {
      if (seq !== reqRef.current) return;
      setError(err.response?.data?.error || 'Could not load tasks');
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [mine, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 30_000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!canCreate) return;
    api.get('/tasks/assignees').then(({ data: d }) => setAssignees(d.assignees || [])).catch(() => {});
  }, [canCreate]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (openId) next.set('open', openId); else next.delete('open');
    if (mine) next.set('mine', '1'); else next.delete('mine');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, mine]);

  const byColumn = useMemo(() => COLUMNS.map((c) => ({ ...c, tasks: data.tasks.filter((t) => c.states.includes(t.state)) })), [data.tasks]);
  const openCount = data.tasks.filter((t) => !['approved', 'cancelled'].includes(t.state)).length;
  const awaiting = data.counts.completed || 0;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 max-w-[1700px] mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight text-ink flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-brand-600" aria-hidden="true" /> Maintenance tasks
            </h2>
            <p className="text-sm text-ink-3 mt-0.5">
              {openCount} open{awaiting ? ` · ${awaiting} awaiting approval` : ''} · alarms raise tasks under their rule’s policy; people raise the rest.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
              <input type="search" className="input py-1.5 pl-8 text-sm w-48" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="accent-brand-600" /> Mine
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-brand-600" /> Show closed
            </label>
            <button onClick={() => load()} disabled={loading} className="btn-secondary text-sm disabled:opacity-50" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {canCreate && (
              <button onClick={() => setCreating(true)} className="btn-primary text-sm" aria-label="New task">
                <Plus className="w-4 h-4" /> New task
              </button>
            )}
          </div>
        </div>

        {error && <div role="alert" className="text-sm text-danger bg-danger-soft border border-danger/30 rounded-xl px-4 py-2.5">{error}</div>}

        <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
          {/* Board */}
          <div className="flex-1 min-w-0 overflow-x-auto">
            {!loading && !data.tasks.length ? (
              <EmptyState icon={ClipboardList} title="No tasks yet"
                description={mine ? 'Nothing is assigned to you.' : 'Tasks appear here when an alarm rule with a task policy fires, when someone raises one from an alarm event, or from “New task”.'}
                action={canCreate ? { label: 'New task', onClick: () => setCreating(true) } : undefined} />
            ) : (
              <div className="flex gap-3 min-w-[900px]" role="list" aria-label="Task board">
                {byColumn.filter((c) => !c.collapsed || showClosed).map((c) => (
                  <section key={c.key} className="flex-1 min-w-[180px] bg-ground/70 rounded-xl p-2" aria-label={c.label} data-column={c.key}>
                    <div className="flex items-center justify-between px-1 mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-ink-3">{c.label}</span>
                      <span className="text-[11px] font-mono text-ink-3">{c.tasks.length}</span>
                    </div>
                    <div className="space-y-2">
                      {c.tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={setOpenId} active={t.id === openId} />)}
                      {!c.tasks.length && <div className="text-[11px] text-ink-3 px-1 py-3 text-center">—</div>}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>

          {openId && (
            <TaskDetail key={openId} id={openId} onClose={() => setOpenId(null)} onChanged={() => load(true)} showToast={showToast} assignees={assignees} />
          )}
        </div>
      </div>

      {creating && (
        <NewTaskDialog onClose={() => setCreating(false)} showToast={showToast} assignees={assignees}
          onCreated={(t) => { setCreating(false); setOpenId(t.id); load(true); }} />
      )}

      {toast && (
        <div role="status" aria-live="polite"
          className={`fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {toast.ok ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
      <span className="sr-only">{user?.email}</span>
    </AppLayout>
  );
}
