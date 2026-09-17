/**
 * AuthScreen — sign-in and registration as a full screen, used inside the
 * installed app, where the public landing page must never appear. In a
 * browser the same forms open as a popup over the landing page instead
 * (AuthDialog).
 */
import { useState } from 'react';
import { Droplets } from 'lucide-react';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

const COPY = {
  login: { title: 'Sign in', subtitle: 'Choose your organisation and sign in with your email.' },
  register: { title: 'Register your organisation', subtitle: 'Create the organisation and its first administrator. Invite the rest of the team afterwards.' },
};

export default function AuthScreen({ mode: initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const [note, setNote] = useState('');
  const copy = COPY[mode] || COPY.login;

  return (
    <div className="min-h-[100dvh] bg-ground flex flex-col" data-testid="auth-screen">
      {/* m-auto centres the column when there is room and scrolls from the top when there is not */}
      <main className="w-full max-w-[440px] m-auto px-6 py-10 ws-page-enter">
        <span className="w-14 h-14 rounded-2xl bg-ink text-white flex items-center justify-center" aria-hidden="true">
          <Droplets className="w-7 h-7" />
        </span>
        <div className="mt-5 text-[13px] font-semibold text-ink-3">SafeKrit</div>
        <h1 className="text-[28px] font-extrabold tracking-tight leading-tight text-ink">{copy.title}</h1>
        <p className="text-ink-3 mt-1 mb-6">{copy.subtitle}</p>
        {note && <div className="mb-4 rounded-2xl bg-ok-soft text-ok px-4 py-3 text-sm" role="status">{note}</div>}
        <div className="card p-5 sm:p-6">
          {mode === 'register' ? (
            <RegisterForm
              onLogin={() => { setNote(''); setMode('login'); }}
              onRegistered={() => { setMode('login'); setNote('Organisation created. Sign in with the account you just made.'); }}
            />
          ) : (
            <LoginForm onRegister={() => { setNote(''); setMode('register'); }} />
          )}
        </div>
      </main>
    </div>
  );
}
