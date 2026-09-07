/**
 * Page transitions — the content of every page fades and settles into place.
 *
 * What is pinned: AppLayout wraps the page in one element that carries the
 * enter animation and names the route it is showing; a route change keeps
 * that element (no keyed remount — a page whose params change keeps its
 * state) and re-arms the animation on it; the scroller returns to the top;
 * reduced motion (the ws.motion override here) draws the page with no
 * animation at all; and the stylesheet defines the keyframes the class
 * relies on, with the reduced-motion rule still in place after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AppLayout from '../components/layout/AppLayout';
import { setMotionSetting } from '../components/AccessibilityProvider';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', firstName: 'Eddie', lastName: 'Ops', role: 'admin' },
    role: 'admin',
    can: () => true,
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../components/OnboardingWizard', () => ({ OnboardingTrigger: () => null }));

let mounts = 0;
function Page() {
  const { pathname } = useLocation();
  // Counts component mounts (not renders): a keyed remount on navigation would bump it.
  useEffect(() => { mounts += 1; }, []);
  return (
    <div data-testid="page">
      {pathname} <Link to="/alarms">Go to alarms</Link>
    </div>
  );
}

function mount(initial = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="*" element={<AppLayout><Page /></AppLayout>} />
      </Routes>
    </MemoryRouter>,
  );
}

const wrapper = () => document.querySelector('[data-page]');

beforeEach(() => {
  localStorage.clear();
  mounts = 0;
});

describe('page transition', () => {
  it('wraps the page in one animated element that names the route', () => {
    mount('/dashboard');
    const el = wrapper();
    expect(el).not.toBeNull();
    expect(el.dataset.page).toBe('/dashboard');
    expect(el.classList.contains('ws-page-enter')).toBe(true);
    expect(el.contains(screen.getByTestId('page'))).toBe(true);
  });

  it('re-arms the animation on a route change without remounting the page, and scrolls to the top', async () => {
    mount('/dashboard');
    const main = screen.getByRole('main');
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo;
    const before = wrapper();
    await userEvent.click(screen.getByRole('link', { name: 'Go to alarms' }));
    const after = wrapper();
    expect(after).toBe(before);                       // same element, not a keyed remount
    expect(after.dataset.page).toBe('/alarms');
    expect(after.classList.contains('ws-page-enter')).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    // Re-renders happened, but the page component was mounted exactly once.
    expect(screen.getByTestId('page')).toHaveTextContent('/alarms');
    expect(mounts).toBe(1);
  });

  it('draws the page with no animation under reduced motion', () => {
    setMotionSetting('off');
    mount('/dashboard');
    expect(wrapper().classList.contains('ws-page-enter')).toBe(false);
    setMotionSetting('auto');
  });

  it('the stylesheet defines the keyframes and keeps the reduced-motion rule after them', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const kf = css.indexOf('@keyframes ws-page-enter');
    const cls = css.indexOf('.ws-page-enter {');
    const reduced = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(kf).toBeGreaterThan(-1);
    expect(cls).toBeGreaterThan(kf);
    expect(reduced).toBeGreaterThan(cls);
    expect(css.slice(cls, cls + 200)).toMatch(/animation:\s*ws-page-enter/);
  });
});
