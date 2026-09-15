/**
 * LoginForm — the sign-in fields. Shown inside AuthDialog on the landing page
 * (which is what /login renders), so signing in never leaves the page.
 *
 * The organisation is chosen from a list (GET /auth/organisations) rather
 * than typed from memory: one organisation is preselected, the last one
 * used on this browser is remembered, and "Another organisation…" (or a
 * list that could not be read) falls back to typing its ID, so sign-in
 * never depends on the list being there.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { authService } from '../../services/auth.service';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

const SLUG_KEY = 'ws.orgSlug';
const OTHER = '__other__';

/**
 * The sentence to show for a failed sign-in. The API answers most failures
 * with { error: { message } }; the rate limiter answers 429 with a bare
 * { error: 'Too many auth attempts…' } string, and a person locked out must
 * read that rather than "Login failed" and keep retrying into the lock.
 */
export function loginErrorMessage(err) {
  const status = err?.response?.status;
  const body = err?.response?.data?.error;
  if (body && typeof body === 'object' && body.message) return body.message;
  if (typeof body === 'string' && body.trim()) return status === 429 ? `${body}. Wait about 15 minutes before the next attempt.` : body;
  if (status === 429) return 'Too many sign-in attempts from this network. Wait about 15 minutes and try again.';
  if (!err?.response) return 'Could not reach the server. Check your connection and try again.';
  return 'Login failed. Please try again.';
}

const readSlug = () => { try { return localStorage.getItem(SLUG_KEY) || ''; } catch { return ''; } };
const writeSlug = (slug) => { try { localStorage.setItem(SLUG_KEY, slug); } catch { /* private mode */ } };

export default function LoginForm({ onRegister }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', orgSlug: readSlug() });
  const [orgs, setOrgs] = useState(null);       // null while loading; [] when there are none or the list could not be read
  const [manual, setManual] = useState(false);  // type the organisation ID instead of choosing it
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    authService.organisations()
      .then((rows) => {
        if (!alive) return;
        setOrgs(rows);
        if (!rows.length) { setManual(true); return; }
        const remembered = readSlug();
        if (rows.length === 1) setForm((f) => ({ ...f, orgSlug: rows[0].slug }));
        else if (remembered && !rows.some((o) => o.slug === remembered)) setManual(true); // remembered but not listed: keep it, typed
      })
      .catch(() => { if (alive) { setOrgs([]); setManual(true); } });
    return () => { alive = false; };
  }, []);

  const handleChange = (e) => { setForm((f) => ({ ...f, [e.target.name]: e.target.value })); setError(''); };

  const handleOrgSelect = (e) => {
    const value = e.target.value;
    if (value === OTHER) { setManual(true); setForm((f) => ({ ...f, orgSlug: '' })); }
    else setForm((f) => ({ ...f, orgSlug: value }));
    setError('');
  };

  const toggleManual = () => {
    setManual((m) => {
      const next = !m;
      // Back to the list: keep the ID only if it is one of the listed ones.
      if (!next) setForm((f) => (orgs?.some((o) => o.slug === f.orgSlug) ? f : { ...f, orgSlug: '' }));
      return next;
    });
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try { await login(form); writeSlug(form.orgSlug); navigate('/dashboard'); }
    catch (err) { setError(loginErrorMessage(err)); }
    finally { setLoading(false); }
  };

  const listed = Array.isArray(orgs) && orgs.length > 0;

  return (
    <>
      {error && <div className="mb-4 rounded-2xl bg-danger-soft text-danger px-4 py-3 text-sm" role="alert">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4" aria-label="Sign in form" noValidate>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="orgSlug">Organisation</label>
            {listed && (
              <button type="button" onClick={toggleManual} className="text-[13px] font-semibold text-ink-2 hover:text-ink mb-1.5">
                {manual ? 'Choose from the list' : 'Enter its ID instead'}
              </button>
            )}
          </div>
          {orgs === null && !manual ? (
            <select id="orgSlug" name="orgSlug" className="input text-ink-3" disabled aria-busy="true" value="">
              <option value="">Loading organisations…</option>
            </select>
          ) : !manual ? (
            <select id="orgSlug" name="orgSlug" className="input" value={form.orgSlug} onChange={handleOrgSelect} required>
              <option value="">Select your organisation</option>
              {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
              <option value={OTHER}>Another organisation…</option>
            </select>
          ) : (
            <input id="orgSlug" name="orgSlug" type="text" className="input" placeholder="your-organisation" autoComplete="organization"
              value={form.orgSlug} onChange={handleChange} required />
          )}
        </div>
        <div>
          <label className="label" htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" className="input" placeholder="engineer@example.com" autoComplete="username" value={form.email} onChange={handleChange} required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <div className="relative">
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} className="input pr-12" placeholder="••••••••" autoComplete="current-password" value={form.password} onChange={handleChange} required />
            <button type="button" onClick={() => setShowPassword((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-ink-3 hover:text-ink hover:bg-ground" aria-label={showPassword ? 'Hide password' : 'Show password'}>
              {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
        <button type="submit" disabled={loading} className="btn-primary btn-lg w-full mt-2">
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : 'Sign in'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-3">
        New to SafeKrit?{' '}
        <button type="button" onClick={onRegister} className="text-ink font-semibold hover:underline">Register your organisation</button>
      </p>
    </>
  );
}
