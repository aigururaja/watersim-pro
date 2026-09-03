import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Droplets, FolderOpen, Cpu, Play, CheckCircle2,
  ArrowRight, ArrowLeft, X, Sparkles,
} from 'lucide-react';

/**
 * OnboardingWizard — a modal-based, step-by-step first-run guide.
 *
 * Shown automatically once per user (key stored in localStorage keyed to user id).
 * Can also be triggered manually (e.g. from a "?" help button).
 *
 * Props:
 *   userId      — user id string; used to key localStorage persistence
 *   userName    — first name for personalized greeting
 *   onComplete  — called when the user finishes or dismisses
 *   forceShow   — bypass the localStorage check (for "replay tour" button)
 */

const STEPS = [
  {
    id: 'welcome',
    icon: Droplets,
    iconBg: 'bg-brand-100',
    iconColor: 'text-brand-600',
    title: 'Welcome to WaterSim Pro',
    body: `WaterSim Pro lets you design, simulate, and report on wastewater treatment
           processes — all in your browser. Let's take a quick tour so you can get
           started in under 2 minutes.`,
    illustration: 'welcome',
  },
  {
    id: 'projects',
    icon: FolderOpen,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    title: 'Organise work with Projects',
    body: `Projects group related flowsheets together. Each project can represent a
           real site, a study, or a design phase. Start by creating your first project —
           you can always rename or add more later.`,
    illustration: 'projects',
    cta: { label: 'Create first project', href: '/projects/new' },
  },
  {
    id: 'canvas',
    icon: Cpu,
    iconBg: 'bg-purple-100',
    iconColor: 'text-purple-600',
    title: 'Build on the Canvas',
    body: `Inside a project, create a Flowsheet to open the canvas editor. Drag unit
           operations from the palette on the left onto the canvas, then connect them
           with streams. Configure each unit's parameters in the right-hand panel.`,
    illustration: 'canvas',
  },
  {
    id: 'simulate',
    icon: Play,
    iconBg: 'bg-green-100',
    iconColor: 'text-green-600',
    title: 'Run a Simulation',
    body: `Hit "Run Simulation" in the canvas toolbar. WaterSim Pro solves the mass
           balance across your flowsheet in seconds. Results appear on each stream and
           unit, and you can generate a full compliance report.`,
    illustration: 'simulate',
  },
  {
    id: 'done',
    icon: CheckCircle2,
    iconBg: 'bg-teal-100',
    iconColor: 'text-teal-600',
    title: "You're all set!",
    body: `That's the full loop: Project → Flowsheet → Canvas → Simulate → Report.
           Need help at any time? Use the "?" button in the top-right corner to replay
           this tour or access documentation.`,
    illustration: 'done',
    cta: { label: 'Go to Projects', href: '/projects' },
  },
];

// Simple SVG illustrations per step ──────────────────────────────────────────

function Illustration({ name }) {
  switch (name) {
    case 'welcome':
      return (
        <svg viewBox="0 0 240 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-full h-auto">
          <rect width="240" height="120" rx="12" fill="#EFF6FF" />
          <circle cx="120" cy="60" r="30" fill="#BFDBFE" />
          <path d="M107 60 Q120 40 133 60 Q120 80 107 60Z" fill="#3B82F6" />
          <circle cx="155" cy="38" r="8" fill="#93C5FD" />
          <circle cx="80" cy="75" r="6" fill="#93C5FD" />
          <circle cx="170" cy="80" r="5" fill="#BFDBFE" />
        </svg>
      );
    case 'projects':
      return (
        <svg viewBox="0 0 240 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-full h-auto">
          <rect width="240" height="120" rx="12" fill="#EFF6FF" />
          {[0, 1, 2].map(i => (
            <g key={i} transform={`translate(${20 + i * 75}, 20)`}>
              <rect width="60" height="80" rx="8" fill="white" stroke="#BFDBFE" strokeWidth="1.5" />
              <rect x="10" y="14" width="40" height="4" rx="2" fill="#3B82F6" opacity={1 - i * 0.25} />
              <rect x="10" y="24" width="30" height="3" rx="1.5" fill="#93C5FD" opacity={0.7} />
              <rect x="10" y="32" width="35" height="3" rx="1.5" fill="#93C5FD" opacity={0.5} />
            </g>
          ))}
          <rect x="20" y="8" width="24" height="16" rx="3" fill="#3B82F6" />
          <rect x="95" y="8" width="24" height="16" rx="3" fill="#60A5FA" />
          <rect x="170" y="8" width="24" height="16" rx="3" fill="#93C5FD" />
        </svg>
      );
    case 'canvas':
      return (
        <svg viewBox="0 0 240 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-full h-auto">
          <rect width="240" height="120" rx="12" fill="#F5F3FF" />
          <rect x="10" y="10" width="40" height="100" rx="6" fill="white" stroke="#DDD6FE" strokeWidth="1.5" />
          {[20, 44, 68, 92].map((y, i) => (
            <rect key={i} x="16" y={y} width="28" height="16" rx="4" fill="#8B5CF6" opacity={0.2 + i * 0.2} />
          ))}
          <rect x="62" y="10" width="168" height="100" rx="6" fill="white" stroke="#DDD6FE" strokeWidth="1.5" />
          {/* nodes */}
          <rect x="80" y="50" width="36" height="24" rx="4" fill="#7C3AED" opacity="0.85" />
          <rect x="138" y="50" width="36" height="24" rx="4" fill="#7C3AED" opacity="0.6" />
          <rect x="196" y="50" width="24" height="24" rx="4" fill="#7C3AED" opacity="0.4" />
          {/* edges */}
          <line x1="116" y1="62" x2="138" y2="62" stroke="#A78BFA" strokeWidth="2" />
          <line x1="174" y1="62" x2="196" y2="62" stroke="#A78BFA" strokeWidth="2" />
        </svg>
      );
    case 'simulate':
      return (
        <svg viewBox="0 0 240 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-full h-auto">
          <rect width="240" height="120" rx="12" fill="#ECFDF5" />
          <rect x="20" y="20" width="200" height="80" rx="8" fill="white" stroke="#BBF7D0" strokeWidth="1.5" />
          {/* bar chart */}
          {[
            { x: 40, h: 40, c: '#34D399' },
            { x: 72, h: 58, c: '#10B981' },
            { x: 104, h: 32, c: '#6EE7B7' },
            { x: 136, h: 50, c: '#34D399' },
            { x: 168, h: 44, c: '#059669' },
          ].map(({ x, h, c }) => (
            <rect key={x} x={x} y={90 - h} width="22" height={h} rx="3" fill={c} opacity="0.85" />
          ))}
          <line x1="30" y1="90" x2="210" y2="90" stroke="#D1FAE5" strokeWidth="1.5" />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 240 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-full h-auto">
          <rect width="240" height="120" rx="12" fill="#F0FDF4" />
          <circle cx="120" cy="60" r="36" fill="#D1FAE5" />
          <circle cx="120" cy="60" r="24" fill="#6EE7B7" />
          <path d="M108 60 l8 8 l16-16" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          {[0, 60, 120, 180, 240, 300].map((deg, i) => (
            <circle
              key={i}
              cx={120 + 48 * Math.cos((deg * Math.PI) / 180)}
              cy={60 + 48 * Math.sin((deg * Math.PI) / 180)}
              r="4"
              fill="#34D399"
              opacity="0.6"
            />
          ))}
        </svg>
      );
    default:
      return null;
  }
}

// ── OnboardingWizard ──────────────────────────────────────────────────────────

const LS_KEY = (userId) => `watersim_onboarding_done_${userId}`;

export function hasCompletedOnboarding(userId) {
  try { return !!localStorage.getItem(LS_KEY(userId)); } catch { return false; }
}

export function markOnboardingComplete(userId) {
  try { localStorage.setItem(LS_KEY(userId), '1'); } catch { /* ignore */ }
}

export default function OnboardingWizard({
  userId,
  userName = 'there',
  onComplete,
  forceShow = false,
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const modalRef = useRef(null);
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (forceShow || !hasCompletedOnboarding(userId)) {
      setVisible(true);
    }
  }, [userId, forceShow]);

  // Trap focus inside modal while open
  useEffect(() => {
    if (!visible) return;
    const firstFocusable = modalRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') dismissWizard();
      if (e.key === 'Tab') {
        const focusable = Array.from(
          modalRef.current?.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          ) ?? []
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, step]);

  // Explicit Finish/Skip (X, "Get started", CTA) marks onboarding complete;
  // backdrop click / Escape only dismisses, so the tour can reappear later.
  const closeWizard = (goTo, { markComplete = true } = {}) => {
    setClosing(true);
    setTimeout(() => {
      setVisible(false);
      setClosing(false);
      if (markComplete) markOnboardingComplete(userId);
      onComplete?.();
      if (goTo) navigate(goTo);
    }, 200);
  };

  const dismissWizard = () => closeWizard(undefined, { markComplete: false });

  if (!visible) return null;

  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const Icon = current.icon;

  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm
                  transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-body"
      onClick={(e) => { if (e.target === e.currentTarget) dismissWizard(); }}
    >
      <div
        ref={modalRef}
        className={`bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden
                    transition-all duration-200 ${closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'}`}
      >
        {/* Close button */}
        <div className="flex justify-between items-center px-6 pt-5 pb-0">
          <div className="flex gap-1.5" role="tablist" aria-label="Onboarding steps">
            {STEPS.map((s, i) => (
              <div
                key={s.id}
                role="tab"
                aria-selected={i === step}
                aria-label={`Step ${i + 1}: ${s.title}`}
                className={`h-1.5 rounded-full transition-all duration-300
                  ${i === step ? 'bg-brand-600 w-6' : i < step ? 'bg-brand-300 w-3' : 'bg-gray-200 w-3'}`}
              />
            ))}
          </div>
          <button
            ref={closeBtnRef}
            onClick={() => closeWizard()}
            aria-label="Close onboarding"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Illustration */}
        <div className="px-6 pt-4">
          <Illustration name={current.illustration} />
        </div>

        {/* Content */}
        <div className="px-6 pt-4 pb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${current.iconBg}`}>
              <Icon className={`w-5 h-5 ${current.iconColor}`} aria-hidden="true" />
            </div>
            <h2 id="onboarding-title" className="text-lg font-bold text-gray-900">
              {current.id === 'welcome' ? `Hi ${userName}! ${current.title}` : current.title}
            </h2>
          </div>

          <p id="onboarding-body" className="text-sm text-gray-600 leading-relaxed mb-6">
            {current.body}
          </p>

          {/* Actions */}
          <div className="flex items-center gap-3">
            {!isFirst && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="btn-secondary text-sm"
                aria-label={`Go to step ${step}: ${STEPS[step - 1].title}`}
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                Back
              </button>
            )}

            <div className="flex-1" />

            {current.cta && (
              <button
                onClick={() => closeWizard(current.cta.href)}
                className="btn-secondary text-sm"
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                {current.cta.label}
              </button>
            )}

            <button
              onClick={() => isLast ? closeWizard() : setStep(s => s + 1)}
              className="btn-primary text-sm"
              aria-label={isLast ? 'Finish onboarding' : `Next: ${STEPS[step + 1]?.title}`}
            >
              {isLast ? 'Get started' : 'Next'}
              {!isLast && <ArrowRight className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Small trigger button — place anywhere to re-launch the onboarding tour.
 * Usage: <OnboardingTrigger userId={user.id} userName={user.firstName} />
 */
export function OnboardingTrigger({ userId, userName }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        onClick={() => setShow(true)}
        aria-label="Launch onboarding tour"
        title="Onboarding tour"
        className="p-1.5 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
      >
        <Sparkles className="w-4 h-4" aria-hidden="true" />
      </button>
      {show && (
        <OnboardingWizard
          userId={userId}
          userName={userName}
          forceShow
          onComplete={() => setShow(false)}
        />
      )}
    </>
  );
}
