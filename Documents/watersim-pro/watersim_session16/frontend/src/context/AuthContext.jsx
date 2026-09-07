import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { authService } from '../services/auth.service';
import { can as roleCan, capabilitiesOf } from '../auth/roles';

const AuthContext = createContext(null);

// Single source of truth for the access token: localStorage (survives tab
// restarts; the httpOnly refresh cookie remains the security boundary).
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(() => localStorage.getItem('accessToken'));
  const [loading, setLoading] = useState(true);

  // On mount, try to restore session via refresh token cookie
  useEffect(() => {
    const restore = async () => {
      try {
        const data = await authService.refresh();
        setUser(data.user);
        setAccessToken(data.accessToken);
        localStorage.setItem('accessToken', data.accessToken);
      } catch {
        // No valid session — stay logged out
        localStorage.removeItem('accessToken');
      } finally {
        setLoading(false);
      }
    };
    restore();
  }, []);

  const login = useCallback(async (credentials) => {
    const data = await authService.login(credentials);
    setUser(data.user);
    setAccessToken(data.accessToken);
    localStorage.setItem('accessToken', data.accessToken);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try { await authService.logout(); } catch { /* ignore */ }
    setUser(null);
    setAccessToken(null);
    localStorage.removeItem('accessToken');
  }, []);

  const refreshToken = useCallback(async () => {
    const data = await authService.refresh();
    setUser(data.user);
    setAccessToken(data.accessToken);
    localStorage.setItem('accessToken', data.accessToken);
    return data.accessToken;
  }, []);

  // Capability view of the current role, for gating what the shell shows.
  // The server re-checks every write; this only decides what is rendered.
  const role = user?.role || null;
  const can = useCallback((capability) => roleCan(role, capability), [role]);
  const capabilities = useMemo(() => capabilitiesOf(role), [role]);

  return (
    <AuthContext.Provider
      value={{ user, role, can, capabilities, accessToken, loading, login, logout, refreshToken, isAuthenticated: !!user }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
