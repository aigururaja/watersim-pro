/**
 * AuthDialog — the sign-in / register popup on the landing page: a dimmed
 * ground, a white 28px-radius panel (a bottom sheet on phones), the product
 * chip, a large title, and one of the two forms. Escape and the backdrop
 * close it; focus stays inside while it is open.
 */
import { useEffect, useState } from 'react';
import { X, Droplets } from 'lucide-react';
import { useFocusTrap } from '../AccessibilityProvider';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

const COPY = {
  login: { title: 'Sign in', subtitle: 'Choose your organisation and sign in with your email.' },
  register: { title: 'Register your organisation', subtitle: 'Create the organisation and its first administrator. Invite the rest of the team afterwards.' },
};

export default function AuthDialog({ mode = 'login', onClose, onModeChange }) {
  const trapRef = useFocusTrap(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const copy = COPY[mode] || COPY.login;
  const switchTo = (next) => { setNote(''); onModeChange?.(next); };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label={copy.title} data-testid="auth-dialog">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div ref={trapRef} className="relative w-full sm:max-w-[480px] bg-white rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col shadow-float ws-page-enter">
        <div className="flex items-center justify-between px-6 pt-5 pb-1">
          <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold bg-ink text-white">
            <Droplets className="w-3.5 h-3.5" aria-hidden="true" /> SafeKrit
          </span>
          <button type="button" onClick={onClose} aria-label="Close"
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ground text-ink hover:bg-line transition">
            <X className="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <h1 className="text-[26px] font-extrabold tracking-tight leading-tight text-ink mt-2">{copy.title}</h1>
          <p className="text-ink-3 mt-1 mb-6">{copy.subtitle}</p>
          {note && <div className="mb-4 rounded-2xl bg-ok-soft text-ok px-4 py-3 text-sm" role="status">{note}</div>}
          {mode === 'register' ? (
            <RegisterForm
              onLogin={() => switchTo('login')}
              onRegistered={() => { onModeChange?.('login'); setNote('Organisation created. Sign in with the account you just made.'); }}
            />
          ) : (
            <LoginForm onRegister={() => switchTo('register')} />
          )}
        </div>
      </div>
    </div>
  );
}
