import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authService } from '../services/auth.service';
import { Droplets, Loader2 } from 'lucide-react';

// Module-scope so React keeps the same component identity across renders —
// declaring this inside RegisterPage remounted the input (and dropped focus)
// on every keystroke.
function Field({ id, label, type = 'text', placeholder, readOnly, value, onChange }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} name={id} type={type} className={`input ${readOnly ? 'bg-gray-50 text-gray-500' : ''}`}
        placeholder={placeholder} value={value} onChange={onChange} required readOnly={readOnly} />
    </div>
  );
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ orgName: '', orgSlug: '', email: '', password: '', firstName: '', lastName: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(f => ({
      ...f,
      [name]: value,
      ...(name === 'orgName' ? { orgSlug: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') } : {}),
    }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try { await authService.register(form); navigate('/login?registered=1'); }
    catch (err) {
      const errs = err.response?.data?.errors;
      setError(errs ? errs.map(e => e.msg).join(', ') : err.response?.data?.error?.message || 'Registration failed');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-700 via-brand-600 to-teal-500 flex items-start md:items-center justify-center p-4 py-8 overflow-y-auto">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur mb-4">
            <Droplets className="w-9 h-9 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">WaterSim Pro</h1>
          <p className="text-blue-100 mt-1 text-sm">Register your organisation</p>
        </div>
        <div className="card p-8 shadow-2xl">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Create your organisation</h2>
          {error && <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field id="firstName" label="First name" placeholder="Jane" value={form.firstName} onChange={handleChange} />
              <Field id="lastName" label="Last name" placeholder="Smith" value={form.lastName} onChange={handleChange} />
            </div>
            <Field id="email" label="Work email" type="email" placeholder="jane@yourcompany.com" value={form.email} onChange={handleChange} />
            <Field id="password" label="Password" type="password" placeholder="Min 8 chars, upper+lower+number" value={form.password} onChange={handleChange} />
            <div className="border-t pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Organisation details</p>
              <Field id="orgName" label="Organisation name" placeholder="City Water Authority" value={form.orgName} onChange={handleChange} />
              <div className="mt-4">
                <label className="label" htmlFor="orgSlug">Organisation slug <span className="text-gray-400 font-normal">(auto-generated, editable)</span></label>
                <div className="flex items-center gap-0">
                  <span className="px-3 py-2 bg-gray-100 border border-r-0 border-gray-300 rounded-l-lg text-sm text-gray-500">watersim.io/</span>
                  <input id="orgSlug" name="orgSlug" type="text" className="input rounded-l-none" placeholder="city-water-authority"
                    value={form.orgSlug} onChange={handleChange} required pattern="[a-z0-9-]+" />
                </div>
              </div>
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating account…</> : 'Create organisation'}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-500">
            Already have an account? <Link to="/login" className="text-brand-600 font-medium hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
