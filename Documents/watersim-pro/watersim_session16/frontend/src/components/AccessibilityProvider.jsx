/**
 * AccessibilityProvider
 * ─────────────────────
 * Provides three global accessibility features:
 *
 * 1. Skip Navigation link — appears on keyboard focus, jumps to main content
 * 2. Focus management — restores focus after modal close / route change
 * 3. Live region — screen-reader announcements via `useAnnounce()`
 *
 * Wrap the application once:
 *   <AccessibilityProvider>
 *     <App />
 *   </AccessibilityProvider>
 *
 * Then use the hooks anywhere:
 *   const announce = useAnnounce();
 *   announce('Project saved successfully');
 *   announce('Error: could not save', 'assertive');
 */

import { createContext, useContext, useRef, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

// ── Context ───────────────────────────────────────────────────────────────────

const A11yContext = createContext({ announce: () => {} });

export function useAnnounce() {
  return useContext(A11yContext).announce;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export default function AccessibilityProvider({ children }) {
  // Polite announcements for success/info
  const [politeMsg, setPoliteMsg] = useState('');
  // Assertive announcements for errors / urgent updates
  const [assertiveMsg, setAssertiveMsg] = useState('');

  const politeTimer = useRef(null);
  const assertiveTimer = useRef(null);

  const announce = useCallback((message, priority = 'polite') => {
    if (priority === 'assertive') {
      setAssertiveMsg('');
      clearTimeout(assertiveTimer.current);
      requestAnimationFrame(() => {
        setAssertiveMsg(message);
        assertiveTimer.current = setTimeout(() => setAssertiveMsg(''), 7000);
      });
    } else {
      setPoliteMsg('');
      clearTimeout(politeTimer.current);
      requestAnimationFrame(() => {
        setPoliteMsg(message);
        politeTimer.current = setTimeout(() => setPoliteMsg(''), 7000);
      });
    }
  }, []);

  // Announce route changes for SPA screen-reader navigation
  const location = useLocation();
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname !== prevPath.current) {
      prevPath.current = location.pathname;
      // Small delay ensures the new page title/heading has rendered
      setTimeout(() => {
        const heading = document.querySelector('h1, h2, [role="heading"]');
        const label = heading?.textContent ?? document.title;
        announce(`Navigated to ${label}`);
      }, 100);
    }
  }, [location.pathname, announce]);

  return (
    <A11yContext.Provider value={{ announce }}>
      {/* ── Skip navigation link ──────────────────────────────────────────────
          Invisible until focused — allows keyboard users to bypass the sidebar
          and jump straight to main content. */}
      <a
        href="#main-content"
        className="
          sr-only focus:not-sr-only
          focus:fixed focus:top-3 focus:left-3 focus:z-[9999]
          focus:px-4 focus:py-2 focus:rounded-lg
          focus:bg-brand-700 focus:text-white focus:font-semibold focus:text-sm
          focus:shadow-lg focus:outline-2 focus:outline-white focus:outline-offset-2
        "
      >
        Skip to main content
      </a>

      {children}

      {/* ── ARIA live regions ─────────────────────────────────────────────────
          These are invisible to sighted users but read aloud by screen readers
          when their text content changes. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        role="status"
      >
        {politeMsg}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        role="alert"
      >
        {assertiveMsg}
      </div>
    </A11yContext.Provider>
  );
}

// ── useFocusTrap ──────────────────────────────────────────────────────────────
/**
 * Trap focus within a container element while it's active.
 * Returns a ref to attach to the container.
 *
 * Usage:
 *   const trapRef = useFocusTrap(isOpen);
 *   <div ref={trapRef}>…</div>
 */
export function useFocusTrap(active) {
  const ref = useRef(null);

  useEffect(() => {
    if (!active || !ref.current) return;

    const el = ref.current;
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    // Focus first focusable on open
    const first = el.querySelector(FOCUSABLE);
    first?.focus();

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(el.querySelectorAll(FOCUSABLE));
      if (!focusable.length) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return ref;
}

// ── useFocusReturn ────────────────────────────────────────────────────────────
/**
 * Remembers the focused element when `active` becomes true, and restores
 * focus to it when `active` becomes false (e.g. modal closes).
 *
 * Usage:
 *   useFocusReturn(isModalOpen);
 */
export function useFocusReturn(active) {
  const previousFocus = useRef(null);

  useEffect(() => {
    if (active) {
      previousFocus.current = document.activeElement;
    } else if (previousFocus.current) {
      // Small delay ensures the DOM has settled
      setTimeout(() => {
        previousFocus.current?.focus();
        previousFocus.current = null;
      }, 50);
    }
  }, [active]);
}

// ── useKeyboardShortcut ───────────────────────────────────────────────────────
/**
 * Register a global keyboard shortcut.
 *
 * Usage:
 *   useKeyboardShortcut('n', handleNewProject, { meta: true });  // Cmd/Ctrl+N
 *   useKeyboardShortcut('Escape', closeModal);
 */
export function useKeyboardShortcut(key, callback, { ctrl = false, meta = false, shift = false, alt = false } = {}) {
  useEffect(() => {
    const handler = (e) => {
      if (ctrl && !(e.ctrlKey || e.metaKey)) return;
      if (meta && !e.metaKey) return;
      if (shift && !e.shiftKey) return;
      if (alt && !e.altKey) return;

      // Don't trigger when typing in an input
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) && key !== 'Escape') return;

      if (e.key === key || e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        callback(e);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [key, callback, ctrl, meta, shift, alt]);
}

// ── VisuallyHidden ────────────────────────────────────────────────────────────
/**
 * Render content that is only visible to screen readers.
 * Usage: <VisuallyHidden>Close dialog</VisuallyHidden>
 */
export function VisuallyHidden({ children, as: Tag = 'span' }) {
  return <Tag className="sr-only">{children}</Tag>;
}
