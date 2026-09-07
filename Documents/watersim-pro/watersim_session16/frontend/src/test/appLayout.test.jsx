/**
 * AppLayout — the three-surface shell.
 *
 * What is pinned: a surface a role cannot see is not drawn; the Audit link is
 * admin-only while Admin stays visible to engineers and managers; the surface
 * that owns the current path is the one open; a chosen surface is remembered
 * in localStorage and navigates to that surface's home; the mobile bottom bar
 * carries the open surface's links. The auth context is mocked per test so
 * each role is exercised without a login round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import AppLayout, { SURFACES, surfaceForPath } from '../components/layout/AppLayout';
import { can } from '../auth/roles';

let ROLE = 'viewer';
let CAN = (cap) => can(ROLE, cap);

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', firstName: 'Eddie', lastName: 'Ops', role: ROLE },
    role: ROLE,
    can: (cap) => CAN(cap),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }) => children,
}));

vi.mock('../components/OnboardingWizard', () => ({
  OnboardingTrigger: () => null,
}));

function WhereAmI() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function mount(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<AppLayout><WhereAmI /></AppLayout>} />
      </Routes>
    </MemoryRouter>,
  );
}

const sidebar = () => screen.getByRole('complementary', { name: 'Sidebar navigation' });
const sectionsIn = (root) => [...root.querySelectorAll('section[data-surface]')].map(s => s.dataset.surface);
const openIn = (root) => [...root.querySelectorAll('section[data-open="true"]')].map(s => s.dataset.surface);

beforeEach(() => {
  ROLE = 'viewer';
  CAN = (cap) => can(ROLE, cap);
  localStorage.clear();
});

describe('AppLayout surfaces', () => {
  it('declares exactly the three surfaces, each gated by a view capability', () => {
    expect(SURFACES.map(s => s.key)).toEqual(['ops', 'twin', 'maintenance']);
    for (const s of SURFACES) {
      expect(s.capability).toMatch(/\.view$/);
      expect(s.items.length).toBeGreaterThan(0);
      expect(s.home).toMatch(/^\//);
    }
  });

  it('a viewer sees all three surfaces and Settings, but neither Admin nor Audit', () => {
    mount('/dashboard');
    const sb = sidebar();
    expect(sectionsIn(sb)).toEqual(['ops', 'twin', 'maintenance']);
    expect(within(sb).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(sb).queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(within(sb).queryByRole('link', { name: 'Audit' })).toBeNull();
  });

  it('an engineer and a manager get Admin but not Audit; an admin gets both', () => {
    for (const role of ['engineer', 'manager']) {
      ROLE = role;
      const { unmount } = mount('/dashboard');
      const sb = sidebar();
      expect(within(sb).getByRole('link', { name: 'Admin' })).toBeInTheDocument();
      expect(within(sb).queryByRole('link', { name: 'Audit' })).toBeNull();
      unmount();
    }
    ROLE = 'admin';
    mount('/dashboard');
    const sb = sidebar();
    expect(within(sb).getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    expect(within(sb).getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/audit');
  });

  it('does not draw a surface the role cannot see', () => {
    // Simulate a future deny rule: this role may not open the twin.
    CAN = (cap) => cap !== 'twin.view' && can('operator', cap);
    ROLE = 'operator';
    mount('/dashboard');
    expect(sectionsIn(sidebar())).toEqual(['ops', 'maintenance']);
  });

  it('opens the surface that owns the current path, and marks the deepest matching link current', () => {
    mount('/projects/p1/flowsheets/f1');
    const sb = sidebar();
    expect(openIn(sb)).toEqual(['twin']);
    expect(within(sb).getByRole('link', { name: /Projects/ })).toHaveAttribute('aria-current', 'page');

    // A path listed in two surfaces stays with the chosen one; with no
    // preference the first surface in nav order owns it.
    expect(surfaceForPath('/reports/compare')).toBe('ops');
    expect(surfaceForPath('/reports/compare', SURFACES, 'twin')).toBe('twin');
    expect(surfaceForPath('/alarms', SURFACES, 'maintenance')).toBe('maintenance');
    expect(surfaceForPath('/tasks')).toBe('maintenance');
    expect(surfaceForPath('/settings', SURFACES, 'twin')).toBeNull();
  });

  it('a shared path highlights the link of the surface that is open', async () => {
    const user = userEvent.setup();
    // Alarms is listed under both Operations and Maintenance.
    localStorage.setItem('ws.surface', 'maintenance');
    mount('/alarms');
    expect(openIn(sidebar())).toEqual(['maintenance']);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/Maintenance \/\s*Alarms/);

    await user.click(within(sidebar()).getByRole('button', { name: 'Operations' }));
    // Operations also owns /alarms, so choosing it stays on the page and just switches the open surface.
    expect(screen.getByTestId('where')).toHaveTextContent('/alarms');
    expect(openIn(sidebar())).toEqual(['ops']);
    expect(within(sidebar()).getByRole('link', { name: /Alarms/ })).toHaveAttribute('aria-current', 'page');
  });

  it('choosing Maintenance goes to the task board', async () => {
    const user = userEvent.setup();
    mount('/dashboard');
    await user.click(within(sidebar()).getByRole('button', { name: 'Maintenance' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks');
    expect(openIn(sidebar())).toEqual(['maintenance']);
    expect(within(sidebar()).getByRole('link', { name: /Tasks/ })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('banner')).getByRole('heading', { level: 1 })).toHaveTextContent(/Maintenance \/\s*Tasks/);
  });

  it('shows the surface and page in the header', () => {
    mount('/alarms');
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/Operations \/\s*Alarms/);
  });

  it('remembers a chosen surface and navigates to its home', async () => {
    const user = userEvent.setup();
    mount('/settings'); // owned by no surface → falls back to the first
    const sb = sidebar();
    expect(openIn(sb)).toEqual(['ops']);

    await user.click(within(sb).getByRole('button', { name: 'Maintenance' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks');
    expect(localStorage.getItem('ws.surface')).toBe('maintenance');
  });

  it('reopens the remembered surface when the path is not owned by any', () => {
    localStorage.setItem('ws.surface', 'twin');
    mount('/settings');
    expect(openIn(sidebar())).toEqual(['twin']);
  });

  it('the mobile bottom bar carries the open surface links plus Settings', () => {
    mount('/projects');
    const bottom = screen.getByRole('navigation', { name: 'Bottom navigation' });
    const labels = within(bottom).getAllByRole('link').map(l => l.getAttribute('aria-label'));
    expect(labels).toEqual(['Twin', 'Projects', 'Scenarios', 'Settings']);
    expect(within(bottom).getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  });
});
