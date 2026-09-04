/**
 * useReducedMotion — the fourth reduced-motion layer (spec §6.5).
 *
 * Two inputs, OR'd:
 *   1. the OS `prefers-reduced-motion: reduce` media query, live-updated
 *   2. a `ws.motion = auto|off` localStorage override, surfaced beside the
 *      ⚡ Live button
 *
 * The override is deliberately one-directional: a user may always turn motion
 * OFF, but nothing in the UI may turn it back on over the top of an OS
 * accessibility preference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useReducedMotion,
  setMotionSetting,
  readMotionSetting,
  MOTION_STORAGE_KEY,
} from '../components/AccessibilityProvider';

const realMatchMedia = window.matchMedia;

/** A controllable `prefers-reduced-motion` media query. */
function mockMatchMedia(matches) {
  const listeners = new Set();
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (type, cb) => { if (type === 'change') listeners.add(cb); },
    removeEventListener: (type, cb) => { if (type === 'change') listeners.delete(cb); },
    addListener: (cb) => listeners.add(cb),        // Safari < 14
    removeListener: (cb) => listeners.delete(cb),
    dispatchEvent: () => true,
    /** Flip the OS preference and tell every listener. */
    emit(next) {
      mql.matches = next;
      listeners.forEach((cb) => cb({ matches: next }));
    },
    listenerCount: () => listeners.size,
  };
  window.matchMedia = vi.fn(() => mql);
  return mql;
}

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia(false);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  localStorage.clear();
});

describe('readMotionSetting / setMotionSetting', () => {
  it('defaults to auto and only ever stores auto or off', () => {
    expect(readMotionSetting()).toBe('auto');
    expect(setMotionSetting('off')).toBe('off');
    expect(readMotionSetting()).toBe('off');
    expect(setMotionSetting('on')).toBe('auto');      // "on" is not a thing
    expect(readMotionSetting()).toBe('auto');
  });

  it('treats an unrecognised stored value as auto', () => {
    localStorage.setItem(MOTION_STORAGE_KEY, 'wobble');
    expect(readMotionSetting()).toBe('auto');
  });
});

describe('useReducedMotion', () => {
  it('is false when the OS has no preference and there is no override', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('is true when the OS prefers reduced motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('is true from the ws.motion override even when the OS has no preference', () => {
    localStorage.setItem(MOTION_STORAGE_KEY, 'off');
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('follows a live change of the OS preference', () => {
    const mql = mockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => mql.emit(true));
    expect(result.current).toBe(true);

    act(() => mql.emit(false));
    expect(result.current).toBe(false);
  });

  it('follows the override changing in this tab, and never un-does the OS preference', () => {
    const mql = mockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => { setMotionSetting('off'); });
    expect(result.current).toBe(true);

    act(() => { setMotionSetting('auto'); });
    expect(result.current).toBe(false);

    // OS says reduce → `auto` must NOT turn motion back on.
    act(() => mql.emit(true));
    act(() => { setMotionSetting('auto'); });
    expect(result.current).toBe(true);
  });

  it('detaches its listeners on unmount', () => {
    const mql = mockMatchMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(mql.listenerCount()).toBe(1);
    unmount();
    expect(mql.listenerCount()).toBe(0);
  });

  it('falls back to the override alone when matchMedia is unavailable', () => {
    // Older browsers, and some embedded webviews, have no matchMedia at all.
    // Shadow it with undefined rather than `delete`, which would just expose
    // jsdom's own Window.prototype implementation again.
    window.matchMedia = undefined;
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    unmount();

    localStorage.setItem(MOTION_STORAGE_KEY, 'off');
    const second = renderHook(() => useReducedMotion());
    expect(second.result.current).toBe(true);
    second.unmount();
  });
});
