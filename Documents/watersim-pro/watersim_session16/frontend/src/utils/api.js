import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE || '/api/v1';

export const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: false,
});

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh on 401 TOKEN_EXPIRED
let refreshing = false;
let queue = [];

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const data = error.response?.data;

    if (error.response?.status === 401 && (data?.code === 'TOKEN_EXPIRED' || data?.error?.code === 'TOKEN_EXPIRED') && !original._retry) {
      if (refreshing) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve, reject, config: original });
        });
      }
      original._retry = true;
      refreshing = true;
      try {
        const { data: tokens } = await axios.post(`${BASE}/auth/refresh`, {}, { withCredentials: true });
        sessionStorage.setItem('accessToken', tokens.data?.accessToken || tokens.accessToken);
        queue.forEach(({ resolve, config }) => {
          config.headers.Authorization = `Bearer ${sessionStorage.getItem('accessToken')}`;
          resolve(api(config));
        });
        queue = [];
        original.headers.Authorization = `Bearer ${sessionStorage.getItem('accessToken')}`;
        return api(original);
      } catch (refreshErr) {
        queue.forEach(({ reject }) => reject(refreshErr));
        queue = [];
        sessionStorage.removeItem('accessToken');
        window.location.href = '/login';
        return Promise.reject(refreshErr);
      } finally {
        refreshing = false;
      }
    }
    return Promise.reject(error);
  }
);

export default api;
