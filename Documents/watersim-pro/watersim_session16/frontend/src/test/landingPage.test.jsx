/**
 * LandingPage — the public front door, with sign-in and registration as a popup.
 *
 * What is pinned: the page names the product and its three surfaces and
 * shows no form until asked; "Log in" opens the sign-in popup and Close shuts
 * it; "Register" opens the registration popup whose link switches to
 * sign-in; /login renders the page with the popup already open; a signed-in
 * person is offered the dashboard instead of the buttons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from '../pages/LandingPage';
import { authService } from '../services/auth.service';

let AUTHED = false;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), isAuthenticated: AUTHED }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/auth.service', () => ({
  authService: { organisations: vi.fn(), login: vi.fn(), register: vi.fn() },
}));

const mount = (props, entries = ['/']) => render(<MemoryRouter initialEntries={entries}><LandingPage {...props} /></MemoryRouter>);

beforeEach(() => {
  AUTHED = false;
  vi.clearAllMocks();
  authService.organisations.mockResolvedValue([{ slug: 'itc-stp', name: 'ITC — Sewage Treatment Plant' }]);
});

describe('LandingPage', () => {
  it('names the product and its three surfaces, with no form until asked', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'SafeKrit' })).toBeInTheDocument();
    for (const name of ['Operations monitor & control', 'Digital twin', 'Predictive maintenance']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.queryByTestId('auth-dialog')).toBeNull();
    expect(screen.queryByLabelText('Email address')).toBeNull();
  });

  it('"Log in" opens the sign-in popup and Close shuts it', async () => {
    mount();
    await userEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(within(dialog).getByLabelText('Email address')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Register" opens the registration popup, whose link switches to sign-in', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register your organisation' });
    expect(within(dialog).getByLabelText('Organisation name')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('/login renders the page with the sign-in popup already open', async () => {
    mount({ dialog: 'login' }, ['/login']);
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'SafeKrit' })).toBeInTheDocument();
  });

  it('offers a signed-in person the dashboard instead of the buttons', () => {
    AUTHED = true;
    mount();
    expect(screen.getAllByRole('link', { name: /Open dashboard/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
  });
});
