import { create } from 'zustand';
import api from '../utils/api';

const useAuthStore = create((set, get) => ({
  user:    null,
  loading: true,
  error:   null,

  // Initialise from localStorage on app load
  init: async () => {
    const token = localStorage.getItem('accessToken');
    if (!token || token === 'undefined') {
      localStorage.removeItem('accessToken');
      set({ loading: false });
      return;
    }
    try {
      const { data: resp } = await api.get('/auth/me');
      // Server wraps: { success, data: { user } }
      const user = resp.data?.user || resp.user || resp.data || resp;
      set({ user, loading: false });
    } catch {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      set({ user: null, loading: false });
    }
  },

  login: async (email, password) => {
    set({ error: null });
    const { data: resp } = await api.post('/auth/login', { email, password });
    // Server wraps: { success, data: { accessToken, user } }
    const inner = resp.data || resp;
    localStorage.setItem('accessToken', inner.accessToken);
    set({ user: inner.user });
    return inner.user;
  },

  register: async (payload) => {
    set({ error: null });
    const { data: resp } = await api.post('/auth/register', payload);
    // Server wraps: { success, data: { accessToken, user } }
    const inner = resp.data || resp;
    if (inner.accessToken) {
      localStorage.setItem('accessToken', inner.accessToken);
    }
    set({ user: inner.user });
    return inner.user;
  },

  logout: async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    try { await api.post('/auth/logout', { refreshToken }); } catch {}
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    set({ user: null });
  },

  isAuthenticated: () => !!get().user,
}));

export default useAuthStore;
