/**
 * IntegrationsTab — the CMMS boundary from the admin's side (Phase 5).
 *
 *   API keys     mint a scoped key for another system (shown once), revoke.
 *   Webhooks     register where signed events go (secret shown once), test,
 *                rotate, delete; recent deliveries with their state.
 *
 * Nothing here is visible below admin: the tab is mounted only when the
 * person holds users.manage, and the API refuses everyone else anyway.
 */
import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Webhook, Plus, Trash2, Send, RotateCcw, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import api from '../../services/api';

function StatePill({ state }) {
  const cls = state === 'sent' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : state === 'dead' ? 'text-red-700 bg-red-50 border-red-200'
      : state === 'failed' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-600 bg-gray-50 border-gray-200';
  return <span data-state={state} className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${cls}`}>{state}</span>;
}

function ShownOnce({ label, value, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { /* clipboard blocked */ } };
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs space-y-2" role="status" data-testid="shown-once">
      <div className="flex items-center gap-1 text-amber-800 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> {label} — shown once. Copy it now.</div>
      <div className="flex items-center gap-2">
        <code className="font-mono bg-white border border-amber-200 rounded px-2 py-1 break-all flex-1">{value}</code>
        <button onClick={copy} className="btn-secondary text-xs" aria-label="Copy">{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}</button>
        <button onClick={onDone} className="btn-secondary text-xs">Done</button>
      </div>
    </div>
  );
}

export default function IntegrationsTab({ showToast }) {
  const [keys, setKeys] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reveal, setReveal] = useState(null); // { label, value }
  const [newKey, setNewKey] = useState({ name: '', scopes: ['assets:read', 'history:read', 'counters:read', 'events:read'], expiresInDays: '' });
  const [newHook, setNewHook] = useState({ name: '', url: '', eventTypes: ['task.', 'alarm.raised', 'equipment.counters.daily'] });

  const load = useCallback(async () => {
    try {
      const [k, h, d] = await Promise.all([api.get('/integrations/api-keys'), api.get('/integrations/webhooks'), api.get('/integrations/deliveries?limit=30')]);
      setKeys(k.data.keys || []); setScopes(k.data.scopes || []);
      setHooks(h.data.webhooks || []); setEventTypes(h.data.eventTypes || []);
      setDeliveries(d.data.deliveries || []);
      setError(null);
    } catch (err) { setError(err.response?.data?.error || 'Could not load integrations'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mint = async () => {
    if (newKey.name.trim().length < 2 || !newKey.scopes.length) { showToast?.('Name the key and pick at least one scope', false); return; }
    setBusy('key');
    try {
      const { data } = await api.post('/integrations/api-keys', { name: newKey.name.trim(), scopes: newKey.scopes, expiresInDays: newKey.expiresInDays ? Number(newKey.expiresInDays) : null });
      setReveal({ label: `API key "${data.name}"`, value: data.key });
      setNewKey((k) => ({ ...k, name: '' }));
      await load();
    } catch (err) { showToast?.(err.response?.data?.details?.[0]?.msg || err.response?.data?.error || 'Could not create the key', false); }
    finally { setBusy(null); }
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke "${k.name}"? Any system using it stops working immediately.`)) return;
    try { await api.delete(`/integrations/api-keys/${k.id}`); showToast?.('Key revoked'); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Could not revoke', false); }
  };
  const addHook = async () => {
    if (newHook.name.trim().length < 2 || !newHook.url.trim()) { showToast?.('Name the webhook and give its URL', false); return; }
    setBusy('hook');
    try {
      const { data } = await api.post('/integrations/webhooks', { name: newHook.name.trim(), url: newHook.url.trim(), eventTypes: newHook.eventTypes });
      setReveal({ label: `Signing secret for "${data.name}"`, value: data.secret });
      setNewHook((h) => ({ ...h, name: '', url: '' }));
      await load();
    } catch (err) { showToast?.(err.response?.data?.details?.[0]?.msg || err.response?.data?.error || 'Could not add the webhook', false); }
    finally { setBusy(null); }
  };
  const testHook = async (h) => {
    setBusy(`test:${h.id}`);
    try { const { data } = await api.post(`/integrations/webhooks/${h.id}/test`); showToast?.(`Test delivery: ${data.delivery?.state}${data.delivery?.last_error ? ` — ${data.delivery.last_error}` : ''}`, data.delivery?.state === 'sent'); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Test failed', false); }
    finally { setBusy(null); }
  };
  const rotate = async (h) => {
    if (!window.confirm(`Rotate the secret of "${h.name}"? The receiver must be updated.`)) return;
    try { const { data } = await api.post(`/integrations/webhooks/${h.id}/rotate`); setReveal({ label: `New signing secret for "${h.name}"`, value: data.secret }); }
    catch (err) { showToast?.(err.response?.data?.error || 'Could not rotate', false); }
  };
  const removeHook = async (h) => {
    if (!window.confirm(`Delete webhook "${h.name}"?`)) return;
    try { await api.delete(`/integrations/webhooks/${h.id}`); await load(); }
    catch (err) { showToast?.(err.response?.data?.error || 'Could not delete', false); }
  };
  const toggleScope = (s) => setNewKey((k) => ({ ...k, scopes: k.scopes.includes(s) ? k.scopes.filter((x) => x !== s) : [...k.scopes, s] }));
  const toggleType = (t) => setNewHook((h) => ({ ...h, eventTypes: h.eventTypes.includes(t) ? h.eventTypes.filter((x) => x !== t) : [...h.eventTypes, t] }));

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</div>}
      {reveal && <ShownOnce label={reveal.label} value={reveal.value} onDone={() => setReveal(null)} />}

      {/* ── API keys ── */}
      <section aria-label="API keys" className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1"><KeyRound className="w-4 h-4 text-gray-400" /> API keys</h3>
        <p className="text-xs text-gray-500">Another system (the CMMS) presents a key as <code>Authorization: Bearer wsk_…</code> or <code>X-API-Key</code>. A key does only what its scopes say.</p>
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]"><tr><th className="text-left px-3 py-2">Name</th><th className="text-left px-3 py-2">Prefix</th><th className="text-left px-3 py-2">Scopes</th><th className="text-left px-3 py-2">Last used</th><th className="text-left px-3 py-2">Expires</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={`border-t border-gray-100 ${k.revokedAt ? 'opacity-50' : ''}`} data-key={k.id}>
                  <td className="px-3 py-2 font-medium">{k.name}{k.revokedAt && <span className="ml-2 text-red-600">revoked</span>}</td>
                  <td className="px-3 py-2 font-mono">wsk_{k.prefix}_…</td>
                  <td className="px-3 py-2 font-mono">{k.scopes.join(' ')}</td>
                  <td className="px-3 py-2 text-gray-500">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td className="px-3 py-2 text-gray-500">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-right">{!k.revokedAt && <button onClick={() => revoke(k)} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Revoke ${k.name}`}><Trash2 className="w-3.5 h-3.5" /></button>}</td>
                </tr>
              ))}
              {!keys.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No keys yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs" aria-label="New API key">
          <label>Name<input className="input py-1 text-xs block w-48" value={newKey.name} onChange={(e) => setNewKey((k) => ({ ...k, name: e.target.value }))} placeholder="CMMS hydrogen" aria-label="Key name" /></label>
          {scopes.map((s) => <label key={s} className="inline-flex items-center gap-1 pb-1.5"><input type="checkbox" checked={newKey.scopes.includes(s)} onChange={() => toggleScope(s)} className="accent-brand-600" aria-label={`Scope ${s}`} /> {s}</label>)}
          <label>Expires in days<input type="number" min="1" max="3650" className="input py-1 text-xs block w-24" value={newKey.expiresInDays} onChange={(e) => setNewKey((k) => ({ ...k, expiresInDays: e.target.value }))} aria-label="Expires in days" /></label>
          <button onClick={mint} disabled={busy === 'key'} className="btn-primary text-xs disabled:opacity-50" aria-label="Create API key">{busy === 'key' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create key</button>
        </div>
      </section>

      {/* ── Webhooks ── */}
      <section aria-label="Webhooks" className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1"><Webhook className="w-4 h-4 text-gray-400" /> Webhooks</h3>
        <p className="text-xs text-gray-500">Events are POSTed as JSON with an <code>X-WaterSim-Signature</code> (HMAC-SHA256 of <code>timestamp.body</code>), retried with backoff, dead-lettered after repeated refusals.</p>
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]"><tr><th className="text-left px-3 py-2">Name</th><th className="text-left px-3 py-2">URL</th><th className="text-left px-3 py-2">Events</th><th className="text-left px-3 py-2">Last delivery</th><th /></tr></thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={h.id} className="border-t border-gray-100" data-hook={h.id}>
                  <td className="px-3 py-2 font-medium">{h.name}{!h.enabled && <span className="ml-2 text-gray-400">disabled</span>}</td>
                  <td className="px-3 py-2 font-mono truncate max-w-[18rem]" title={h.url}>{h.url}</td>
                  <td className="px-3 py-2 font-mono">{h.eventTypes.join(' ')}</td>
                  <td className="px-3 py-2">{h.lastDeliveryAt ? <>{h.lastStatus ? <span className={h.lastStatus < 300 ? 'text-emerald-700' : 'text-red-700'}>HTTP {h.lastStatus}</span> : <span className="text-red-700">{h.lastError}</span>} · {new Date(h.lastDeliveryAt).toLocaleString()}{h.failures ? ` · ${h.failures} failures` : ''}</> : <span className="text-gray-400">never</span>}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => testHook(h)} disabled={!!busy} className="btn-secondary text-[11px] py-0.5 px-2 mr-1" aria-label={`Test ${h.name}`}>{busy === `test:${h.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Test</button>
                    <button onClick={() => rotate(h)} className="btn-secondary text-[11px] py-0.5 px-2 mr-1" aria-label={`Rotate secret of ${h.name}`}><RotateCcw className="w-3 h-3" /></button>
                    <button onClick={() => removeHook(h)} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Delete ${h.name}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {!hooks.length && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No webhooks yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs" aria-label="New webhook">
          <label>Name<input className="input py-1 text-xs block w-40" value={newHook.name} onChange={(e) => setNewHook((h) => ({ ...h, name: e.target.value }))} placeholder="CMMS" aria-label="Webhook name" /></label>
          <label>URL<input className="input py-1 text-xs block w-72 font-mono" value={newHook.url} onChange={(e) => setNewHook((h) => ({ ...h, url: e.target.value }))} placeholder="https://cmms.example.com/api/v1/integrations/watersim/webhook" aria-label="Webhook URL" /></label>
          <div className="flex flex-wrap gap-x-3 gap-y-1 pb-1.5 max-w-xl">
            {['*', 'task.', 'alarm.', ...eventTypes].map((t) => <label key={t} className="inline-flex items-center gap-1"><input type="checkbox" checked={newHook.eventTypes.includes(t)} onChange={() => toggleType(t)} className="accent-brand-600" aria-label={`Event ${t}`} /> <span className="font-mono">{t}</span></label>)}
          </div>
          <button onClick={addHook} disabled={busy === 'hook'} className="btn-primary text-xs disabled:opacity-50" aria-label="Add webhook">{busy === 'hook' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add webhook</button>
        </div>
      </section>

      {/* ── Deliveries ── */}
      {deliveries.length > 0 && (
        <section aria-label="Webhook deliveries" className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">Recent deliveries</h3>
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide text-[10px]"><tr><th className="text-left px-3 py-2">When</th><th className="text-left px-3 py-2">Endpoint</th><th className="text-left px-3 py-2">Event</th><th className="text-left px-3 py-2">State</th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{d.endpointName || d.url}</td>
                    <td className="px-3 py-2 font-mono">{d.eventType}</td>
                    <td className="px-3 py-2"><StatePill state={d.state} />{d.lastError && <span className="ml-2 text-red-600">{d.lastError}</span>}{d.attempts > 1 ? <span className="ml-2 text-gray-400">{d.attempts} attempts</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
