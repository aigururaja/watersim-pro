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

// The auth endpoints must never trigger the refresh-and-logout flow themselves,
// or a refresh/login 401 would recurse into another refresh → redirect loop.
function isAuthEndpoint(url = '') {
  return url.includes('/auth/refresh') || url.includes('/auth/login') || url.includes('/auth/register');
}

// Session has expired and cannot be recovered → log the user out and send them
// to the login page. Runs once even if several requests fail at the same time.
let sessionExpiring = false;
async function handleSessionExpired() {
  if (sessionExpiring) return;
  sessionExpiring = true;

  sessionStorage.removeItem('accessToken');
  // Best-effort: revoke the refresh-token cookie server-side so the session is
  // truly dead (otherwise a reload could silently refresh back in).
  try { await axios.post(`${BASE}/auth/logout`, {}, { withCredentials: true }); } catch { /* already gone */ }

  // Avoid redirecting if we are already on the login page.
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login?expired=1';
  }
}

// Auto-refresh on 401, then retry. Any 401 that can't be recovered by a refresh
// (expired, invalid, or missing token) is treated as an expired session.
let refreshing = false;
let queue = [];

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config || {};

    if (error.response?.status !== 401 || original._retry || isAuthEndpoint(original.url)) {
      return Promise.reject(error);
    }

    // A refresh is already in flight — queue this request until it resolves.
    if (refreshing) {
      return new Promise((resolve, reject) => queue.push({ resolve, reject, config: original }));
    }

    original._retry = true;
    refreshing = true;
    try {
      // Use raw axios (not this instance) so the refresh call isn't intercepted.
      const { data: tokens } = await axios.post(`${BASE}/auth/refresh`, {}, { withCredentials: true });
      const newToken = tokens.data?.accessToken || tokens.accessToken;
      if (!newToken) throw new Error('No access token returned from refresh');
      sessionStorage.setItem('accessToken', newToken);

      // Replay any requests that were queued while the refresh was in flight.
      queue.forEach(({ resolve, config }) => {
        config.headers.Authorization = `Bearer ${newToken}`;
        resolve(api(config));
      });
      queue = [];

      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    } catch (refreshErr) {
      // Refresh failed → session is truly expired. Reject everything and log out.
      queue.forEach(({ reject }) => reject(refreshErr));
      queue = [];
      await handleSessionExpired();
      return Promise.reject(refreshErr);
    } finally {
      refreshing = false;
    }
  }
);

export default api;
