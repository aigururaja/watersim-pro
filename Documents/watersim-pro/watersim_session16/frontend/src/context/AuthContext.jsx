import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { authService } from '../services/auth.service';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(() => sessionStorage.getItem('accessToken'));
  const [loading, setLoading] = useState(true);

  // On mount, try to restore session via refresh token cookie
  useEffect(() => {
    const restore = async () => {
      try {
        const data = await authService.refresh();
        setUser(data.user);
        setAccessToken(data.accessToken);
        sessionStorage.setItem('accessToken', data.accessToken);
      } catch {
        // No valid session — stay logged out
        sessionStorage.removeItem('accessToken');
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
    sessionStorage.setItem('accessToken', data.accessToken);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try { await authService.logout(); } catch { /* ignore */ }
    setUser(null);
    setAccessToken(null);
    sessionStorage.removeItem('accessToken');
  }, []);

  const refreshToken = useCallback(async () => {
    const data = await authService.refresh();
    setUser(data.user);
    setAccessToken(data.accessToken);
    sessionStorage.setItem('accessToken', data.accessToken);
    return data.accessToken;
  }, []);

  return (
    <AuthContext.Provider value={{ user, accessToken, loading, login, logout, refreshToken, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
