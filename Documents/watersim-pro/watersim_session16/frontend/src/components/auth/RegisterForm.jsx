/**
 * RegisterForm — creates an organisation and its first administrator. Shown
 * inside AuthDialog on the landing page (which is what /register renders).
 * On success the dialog switches to sign-in with a note.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { authService } from '../../services/auth.service';

// Module-scope so React keeps the same component identity across renders —
// declaring this inside the form remounted the input (and dropped focus)
// on every keystroke.
function Field({ id, label, type = 'text', placeholder, readOnly, value, onChange, autoComplete }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} name={id} type={type} className={`input ${readOnly ? 'bg-ground text-ink-3' : ''}`}
        placeholder={placeholder} value={value} onChange={onChange} required readOnly={readOnly} autoComplete={autoComplete} />
    </div>
  );
}

export default function RegisterForm({ onRegistered, onLogin }) {
  const [form, setForm] = useState({ orgName: '', orgSlug: '', email: '', password: '', firstName: '', lastName: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({
      ...f,
      [name]: value,
      ...(name === 'orgName' ? { orgSlug: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') } : {}),
    }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try { await authService.register(form); onRegistered?.({ orgSlug: form.orgSlug, email: form.email }); }
    catch (err) {
      const errs = err.response?.data?.errors;
      setError(errs ? errs.map((x) => x.msg).join(', ') : err.response?.data?.error?.message || 'Registration failed');
    } finally { setLoading(false); }
  };

  return (
    <>
      {error && <div className="mb-4 rounded-2xl bg-danger-soft text-danger px-4 py-3 text-sm" role="alert">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4" aria-label="Register form">
        <div className="grid grid-cols-2 gap-4">
          <Field id="firstName" label="First name" placeholder="Jane" value={form.firstName} onChange={handleChange} autoComplete="given-name" />
          <Field id="lastName" label="Last name" placeholder="Smith" value={form.lastName} onChange={handleChange} autoComplete="family-name" />
        </div>
        <Field id="email" label="Work email" type="email" placeholder="jane@yourcompany.com" value={form.email} onChange={handleChange} autoComplete="email" />
        <Field id="password" label="Password" type="password" placeholder="Min 8 chars, upper+lower+number" value={form.password} onChange={handleChange} autoComplete="new-password" />
        <div className="border-t border-line pt-4">
          <p className="stat-label mb-3">Organisation</p>
          <Field id="orgName" label="Organisation name" placeholder="City Water Authority" value={form.orgName} onChange={handleChange} autoComplete="organization" />
          <div className="mt-4">
            <label className="label" htmlFor="orgSlug">Organisation ID <span className="text-ink-3 font-normal">(auto-generated, editable)</span></label>
            <input id="orgSlug" name="orgSlug" type="text" className="input font-mono" placeholder="city-water-authority"
              value={form.orgSlug} onChange={handleChange} required pattern="[a-z0-9-]+" />
          </div>
        </div>
        <button type="submit" disabled={loading} className="btn-primary btn-lg w-full mt-2">
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating organisation…</> : 'Create organisation'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-3">
        Already have an account?{' '}
        <button type="button" onClick={onLogin} className="text-ink font-semibold hover:underline">Sign in</button>
      </p>
    </>
  );
}
