/**
 * LoginPage — the organisation is chosen, not typed.
 *
 * What is pinned: the list from GET /auth/organisations fills a select and
 * the chosen slug is what login() receives (and what the browser remembers);
 * a single organisation is preselected; the remembered one is preselected
 * next time; "Another organisation…" and a list that cannot be read both fall
 * back to a text field so sign-in never depends on the list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoginPage, { loginErrorMessage } from '../pages/LoginPage';
import { authService } from '../services/auth.service';

const login = vi.fn();
const navigate = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/auth.service', () => ({
  authService: { organisations: vi.fn(), login: vi.fn() },
}));
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigate };
});

const ORGS = [
  { slug: 'itc-stp', name: 'ITC — Sewage Treatment Plant' },
  { slug: 'demo', name: 'WaterSim Demo' },
];

const mount = () => render(<MemoryRouter><LoginPage /></MemoryRouter>);
const orgField = () => screen.getByLabelText('Organisation');
const loaded = async () => { await waitFor(() => expect(orgField()).toBeEnabled()); return orgField(); };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  login.mockResolvedValue({});
});

describe('LoginPage organisation picker', () => {
  it('lists the organisations from the server and signs in with the chosen one', async () => {
    authService.organisations.mockResolvedValue(ORGS);
    mount();
    expect(orgField()).toBeDisabled(); // loading
    const select = await loaded();
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Select your organisation', 'ITC — Sewage Treatment Plant', 'WaterSim Demo', 'Another organisation…',
    ]);
    await userEvent.selectOptions(select, 'itc-stp');
    await userEvent.type(screen.getByLabelText('Email address'), 'ops@itc.test');
    await userEvent.type(screen.getByLabelText('Password'), 'Secret123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: 'ops@itc.test', password: 'Secret123', orgSlug: 'itc-stp' }));
    expect(localStorage.getItem('ws.orgSlug')).toBe('itc-stp');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('preselects the only organisation', async () => {
    authService.organisations.mockResolvedValue(ORGS.slice(0, 1));
    mount();
    const select = await loaded();
    expect(select.value).toBe('itc-stp');
  });

  it('preselects the organisation this browser used last', async () => {
    localStorage.setItem('ws.orgSlug', 'demo');
    authService.organisations.mockResolvedValue(ORGS);
    mount();
    const select = await loaded();
    expect(select.value).toBe('demo');
  });

  it('"Another organisation…" switches to typing the ID, and the link switches back', async () => {
    authService.organisations.mockResolvedValue(ORGS);
    mount();
    const select = await loaded();
    await userEvent.selectOptions(select, '__other__');
    const input = orgField();
    expect(input.tagName).toBe('INPUT');
    expect(input.value).toBe('');
    await userEvent.type(input, 'new-plant');
    await userEvent.type(screen.getByLabelText('Email address'), 'a@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: 'new-plant' })));
    await userEvent.click(screen.getByRole('button', { name: 'Choose from the list' }));
    expect(orgField().tagName).toBe('SELECT');
    expect(orgField().value).toBe(''); // a typed ID that is not listed is not kept
  });

  it('falls back to typing the ID when the list cannot be read', async () => {
    authService.organisations.mockRejectedValue(new Error('network'));
    mount();
    await waitFor(() => expect(orgField().tagName).toBe('INPUT'));
    expect(screen.queryByRole('button', { name: /Choose from the list|Enter its ID/ })).toBeNull();
    await userEvent.type(orgField(), 'itc-stp');
    expect(orgField().value).toBe('itc-stp');
  });

  it('shows the rate limiter\'s own message on 429 instead of the generic failure', async () => {
    authService.organisations.mockResolvedValue(ORGS);
    login.mockRejectedValue({ response: { status: 429, data: { error: 'Too many auth attempts, please try again later' } } });
    mount();
    const select = await loaded();
    await userEvent.selectOptions(select, 'itc-stp');
    await userEvent.type(screen.getByLabelText('Email address'), 'ops@itc.test');
    await userEvent.type(screen.getByLabelText('Password'), 'Secret123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many auth attempts, please try again later. Wait about 15 minutes');
    // The usual shape still reads the nested message; no response at all reads as unreachable.
    expect(loginErrorMessage({ response: { status: 401, data: { error: { message: 'Invalid credentials' } } } })).toBe('Invalid credentials');
    expect(loginErrorMessage(new Error('Network Error'))).toMatch(/Could not reach the server/);
    expect(loginErrorMessage({ response: { status: 500, data: {} } })).toBe('Login failed. Please try again.');
  });

  it('a remembered ID that is not in the list stays typed', async () => {
    localStorage.setItem('ws.orgSlug', 'old-plant');
    authService.organisations.mockResolvedValue(ORGS);
    mount();
    await waitFor(() => expect(orgField().tagName).toBe('INPUT'));
    expect(orgField().value).toBe('old-plant');
  });
});
