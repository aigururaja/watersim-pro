import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Droplets, Eye, EyeOff, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', orgSlug: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => { setForm(f => ({ ...f, [e.target.name]: e.target.value })); setError(''); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try { await login(form); navigate('/dashboard'); }
    catch (err) { setError(err.response?.data?.error?.message || 'Login failed. Please try again.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-700 via-brand-600 to-teal-500 flex items-start md:items-center justify-center p-4 py-8 overflow-y-auto">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur mb-4">
            <Droplets className="w-9 h-9 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">WaterSim Pro</h1>
          <p className="text-blue-100 mt-1 text-sm">Process Simulation Platform</p>
        </div>
        <div className="card p-8 shadow-2xl">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Sign in to your account</h2>
          {error && <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700" role="alert">{error}</div>}
          <form onSubmit={handleSubmit} className="space-y-4" aria-label="Sign in form" noValidate>
            <div>
              <label className="label" htmlFor="orgSlug">Organisation</label>
              <input id="orgSlug" name="orgSlug" type="text" className="input" placeholder="your-organisation" value={form.orgSlug} onChange={handleChange} required />
            </div>
            <div>
              <label className="label" htmlFor="email">Email address</label>
              <input id="email" name="email" type="email" className="input" placeholder="engineer@example.com" value={form.email} onChange={handleChange} required />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <div className="relative">
                <input id="password" name="password" type={showPassword ? 'text' : 'password'} className="input pr-10" placeholder="••••••••" value={form.password} onChange={handleChange} required />
                <button type="button" onClick={() => setShowPassword(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : 'Sign in'}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-500">
            New to WaterSim Pro?{' '}
            <Link to="/register" className="text-brand-600 font-medium hover:underline">Register your organisation</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
