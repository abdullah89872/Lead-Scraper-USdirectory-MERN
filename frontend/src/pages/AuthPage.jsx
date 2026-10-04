import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { Alert, Field } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';

/** Split-screen login / register shell. */
export default function AuthPage({ mode = 'login' }) {
  const isLogin = mode === 'login';
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isLogin) await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err, 'Could not sign you in'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="hidden w-1/2 flex-col justify-between bg-slate-900 p-12 lg:flex">
        <div className="flex items-center gap-2 text-white">
          <div className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold">LF</div>
          <span className="font-semibold">LeadForge AI</span>
        </div>
        <div>
          <h2 className="max-w-md text-4xl font-bold leading-tight text-white">
            Turn any business category and city into a clean, exportable lead list.
          </h2>
          <p className="mt-4 max-w-md text-slate-400">
            Searches public directory listings, extracts only what businesses actually publish,
            enriches from their own websites, deduplicates, and exports to CSV or XLSX.
          </p>
          <ul className="mt-8 space-y-2 text-sm text-slate-400">
            <li>· Respects robots.txt, rate limits and site access rules</li>
            <li>· Never fabricates contact information — missing values stay empty</li>
            <li>· Optional AI tagging kept separate from source data</li>
          </ul>
        </div>
        <p className="text-xs text-slate-500">LeadForge AI · v1.0.0</p>
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center bg-slate-50 px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">LF</div>
            <span className="font-semibold text-slate-900">LeadForge AI</span>
          </div>

          <h1 className="text-2xl font-bold text-slate-900">
            {isLogin ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {isLogin ? 'Sign in to continue scraping leads.' : 'Start finding leads in under a minute.'}
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {error ? <Alert variant="error">{error}</Alert> : null}

            {!isLogin ? (
              <Field label="Full name" required>
                <input
                  className="input"
                  value={form.name}
                  onChange={update('name')}
                  autoComplete="name"
                  required
                  minLength={2}
                />
              </Field>
            ) : null}

            <Field label="Email" required>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={update('email')}
                autoComplete="email"
                required
              />
            </Field>

            <Field
              label="Password"
              required
              hint={isLogin ? undefined : 'At least 8 characters.'}
            >
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={update('password')}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                required
                minLength={isLogin ? 1 : 8}
              />
            </Field>

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              <Zap size={16} />
              {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            {isLogin ? "Don't have an account? " : 'Already have an account? '}
            <Link
              to={isLogin ? '/register' : '/login'}
              className="font-semibold text-brand-600 hover:text-brand-700"
            >
              {isLogin ? 'Sign up' : 'Sign in'}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}