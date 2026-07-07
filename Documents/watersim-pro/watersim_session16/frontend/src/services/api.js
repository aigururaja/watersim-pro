import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // include httpOnly cookies
});

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, attempt one token refresh then retry
let refreshPromise = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const url = original?.url || '';
    // The auth endpoints' own 401s must NOT trigger the refresh-and-redirect
    // logic — otherwise a "no session" refresh 401 redirects to /login, which
    // reloads the app, which calls refresh again → infinite flicker loop.
    const isAuthCall = url.includes('/auth/refresh') || url.includes('/auth/login');
    if (error.response?.status === 401 && !original._retry && !isAuthCall) {
      original._retry = true;
      try {
        if (!refreshPromise) {
          // Use raw axios (not the intercepted instance) to avoid infinite retry loops
          refreshPromise = axios.post('/api/v1/auth/refresh', {}, { withCredentials: true }).finally(() => { refreshPromise = null; });
        }
        const { data } = await refreshPromise;
        const newToken = data.data.accessToken;
        sessionStorage.setItem('accessToken', newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch {
        // Refresh failed — session expired: clear it and redirect to login
        sessionStorage.removeItem('accessToken');
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login?expired=1';
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
