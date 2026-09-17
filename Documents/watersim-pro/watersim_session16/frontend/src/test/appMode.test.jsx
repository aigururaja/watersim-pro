/**
 * App mode and the install prompt.
 *
 * What is pinned: a browser tab is not the app, while a standalone display,
 * the Android app's referrer or a wrapper's user-agent token all are, and the
 * answer sticks for the session; the platform is read from the user agent;
 * the landing page asks to install unless the visitor is in the app, has
 * installed it, or said "Not now" within the week; the browser's install
 * event is captured, replayed once and reports the choice; and inside the
 * installed app /login is a plain sign-in screen with no landing page, and
 * the install popup offers the right thing per platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  isInstalledApp, platform, shouldAskToInstall, rememberInstallDismissal, REASK_MS,
  captureInstallPrompt, canPromptInstall, promptInstall, resetInstallPromptForTests,
} from '../utils/appMode';
import LoginPage from '../pages/LoginPage';
import InstallAppDialog from '../components/install/InstallAppDialog';
import { authService } from '../services/auth.service';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), isAuthenticated: false }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/auth.service', () => ({
  authService: { organisations: vi.fn(), login: vi.fn(), register: vi.fn() },
}));

const realMatchMedia = window.matchMedia;
const realUA = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
const setUA = (ua) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
const standalone = (on) => { window.matchMedia = (q) => ({ matches: on && q === '(display-mode: standalone)', media: q, addEventListener() {}, removeEventListener() {} }); };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetInstallPromptForTests();
  authService.organisations.mockResolvedValue([{ slug: 'plant', name: 'Riverside Plant' }]);
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  if (realUA) Object.defineProperty(window.navigator, 'userAgent', realUA); else delete window.navigator.userAgent;
});

describe('isInstalledApp', () => {
  it('is false in a browser tab', () => {
    expect(isInstalledApp()).toBe(false);
  });

  it('is true in a standalone window, and stays true for the session', () => {
    standalone(true);
    expect(isInstalledApp()).toBe(true);
    standalone(false);
    expect(isInstalledApp()).toBe(true);
  });

  it('is true inside a native wrapper that names itself in the user agent', () => {
    setUA('Mozilla/5.0 (iPhone) AppleWebKit/605 SafeKrit-iOS/1.0');
    expect(isInstalledApp()).toBe(true);
  });
});

describe('platform', () => {
  it('reads Android, iPhone and computers from the user agent', () => {
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128 Mobile');
    expect(platform()).toBe('android');
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    expect(platform()).toBe('ios');
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128');
    expect(platform()).toBe('desktop');
  });
});

describe('shouldAskToInstall', () => {
  it('asks by default, not within a week of "Not now", and again after it', () => {
    const now = 1_800_000_000_000;
    expect(shouldAskToInstall(now)).toBe(true);
    rememberInstallDismissal(now);
    expect(shouldAskToInstall(now + 60_000)).toBe(false);
    expect(shouldAskToInstall(now + REASK_MS + 1)).toBe(true);
  });

  it('never asks inside the app or once the app is installed', () => {
    localStorage.setItem('ws.appInstalled', '1');
    expect(shouldAskToInstall()).toBe(false);
    localStorage.clear();
    standalone(true);
    expect(shouldAskToInstall()).toBe(false);
  });
});

describe('the browser install prompt', () => {
  it('is captured, replayed once, and reports the choice', async () => {
    captureInstallPrompt();
    expect(canPromptInstall()).toBe(false);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = vi.fn(() => Promise.resolve());
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(canPromptInstall()).toBe(true);
    await expect(promptInstall()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(canPromptInstall()).toBe(false);
    expect(localStorage.getItem('ws.appInstalled')).toBe('1');
    await expect(promptInstall()).resolves.toBe('unavailable');
  });
});

describe('inside the installed app', () => {
  it('/login is a plain sign-in screen with no landing page', async () => {
    standalone(true);
    render(<MemoryRouter initialEntries={['/login']}><LoginPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByText('Three surfaces, one plant')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('InstallAppDialog per platform', () => {
  const mount = (props) => render(<InstallAppDialog onClose={vi.fn()} onNotNow={vi.fn()} {...props} />);

  it('Android without one-tap install: the app file and the steps', () => {
    mount({ platform: 'android' });
    const d = screen.getByRole('dialog', { name: 'Install the SafeKrit app' });
    expect(within(d).getByTestId('apk-download')).toHaveTextContent('Download for Android');
    expect(within(d).getByText(/Allow installs from your browser/)).toBeInTheDocument();
  });

  it('iPhone: Share, then Add to Home Screen', () => {
    mount({ platform: 'ios' });
    const d = screen.getByRole('dialog', { name: 'Install the SafeKrit app' });
    expect(within(d).getByText(/tap Share/)).toBeInTheDocument();
    expect(within(d).getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(within(d).queryByTestId('apk-download')).toBeNull();
  });

  it('where the browser can install: one Install button, then a confirmation', async () => {
    captureInstallPrompt();
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = vi.fn(() => Promise.resolve());
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    act(() => { window.dispatchEvent(event); });
    mount({ platform: 'desktop' });
    await userEvent.click(screen.getByTestId('install-app'));
    expect(await screen.findByText('SafeKrit is installed')).toBeInTheDocument();
    expect(screen.getByText(/Start menu, Dock or desktop/)).toBeInTheDocument();
  });
});
