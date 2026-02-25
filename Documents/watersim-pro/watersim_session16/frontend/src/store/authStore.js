import { create } from 'zustand';
import api from '../utils/api';

const useAuthStore = create((set, get) => ({
  user:    null,
  loading: true,
  error:   null,

  // Initialise from localStorage on app load
  init: async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) { set({ loading: false }); return; }
    try {
      const { data } = await api.get('/auth/me');
      set({ user: data, loading: false });
    } catch {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      set({ user: null, loading: false });
    }
  },

  login: async (email, password) => {
    set({ error: null });
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('accessToken',  data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    set({ user: data.user });
    return data.user;
  },

  register: async (payload) => {
    set({ error: null });
    const { data } = await api.post('/auth/register', payload);
    localStorage.setItem('accessToken',  data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    set({ user: data.user });
    return data.user;
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
