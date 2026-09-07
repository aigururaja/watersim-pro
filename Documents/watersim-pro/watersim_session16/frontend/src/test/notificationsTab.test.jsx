/**
 * NotificationsTab — the WhatsApp provider, delivery receipts and templates.
 *
 * What is pinned: the provider banner names Meta's Cloud API or Twilio from
 * what the API reports; a sent WhatsApp row shows Meta's delivery receipt; a
 * manager can list the business account's templates with their approval and
 * mapping, and the section is absent on Twilio; the number field explains
 * how a person verifies their number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import NotificationsTab from '../components/settings/NotificationsTab';
import api from '../services/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'manager' }, role: 'manager', can: () => true }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});

const providers = (provider) => ({
  email: { ok: false, reason: 'SMTP_HOST is not set' },
  whatsapp: { ok: true, provider, reason: provider === 'meta' ? 'template watersim_alert' : undefined },
  dryRun: false,
});

function answers(provider = 'meta', { verified = false } = {}) {
  const p = providers(provider);
  return (url) => {
    if (url === '/notifications/me') return Promise.resolve({ data: { email: { enabled: true, address: 'm@example.com', verified: true }, whatsapp: { enabled: true, address: '+919876543210', verified }, subscriptions: [], providers: p } });
    if (url === '/notifications/events') return Promise.resolve({ data: { events: [{ type: 'alarm.raised', label: 'Alarm raised' }], channels: ['email', 'whatsapp'] } });
    if (url === '/notifications/subscriptions') return Promise.resolve({ data: { subscriptions: [] } });
    if (url.startsWith('/notifications/outbox')) {
      return Promise.resolve({ data: { counts: { pending: 0, sending: 0, sent: 2, failed: 0, dead: 1 }, providers: p, outbox: [
        { id: 'o1', channel: 'whatsapp', address: '+919876543210', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'sent', kind: 'template', providerId: 'wamid.1', delivery: { status: 'delivered', at: '2026-09-07T10:00:00Z' }, createdAt: '2026-09-07T10:00:00Z', userName: 'Olivia Operator' },
        { id: 'o2', channel: 'whatsapp', address: '+919876543211', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'dead', lastError: 'Delivery failed — 131026: Message undeliverable', delivery: { status: 'failed', at: '2026-09-07T10:01:00Z', error: '131026: Message undeliverable' }, createdAt: '2026-09-07T10:00:00Z' },
        { id: 'o3', channel: 'email', address: 'm@example.com', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'sent', delivery: null, createdAt: '2026-09-07T10:00:00Z' },
      ] } });
    }
    if (url.startsWith('/notifications/whatsapp/templates')) {
      return Promise.resolve({ data: { ok: true, provider: 'meta', templates: [
        { id: '1', name: 'watersim_alert', status: 'APPROVED', category: 'UTILITY', language: 'en_US', params: 2, mappedTo: ['*'] },
        { id: '2', name: 'staff_task_assigned_18t5k', status: 'APPROVED', category: 'UTILITY', language: 'en_US', params: 2, mappedTo: [] },
        { id: '3', name: 'hello_world', status: 'PENDING', category: 'UTILITY', language: 'en_US', params: 0, mappedTo: ['task.'] },
      ] } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('NotificationsTab — WhatsApp through Meta', () => {
  it('names the provider, shows delivery receipts, and lists the templates on request', async () => {
    api.get.mockImplementation(answers('meta'));
    render(<NotificationsTab showToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Provider status')).toHaveTextContent('WhatsApp (Meta Cloud API): template watersim_alert'));

    const outbox = await screen.findByLabelText('Outbox');
    expect(within(outbox).getAllByText('sent')).toHaveLength(2);
    const receipts = outbox.querySelectorAll('[data-delivery]');
    expect([...receipts].map((r) => r.dataset.delivery)).toEqual(['delivered', 'failed']);

    expect(screen.getByTestId('whatsapp-verified')).toHaveTextContent(/Send “hi”/);

    const section = screen.getByLabelText('WhatsApp templates');
    expect(section.querySelector('table')).toBeNull();
    fireEvent.click(within(section).getByLabelText('Check Meta templates'));
    await waitFor(() => expect(section.querySelector('[data-template="watersim_alert"]')).not.toBeNull());
    expect(api.get).toHaveBeenCalledWith('/notifications/whatsapp/templates?refresh=true');
    const row = section.querySelector('[data-template="watersim_alert"]');
    expect(row.querySelector('[data-status]').dataset.status).toBe('APPROVED');
    expect(row).toHaveTextContent('*');
    // A mapped template with the wrong parameter count is called out.
    const bad = section.querySelector('[data-template="hello_world"]');
    expect(bad.querySelector('[data-status]').dataset.status).toBe('PENDING');
    expect(bad.querySelector('td.text-red-600')).not.toBeNull();
  });

  it('says a verified number is verified', async () => {
    api.get.mockImplementation(answers('meta', { verified: true }));
    render(<NotificationsTab showToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('whatsapp-verified')).toHaveTextContent(/^Verified/));
  });

  it('on Twilio the banner says so and there is no template section', async () => {
    api.get.mockImplementation(answers('twilio'));
    render(<NotificationsTab showToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Provider status')).toHaveTextContent('WhatsApp (Twilio): configured'));
    await screen.findByLabelText('Outbox');
    expect(screen.queryByLabelText('WhatsApp templates')).toBeNull();
  });
});
