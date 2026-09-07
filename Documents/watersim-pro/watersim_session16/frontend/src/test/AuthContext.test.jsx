import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { authService } from '../services/auth.service';

vi.mock('../services/auth.service', () => ({
  authService: {
    refresh: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
    me: vi.fn(),
  },
}));

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Default: no restorable session on mount
  authService.refresh.mockRejectedValue(new Error('no session'));
});

describe('AuthContext', () => {
  it('login stores the token in localStorage and sets the user', async () => {
    authService.login.mockResolvedValue({
      user: { id: 'u1', firstName: 'Sonia', role: 'engineer' },
      accessToken: 'tok-123',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => {
      await result.current.login({ email: 'sonia@example.com', password: 'pw' });
    });

    expect(result.current.user).toEqual({ id: 'u1', firstName: 'Sonia', role: 'engineer' });
    expect(result.current.accessToken).toBe('tok-123');
    expect(result.current.isAuthenticated).toBe(true);
    expect(localStorage.getItem('accessToken')).toBe('tok-123');
    // localStorage is the single token store — nothing goes to sessionStorage
    expect(sessionStorage.getItem('accessToken')).toBeNull();
  });

  it('logout clears the user and removes the stored token', async () => {
    authService.login.mockResolvedValue({
      user: { id: 'u1', firstName: 'Sonia' },
      accessToken: 'tok-123',
    });
    authService.logout.mockResolvedValue();

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.login({ email: 'x', password: 'y' }); });
    expect(localStorage.getItem('accessToken')).toBe('tok-123');

    await act(async () => { await result.current.logout(); });

    expect(authService.logout).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
    expect(result.current.accessToken).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem('accessToken')).toBeNull();
  });

  it('exposes the role as capabilities so the shell can gate itself before any API call', async () => {
    authService.login.mockResolvedValue({
      user: { id: 'u3', firstName: 'Meera', role: 'manager' },
      accessToken: 'tok-mgr',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Logged out: no role, nothing granted, but the shape is stable.
    expect(result.current.role).toBeNull();
    expect(result.current.can('ops.view')).toBe(false);
    expect(result.current.capabilities).toEqual([]);

    await act(async () => { await result.current.login({ email: 'm', password: 'p' }); });

    expect(result.current.role).toBe('manager');
    expect(result.current.can('task.approve')).toBe(true);   // manager's own verb
    expect(result.current.can('model.edit')).toBe(true);     // inherited from engineer
    expect(result.current.can('audit.read')).toBe(false);    // admin only
    expect(result.current.can('no.such')).toBe(false);       // unknown verb never grants
    expect(result.current.capabilities).toContain('alarm.ack_critical');
    expect(result.current.capabilities).not.toContain('users.manage');

    await act(async () => { await result.current.logout(); });
    expect(result.current.role).toBeNull();
    expect(result.current.can('task.approve')).toBe(false);
  });

  it('restores a session from the refresh cookie on mount', async () => {
    authService.refresh.mockResolvedValue({
      user: { id: 'u2', firstName: 'Raj' },
      accessToken: 'restored-tok',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.user).toEqual({ id: 'u2', firstName: 'Raj' });
    expect(localStorage.getItem('accessToken')).toBe('restored-tok');
  });
});
