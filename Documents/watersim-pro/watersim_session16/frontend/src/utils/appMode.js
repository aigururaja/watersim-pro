/**
 * App mode and app installation.
 *
 * SafeKrit is reached two ways: in a browser, where "/" is the public landing
 * page, and as an installed app (the Android app, an app installed from the
 * browser, a home-screen app on iPhone, or a native wrapper). The installed
 * app must never show the landing page: it opens on a plain sign-in screen
 * and then the dashboard.
 *
 * The landing page asks visitors to install the app. Where the browser offers
 * one-tap installation (Chrome and Edge, on computers and Android) the
 * `beforeinstallprompt` event is captured at start-up and replayed from the
 * landing page's own install button; elsewhere the dialog explains the steps
 * (iPhone) or offers the Android app file.
 */

const APP_MODE_KEY = 'ws.appMode';
const DISMISS_KEY = 'ws.installPrompt.dismissedAt';
const INSTALLED_KEY = 'ws.appInstalled';
/** A dismissed install prompt is asked again after this long. */
export const REASK_MS = 7 * 24 * 60 * 60 * 1000;
/** Native wrappers identify themselves with this token in their user agent. */
const WRAPPER_TOKEN = /SafeKrit-(Android|iOS)/i;

/** The Android app file the landing page offers. */
export const APK = { href: '/downloads/safekrit.apk', version: '1.0.0', size: '1.2 MB' };

const media = (query) => {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches === true; } catch { return false; }
};
const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* blocked storage */ } },
};
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked storage */ } },
};

/**
 * True when running as an installed app rather than in a browser tab. Once
 * detected it is remembered for the session: the Android app announces itself
 * through the referrer of the first page only.
 */
export function isInstalledApp() {
  if (typeof window === 'undefined') return false;
  if (session.get(APP_MODE_KEY) === '1') return true;
  const standalone = media('(display-mode: standalone)') || media('(display-mode: fullscreen)')
    || media('(display-mode: window-controls-overlay)') || window.navigator?.standalone === true;
  const androidApp = typeof document !== 'undefined' && String(document.referrer || '').startsWith('android-app://');
  const wrapper = WRAPPER_TOKEN.test(window.navigator?.userAgent || '');
  const yes = Boolean(standalone || androidApp || wrapper);
  if (yes) session.set(APP_MODE_KEY, '1');
  return yes;
}

/** 'android' | 'ios' | 'desktop' — which install instructions apply. */
export function platform() {
  const nav = typeof window !== 'undefined' ? window.navigator : undefined;
  const ua = nav?.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (nav?.maxTouchPoints || 0) > 1)) return 'ios';
  return 'desktop';
}

// ── The browser's install prompt ─────────────────────────────────────────────

let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

/** Call once at start-up: the browser fires beforeinstallprompt before any page mounts. */
export function captureInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // the landing page asks instead of the browser's own bar
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    local.set(INSTALLED_KEY, '1');
    notify();
  });
}

export const canPromptInstall = () => deferredPrompt !== null;

/** Show the browser's install dialog. Resolves 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  const e = deferredPrompt;
  if (!e) return 'unavailable';
  deferredPrompt = null; // a prompt event can be used once
  notify();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    if (choice?.outcome === 'accepted') local.set(INSTALLED_KEY, '1');
    return choice?.outcome || 'dismissed';
  } catch {
    return 'unavailable';
  }
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── When to ask ──────────────────────────────────────────────────────────────

/** Ask on the landing page unless this is the app, the app was installed here, or the visitor said "Not now" recently. */
export function shouldAskToInstall(now = Date.now()) {
  if (isInstalledApp()) return false;
  if (local.get(INSTALLED_KEY) === '1') return false;
  const dismissed = Number(local.get(DISMISS_KEY) || 0);
  return !(dismissed && now - dismissed < REASK_MS);
}

export function rememberInstallDismissal(now = Date.now()) {
  local.set(DISMISS_KEY, String(now));
}

/** Test hook: forget any captured prompt. */
export function resetInstallPromptForTests() {
  deferredPrompt = null;
  listeners.clear();
}
