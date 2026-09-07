import api from './api';

export const authService = {
  async register(data) {
    const res = await api.post('/auth/register', data);
    return res.data.data;
  },
  async login({ email, password, orgSlug }) {
    const res = await api.post('/auth/login', { email, password, orgSlug });
    return res.data.data;
  },
  async refresh() {
    const res = await api.post('/auth/refresh');
    return res.data.data;
  },
  async logout() {
    await api.post('/auth/logout');
  },
  async me() {
    const res = await api.get('/auth/me');
    return res.data.data.user;
  },
  /** The organisations a person can sign in to: [{ slug, name }] — public, for the login page's picker. */
  async organisations() {
    const res = await api.get('/auth/organisations');
    return Array.isArray(res.data?.data) ? res.data.data : [];
  },
};
