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
  localStorage.clear();
  sessionStorage.clear();
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

  it('asks to install the app shortly after the page appears, and "Not now" is remembered', async () => {
    mount({ installPromptDelayMs: 10 });
    const dialog = await screen.findByRole('dialog', { name: 'Install the SafeKrit app' });
    expect(within(dialog).getByText(/opens straight to sign-in/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(Number(localStorage.getItem('ws.installPrompt.dismissedAt'))).toBeGreaterThan(0);
  });

  it('does not ask again within a week of "Not now"', async () => {
    localStorage.setItem('ws.installPrompt.dismissedAt', String(Date.now() - 60_000));
    mount({ installPromptDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not interrupt someone who came to sign in', async () => {
    mount({ dialog: 'login', installPromptDelayMs: 5 }, ['/login']);
    await screen.findByRole('dialog', { name: 'Sign in' });
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByRole('dialog', { name: 'Install the SafeKrit app' })).toBeNull();
  });

  it('the header and the phone section open the install popup, which offers the Android app file', async () => {
    mount();
    await userEvent.click(screen.getByTestId('header-install'));
    let dialog = await screen.findByRole('dialog', { name: 'Install the SafeKrit app' });
    // jsdom is a desktop browser that cannot install apps: it is told to use Chrome or Edge, and gets the phone file.
    expect(within(dialog).getByText(/does not install apps/)).toBeInTheDocument();
    expect(within(dialog).getByTestId('apk-download')).toHaveAttribute('href', '/downloads/safekrit.apk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByTestId('section-install'));
    dialog = await screen.findByRole('dialog', { name: 'Install the SafeKrit app' });
    expect(dialog).toBeInTheDocument();
  });

  it('offers a signed-in person the dashboard instead of the buttons', () => {
    AUTHED = true;
    mount();
    expect(screen.getAllByRole('link', { name: /Open dashboard/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
  });
});
