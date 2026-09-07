/**
 * NotificationsTab — the Settings panel for Phase 2 notifications.
 *
 *   My channels    the RECEIVER email and WhatsApp number — they start as the
 *                  login email and profile mobile but may differ, and editing
 *                  them never changes the login — with "send test" per channel.
 *   Policy         who hears what: (role | user) × event type × minimum
 *                  severity → channels. Read by everyone, edited by managers
 *                  and admins (capability notify.policy). One click installs
 *                  the default rows for every role.
 *   Receivers      (managers) every active member with their email and
 *                  WhatsApp number, editable in place and testable, so all
 *                  kinds of user are reachable without each visiting here.
 *   Outbox         recent deliveries with state and error; retry from here.
 *
 *   Templates      (managers, Meta) the WhatsApp Business Account's message
 *                  templates with Meta's approval status and which events
 *                  they are mapped to — outside a 24-hour reply window Meta
 *                  delivers nothing else.
 *
 * Provider status (SMTP, WhatsApp via Meta's Cloud API or Twilio, dry-run)
 * comes from the API so the page says plainly why a message is dead instead
 * of leaving people to guess; a WhatsApp row also shows Meta's delivery
 * receipt (delivered / read / failed) once the webhook has reported it.
 */
import { useState, useEffect, useCallback } from 'react';
import { Mail, MessageCircle, Send, Loader2, Plus, Trash2, RefreshCw, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const SEVERITIES = ['info', 'warning', 'critical'];
const ROLES = ['viewer', 'operator', 'engineer', 'manager', 'admin'];

function ProviderBanner({ providers }) {
  if (!providers) return null;
  const items = [
    { key: 'email', label: 'Email (SMTP)', s: providers.email },
    { key: 'whatsapp', label: providers.whatsapp?.provider === 'twilio' ? 'WhatsApp (Twilio)' : 'WhatsApp (Meta Cloud API)', s: providers.whatsapp },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs" aria-label="Provider status">
      {providers.dryRun && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
          <AlertTriangle className="w-3.5 h-3.5" /> Dry run: messages are logged, not sent
        </span>
      )}
      {items.map((p) => (
        <span key={p.key} className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border ${p.s?.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-gray-50 text-gray-600 border-gray-200'}`}>
          {p.s?.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {p.label}: {p.s?.ok ? (p.s.reason || 'configured') : (p.s?.reason || 'not configured')}
        </span>
      ))}
    </div>
  );
}

function StatePill({ state }) {
  const cls = state === 'sent' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : state === 'dead' ? 'text-red-700 bg-red-50 border-red-200'
      : state === 'failed' ? 'text-amber-700 bg-amber-50 border-amber-200'
        : 'text-gray-600 bg-gray-50 border-gray-200';
  return <span data-state={state} className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${cls}`}>{state}</span>;
}

function DeliveryPill({ d }) {
  if (!d?.status) return null;
  const cls = d.status === 'read' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : d.status === 'delivered' ? 'text-sky-700 bg-sky-50 border-sky-200'
      : d.status === 'failed' ? 'text-red-700 bg-red-50 border-red-200'
        : 'text-gray-600 bg-gray-50 border-gray-200';
  return <span data-delivery={d.status} title={d.at ? `Meta reported ${d.status} at ${new Date(d.at).toLocaleString()}` : ''} className={`ml-1 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${cls}`}>{d.status}</span>;
}

const TEMPLATE_STATUS = {
  APPROVED: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  PENDING: 'text-amber-700 bg-amber-50 border-amber-200',
  REJECTED: 'text-red-700 bg-red-50 border-red-200',
  PAUSED: 'text-red-700 bg-red-50 border-red-200',
  DISABLED: 'text-red-700 bg-red-50 border-red-200',
};

export default function NotificationsTab({ showToast }) {
  const { can } = useAuth();
  const canPolicy = typeof can === 'function' && can('notify.policy');

  const [me, setMe] = useState(null);
  const [events, setEvents] = useState([]);
  const [subs, setSubs] = useState([]);
  const [outbox, setOutbox] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [receivers, setReceivers] = useState([]);
  const [missingDefaults, setMissingDefaults] = useState([]);
  const [form, setForm] = useState({ email: { enabled: true, address: '' }, whatsapp: { enabled: false, address: '' } });
  const [newSub, setNewSub] = useState({ target: 'role:engineer', eventType: 'alarm.raised', minSeverity: 'warning', channels: ['email'] });

  const load = useCallback(async () => {
    try {
      const [m, e, s] = await Promise.all([api.get('/notifications/me'), api.get('/notifications/events'), api.get('/notifications/subscriptions')]);
      setMe(m.data);
      setForm({ email: { enabled: m.data.email.enabled, address: m.data.email.address || '' }, whatsapp: { enabled: m.data.whatsapp.enabled, address: m.data.whatsapp.address || '' } });
      setEvents(e.data.events || []);
      setSubs(s.data.subscriptions || []);
      setMissingDefaults(s.data.missingDefaults || []);
      setError(null);
      if (canPolicy) {
        const [o, rx] = await Promise.all([api.get('/notifications/outbox?limit=50'), api.get('/notifications/receivers')]);
        setOutbox(o.data);
        setReceivers(rx.data.receivers || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load notification settings');
    }
  }, [canPolicy]);
  useEffect(() => { load(); }, [load]);

  const saveChannels = async () => {
    setBusy('save');
    try {
      const body = {
        email: { enabled: form.email.enabled, ...(form.email.address.trim() ? { address: form.email.address.trim() } : {}) },
        ...(form.whatsapp.address || !form.whatsapp.enabled ? { whatsapp: { enabled: form.whatsapp.enabled, ...(form.whatsapp.address ? { address: form.whatsapp.address.trim() } : {}) } } : {}),
      };
      const { data } = await api.put('/notifications/me/channels', body);
      setMe(data);
      showToast?.('Notification channels saved');
    } catch (err) {
      showToast?.(err.response?.data?.details?.[0]?.msg || err.response?.data?.error || 'Could not save', false);
    } finally { setBusy(null); }
  };

  const sendTest = async (channel) => {
    setBusy(`test:${channel}`);
    setTestResult(null);
    try {
      const { data } = await api.post('/notifications/test', { channel });
      setTestResult(data);
      showToast?.(data.state === 'sent' ? `Test ${channel} sent to ${data.address}` : `Test ${channel}: ${data.state}${data.last_error ? ` — ${data.last_error}` : ''}`, data.state === 'sent');
    } catch (err) {
      showToast?.(err.response?.data?.error || 'Test failed', false);
    } finally { setBusy(null); }
  };

  const addSub = async () => {
    setBusy('sub');
    try {
      const [kind, value] = newSub.target.split(':');
      await api.post('/notifications/subscriptions', {
        ...(kind === 'role' ? { role: value } : { userId: value }),
        eventType: newSub.eventType, minSeverity: newSub.minSeverity, channels: newSub.channels,
      });
      showToast?.('Policy row added');
      await load();
    } catch (err) {
      showToast?.(err.response?.data?.details?.[0]?.msg || err.response?.data?.error || 'Could not add', false);
    } finally { setBusy(null); }
  };

  const toggleSub = async (s, patch) => {
    try { await api.patch(`/notifications/subscriptions/${s.id}`, patch); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Could not update', false); }
  };
  const removeSub = async (s) => {
    if (!window.confirm('Remove this policy row?')) return;
    try { await api.delete(`/notifications/subscriptions/${s.id}`); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Could not remove', false); }
  };
  const retry = async (row) => {
    setBusy(`retry:${row.id}`);
    try { const { data } = await api.post(`/notifications/outbox/${row.id}/retry`); showToast?.(`Retried: ${data.state}`, data.state === 'sent'); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Retry failed', false); }
    finally { setBusy(null); }
  };

  const installDefaults = async () => {
    setBusy('defaults');
    try {
      const { data } = await api.post('/notifications/subscriptions/defaults');
      showToast?.(`Default policy: ${data.added} row(s) added, ${data.existing} already there`);
      await load();
    } catch (err) {
      showToast?.(err.response?.data?.error || 'Could not install the default policy', false);
    } finally { setBusy(null); }
  };

  const editReceiver = (id, channel, patch) => setReceivers((list) => list.map((r) => (r.id === id ? { ...r, [channel]: { ...r[channel], ...patch }, dirty: true } : r)));

  const saveReceiver = async (r) => {
    setBusy(`rx:${r.id}`);
    try {
      const body = {
        email: { enabled: r.email.enabled, ...(r.email.address ? { address: r.email.address.trim() } : {}) },
        ...(r.whatsapp.address || !r.whatsapp.enabled ? { whatsapp: { enabled: r.whatsapp.enabled, ...(r.whatsapp.address ? { address: r.whatsapp.address.replace(/\s+/g, '') } : {}) } } : {}),
      };
      const { data } = await api.put(`/notifications/receivers/${r.id}`, body);
      setReceivers((list) => list.map((x) => (x.id === r.id ? data : x)));
      showToast?.(`${r.name}: receiver saved`);
    } catch (err) {
      showToast?.(err.response?.data?.details?.[0]?.msg || err.response?.data?.error || 'Could not save', false);
    } finally { setBusy(null); }
  };

  const testReceiver = async (r, channel) => {
    setBusy(`rxtest:${r.id}:${channel}`);
    try {
      const { data } = await api.post('/notifications/test', { channel, userId: r.id });
      showToast?.(data.state === 'sent' ? `Test ${channel} sent to ${data.address}` : `Test ${channel}: ${data.state}${data.last_error ? ` — ${data.last_error}` : ''}`, data.state === 'sent');
    } catch (err) {
      showToast?.(err.response?.data?.error || 'Test failed', false);
    } finally { setBusy(null); }
  };

  const checkTemplates = async () => {
    setBusy('templates');
    try {
      const { data } = await api.get('/notifications/whatsapp/templates?refresh=true');
      setTemplates(data);
    } catch (err) {
      setTemplates({ error: err.response?.data?.error || 'Could not read the templates from Meta' });
    } finally { setBusy(null); }
  };

  const toggleChannel = (c) => setNewSub((n) => ({ ...n, channels: n.channels.includes(c) ? n.channels.filter((x) => x !== c) : [...n.channels, c] }));

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</div>}
      <ProviderBanner providers={me?.providers} />

      {/* ── My channels ── */}
      <section aria-label="My channels" className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">My channels</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="card p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input type="checkbox" checked={form.email.enabled} onChange={(e) => setForm((f) => ({ ...f, email: { ...f.email, enabled: e.target.checked } }))} className="accent-brand-600" />
              <Mail className="w-4 h-4 text-gray-500" /> Email
            </label>
            <input className="input py-1.5 text-sm w-full font-mono" type="email" placeholder={me?.login?.email || 'you@example.com'} value={form.email.address}
              onChange={(e) => setForm((f) => ({ ...f, email: { ...f.email, address: e.target.value } }))} aria-label="Notification email address" />
            <div className="text-xs text-gray-500" data-testid="login-email">
              {me?.login?.email && form.email.address.trim() && form.email.address.trim().toLowerCase() !== me.login.email
                ? <>Notifications go to the address above; you still sign in as <span className="font-mono">{me.login.email}</span>.</>
                : <>Same as your login email — enter another address to receive notifications elsewhere.</>}
            </div>
            <button onClick={() => sendTest('email')} disabled={!!busy} className="btn-secondary text-xs disabled:opacity-50" aria-label="Send test email">
              {busy === 'test:email' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send test
            </button>
          </div>
          <div className="card p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input type="checkbox" checked={form.whatsapp.enabled} onChange={(e) => setForm((f) => ({ ...f, whatsapp: { ...f.whatsapp, enabled: e.target.checked } }))} className="accent-brand-600" />
              <MessageCircle className="w-4 h-4 text-gray-500" /> WhatsApp
            </label>
            <input className="input py-1.5 text-sm w-full font-mono" placeholder="+91 98765 43210 or 98765 43210" value={form.whatsapp.address}
              onChange={(e) => setForm((f) => ({ ...f, whatsapp: { ...f.whatsapp, address: e.target.value.replace(/\s+/g, '') } }))} aria-label="WhatsApp number" />
            <div className="text-xs text-gray-500" data-testid="whatsapp-verified">
              {me?.whatsapp?.verified
                ? 'Verified — this number has replied to the plant’s WhatsApp number.'
                : 'Send “hi” to the plant’s WhatsApp number once from this phone: that verifies the number and opens a 24-hour window for plain-text messages.'}
            </div>
            {me?.login?.phone && (
              <div className="text-xs text-gray-500" data-testid="profile-mobile">
                Mobile on your profile: <span className="font-mono">{me.login.phone}</span>
                {form.whatsapp.address && form.whatsapp.address !== me.login.phone
                  ? ' — WhatsApp messages go to the number above instead.'
                  : ' — used for WhatsApp unless you enter another number above.'}
              </div>
            )}
            <button onClick={() => sendTest('whatsapp')} disabled={!!busy || !me?.whatsapp?.address} className="btn-secondary text-xs disabled:opacity-50" aria-label="Send test WhatsApp">
              {busy === 'test:whatsapp' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send test
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveChannels} disabled={busy === 'save'} className="btn-primary text-sm disabled:opacity-50" aria-label="Save channels">
            {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save channels
          </button>
          {testResult && (
            <span className="text-xs text-gray-600 inline-flex items-center gap-2" data-testid="test-result">
              <StatePill state={testResult.state} /> {testResult.channel} → {testResult.address}{testResult.last_error ? ` · ${testResult.last_error}` : ''}
            </span>
          )}
        </div>
        {me?.subscriptions?.length > 0 && (
          <div className="text-xs text-gray-500">
            You currently hear about: {me.subscriptions.map((s) => `${s.eventType} (${s.minSeverity}+)`).join(', ')}.
          </div>
        )}
      </section>

      {/* ── Policy ── */}
      <section aria-label="Notification policy" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Who hears what</h3>
          <div className="flex items-center gap-2">
            {canPolicy && (
              <button onClick={installDefaults} disabled={busy === 'defaults' || !missingDefaults.length} className="btn-secondary text-xs disabled:opacity-50" aria-label="Install the default policy for every role"
                title={missingDefaults.length ? `Adds: ${missingDefaults.join(', ')}` : 'Every role already has its default rows'}>
                {busy === 'defaults' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {missingDefaults.length ? `Install the default policy for every role (${missingDefaults.length} missing)` : 'Default policy installed'}
              </button>
            )}
            <button onClick={load} className="btn-secondary text-xs" aria-label="Reload policy"><RefreshCw className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        <div className="overflow-x-auto card">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]">
              <tr><th className="text-left px-3 py-2">Who</th><th className="text-left px-3 py-2">Event</th><th className="text-left px-3 py-2">From severity</th><th className="text-left px-3 py-2">Channels</th><th className="px-3 py-2">On</th>{canPolicy && <th className="px-3 py-2" />}</tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t border-gray-100" data-sub={s.id}>
                  <td className="px-3 py-2 capitalize">{s.role ? `every ${s.role}` : s.userName || 'a user'}</td>
                  <td className="px-3 py-2 font-mono">{s.eventType}</td>
                  <td className="px-3 py-2">
                    {canPolicy ? (
                      <select className="input py-0.5 text-xs" value={s.minSeverity} onChange={(e) => toggleSub(s, { minSeverity: e.target.value })} aria-label={`Minimum severity for ${s.eventType}`}>
                        {SEVERITIES.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    ) : s.minSeverity}
                  </td>
                  <td className="px-3 py-2">
                    {['email', 'whatsapp'].map((c) => (
                      <label key={c} className="inline-flex items-center gap-1 mr-3">
                        <input type="checkbox" checked={s.channels.includes(c)} disabled={!canPolicy}
                          onChange={(e) => toggleSub(s, { channels: e.target.checked ? [...s.channels, c] : s.channels.filter((x) => x !== c) })}
                          aria-label={`${c} for ${s.eventType}`} className="accent-brand-600" /> {c}
                      </label>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={s.enabled} disabled={!canPolicy} onChange={(e) => toggleSub(s, { enabled: e.target.checked })} aria-label={`Enable ${s.eventType}`} className="accent-brand-600" />
                  </td>
                  {canPolicy && <td className="px-3 py-2 text-right"><button onClick={() => removeSub(s)} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove ${s.eventType}`}><Trash2 className="w-3.5 h-3.5" /></button></td>}
                </tr>
              ))}
              {!subs.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No policy rows — nobody is notified beyond their own task assignments.</td></tr>}
            </tbody>
          </table>
        </div>
        {canPolicy && (
          <div className="flex flex-wrap items-end gap-2 text-xs" aria-label="Add policy row">
            <label>Who
              <select className="input py-1 text-xs block" value={newSub.target} onChange={(e) => setNewSub((n) => ({ ...n, target: e.target.value }))} aria-label="Who">
                {ROLES.map((r) => <option key={r} value={`role:${r}`}>every {r}</option>)}
              </select>
            </label>
            <label>Event
              <select className="input py-1 text-xs block" value={newSub.eventType} onChange={(e) => setNewSub((n) => ({ ...n, eventType: e.target.value }))} aria-label="Event">
                <option value="*">everything</option>
                <option value="alarm.">every alarm event</option>
                <option value="task.">every task event</option>
                {events.map((e) => <option key={e.type} value={e.type}>{e.label}</option>)}
              </select>
            </label>
            <label>From severity
              <select className="input py-1 text-xs block" value={newSub.minSeverity} onChange={(e) => setNewSub((n) => ({ ...n, minSeverity: e.target.value }))} aria-label="From severity">
                {SEVERITIES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
            {['email', 'whatsapp'].map((c) => (
              <label key={c} className="inline-flex items-center gap-1 pb-1.5"><input type="checkbox" checked={newSub.channels.includes(c)} onChange={() => toggleChannel(c)} className="accent-brand-600" aria-label={`New row ${c}`} /> {c}</label>
            ))}
            <button onClick={addSub} disabled={busy === 'sub' || !newSub.channels.length} className="btn-primary text-xs disabled:opacity-50" aria-label="Add policy row">
              {busy === 'sub' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
            </button>
          </div>
        )}
      </section>

      {/* ── Receivers ── */}
      {canPolicy && (
        <section aria-label="Receivers" className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">
            Receivers
            <span className="ml-2 text-xs font-normal text-gray-500">every active member by role — the receiver addresses may differ from the login email and mobile shown under each name; an admin changes those under Users</span>
          </h3>
          <div className="overflow-x-auto card">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]">
                <tr><th className="text-left px-3 py-2">Who</th><th className="text-left px-3 py-2">Email</th><th className="text-left px-3 py-2">WhatsApp</th><th className="text-left px-3 py-2">Hears</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody>
                {receivers.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 align-top" data-receiver={r.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{r.name}</div>
                      <div className="text-gray-500 capitalize">{r.role}</div>
                      <div className="text-[10px] text-gray-400 font-mono" data-testid={`profile-${r.id}`}>login {r.login}{r.mobile ? ` · mobile ${r.mobile}` : ''}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!r.email.enabled} onChange={(e) => editReceiver(r.id, 'email', { enabled: e.target.checked })} aria-label={`Email for ${r.name}`} className="accent-brand-600" />
                        <input className="input py-1 text-xs w-52 font-mono" value={r.email.address || ''} onChange={(e) => editReceiver(r.id, 'email', { address: e.target.value })} aria-label={`Email address for ${r.name}`} />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!r.whatsapp.enabled} onChange={(e) => editReceiver(r.id, 'whatsapp', { enabled: e.target.checked })} aria-label={`WhatsApp for ${r.name}`} className="accent-brand-600" />
                        <input className="input py-1 text-xs w-40 font-mono" placeholder="+91… or 10 digits" value={r.whatsapp.address || ''} onChange={(e) => editReceiver(r.id, 'whatsapp', { address: e.target.value })} aria-label={`WhatsApp number for ${r.name}`} />
                        {r.whatsapp.address && (
                          <span data-verified={r.whatsapp.verified ? 'yes' : 'no'} className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${r.whatsapp.verified ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`} title={r.whatsapp.verified ? 'This number has replied to the plant’s WhatsApp number' : 'Not yet verified — a reply from the phone verifies it'}>
                            {r.whatsapp.verified ? 'verified' : 'unverified'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500 max-w-[16rem]">
                      {r.hears?.length
                        ? r.hears.map((h) => `${h.eventType} (${h.minSeverity}+)`).join(', ')
                        : <span className="text-amber-700">nothing yet — add a policy row for every {r.role}</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => saveReceiver(r)} disabled={!!busy || !r.dirty} className="btn-primary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Save receiver ${r.name}`}>
                        {busy === `rx:${r.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save
                      </button>
                      <button onClick={() => testReceiver(r, 'email')} disabled={!!busy || !r.reachable?.email} className="ml-1 btn-secondary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Test email to ${r.name}`} title="Send a test email">
                        {busy === `rxtest:${r.id}:email` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                      </button>
                      <button onClick={() => testReceiver(r, 'whatsapp')} disabled={!!busy || !r.reachable?.whatsapp} className="ml-1 btn-secondary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Test WhatsApp to ${r.name}`} title="Send a test WhatsApp">
                        {busy === `rxtest:${r.id}:whatsapp` ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageCircle className="w-3 h-3" />}
                      </button>
                    </td>
                  </tr>
                ))}
                {!receivers.length && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No active members.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Outbox ── */}
      {canPolicy && outbox && (
        <section aria-label="Outbox" className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">
            Recent deliveries
            <span className="ml-2 text-xs font-normal text-gray-500">
              {outbox.counts.sent} sent · {outbox.counts.pending + outbox.counts.failed} waiting · {outbox.counts.dead} dead
            </span>
          </h3>
          <div className="overflow-x-auto card">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]">
                <tr><th className="text-left px-3 py-2">When</th><th className="text-left px-3 py-2">To</th><th className="text-left px-3 py-2">Event</th><th className="text-left px-3 py-2">Subject</th><th className="text-left px-3 py-2">State</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody>
                {outbox.outbox.map((o) => (
                  <tr key={o.id} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{new Date(o.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2"><span className="font-mono">{o.address}</span>{o.userName ? <span className="text-gray-400"> · {o.userName}</span> : null}<span className="text-gray-400"> · {o.channel}</span></td>
                    <td className="px-3 py-2 font-mono">{o.eventType}</td>
                    <td className="px-3 py-2 truncate max-w-[18rem]" title={o.subject}>{o.subject}</td>
                    <td className="px-3 py-2"><StatePill state={o.state} /><DeliveryPill d={o.delivery} />{o.lastError && <div className="text-[10px] text-red-600 mt-0.5 max-w-[16rem] truncate" title={o.lastError}>{o.lastError}</div>}</td>
                    <td className="px-3 py-2 text-right">
                      {(o.state === 'dead' || o.state === 'failed') && (
                        <button onClick={() => retry(o)} disabled={!!busy} className="btn-secondary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Retry ${o.subject}`}>
                          {busy === `retry:${o.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!outbox.outbox.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">Nothing sent yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── WhatsApp templates (Meta) ── */}
      {canPolicy && me?.providers?.whatsapp?.provider !== 'twilio' && (
        <section aria-label="WhatsApp templates" className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">WhatsApp templates</h3>
            <button onClick={checkTemplates} disabled={busy === 'templates'} className="btn-secondary text-xs disabled:opacity-50" aria-label="Check Meta templates">
              {busy === 'templates' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Check Meta templates
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Outside a 24-hour reply window Meta delivers only approved templates. WaterSim fills two parameters — the subject and the details —
            so a template mapped in <span className="font-mono">WHATSAPP_TEMPLATES</span> must take exactly two.
          </p>
          {templates?.error && <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{templates.error}</div>}
          {templates && !templates.error && !templates.ok && <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{templates.reason}</div>}
          {templates?.ok && (
            <div className="overflow-x-auto card">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]">
                  <tr><th className="text-left px-3 py-2">Template</th><th className="text-left px-3 py-2">Meta status</th><th className="text-left px-3 py-2">Language</th><th className="text-left px-3 py-2">Category</th><th className="text-left px-3 py-2">Params</th><th className="text-left px-3 py-2">Used for</th></tr>
                </thead>
                <tbody>
                  {templates.templates.map((t) => (
                    <tr key={t.id || t.name} className="border-t border-gray-100" data-template={t.name}>
                      <td className="px-3 py-2 font-mono">{t.name}</td>
                      <td className="px-3 py-2"><span data-status={t.status} className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${TEMPLATE_STATUS[t.status] || 'text-gray-600 bg-gray-50 border-gray-200'}`}>{t.status}</span></td>
                      <td className="px-3 py-2">{t.language}</td>
                      <td className="px-3 py-2">{t.category}</td>
                      <td className={`px-3 py-2 ${t.mappedTo?.length && t.params !== 2 ? 'text-red-600 font-semibold' : ''}`} title={t.mappedTo?.length && t.params !== 2 ? 'WaterSim sends two parameters; Meta will refuse this template' : ''}>{t.params}</td>
                      <td className="px-3 py-2 font-mono">{t.mappedTo?.length ? t.mappedTo.join(', ') : <span className="text-gray-400">—</span>}</td>
                    </tr>
                  ))}
                  {!templates.templates.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No templates on this WhatsApp Business Account yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
