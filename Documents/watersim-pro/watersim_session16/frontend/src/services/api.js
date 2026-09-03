import axios from 'axios';

// Honor VITE_API_BASE when provided (e.g. a full http://localhost:3001/api/v1
// URL in environments without the dev proxy); fall back to the proxied path.
const BASE = import.meta.env.VITE_API_BASE || '/api/v1';

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // include httpOnly refresh cookie
});

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── 401 handling ────────────────────────────────────────────────────────────
// On any 401 for an authenticated (non-/auth/) request:
//   1. All concurrent failures share a single in-flight refresh promise.
//   2. Each failed request is replayed exactly once (config._retry guards it).
// If the refresh itself fails, the session is cleared and we go to /login.
let refreshPromise = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = api
      .post('/auth/refresh')
      .then(({ data }) => {
        const newToken = data?.data?.accessToken ?? data?.accessToken;
        if (!newToken) throw new Error('No access token in refresh response');
        localStorage.setItem('accessToken', newToken);
        return newToken;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const isAuthEndpoint = (original?.url || '').includes('/auth/');
    const wasAuthed = !!original?.headers?.Authorization;

    if (status === 401 && original && !original._retry && !isAuthEndpoint && wasAuthed) {
      original._retry = true; // every replayed config carries the guard
      try {
        const newToken = await refreshAccessToken();
        original.headers = { ...original.headers, Authorization: `Bearer ${newToken}` };
        return api(original);
      } catch {
        // Refresh failed — clear session and redirect to login
        localStorage.removeItem('accessToken');
        if (typeof window !== 'undefined' && window.location) {
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export { api };
export default api;
