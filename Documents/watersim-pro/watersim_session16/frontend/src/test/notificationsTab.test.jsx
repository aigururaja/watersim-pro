/**
 * NotificationsTab — the WhatsApp provider, delivery receipts, templates,
 * receivers and the default policy.
 *
 * What is pinned: the provider banner names Meta's Cloud API or Twilio from
 * what the API reports; a sent WhatsApp row shows Meta's delivery receipt; a
 * manager can list the business account's templates with their approval and
 * mapping, and the section is absent on Twilio; the number field explains
 * how a person verifies their number; the receivers table lists every member
 * with their addresses, saves an edited number and sends a test to that
 * person; one click installs the missing default policy rows.
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
  whatsapp: { ok: true, provider, reason: provider === 'meta' ? 'template safekrit_alert' : undefined },
  dryRun: false,
});

const RECEIVERS = [
  { id: 'u1', name: 'Maya Manager', role: 'manager', login: 'm@example.com', email: { enabled: true, address: 'm@example.com', verified: true }, whatsapp: { enabled: true, address: '+919876543210', verified: true }, hears: [{ eventType: 'alarm.raised', minSeverity: 'critical', channels: ['email', 'whatsapp'] }], reachable: { email: true, whatsapp: true } },
  { id: 'u2', name: 'Vikram Viewer', role: 'viewer', login: 'v@example.com', mobile: '+919800000004', email: { enabled: true, address: 'v@example.com', verified: true }, whatsapp: { enabled: false, address: null, verified: false }, hears: [], reachable: { email: true, whatsapp: false } },
];

function answers(provider = 'meta', { verified = false, missing = ['viewer:alarm.raised'] } = {}) {
  const p = providers(provider);
  return (url) => {
    if (url === '/notifications/me') return Promise.resolve({ data: { email: { enabled: true, address: 'm@example.com', verified: true }, whatsapp: { enabled: true, address: '+919876543210', verified }, login: { email: 'm@example.com', phone: '+919876543210' }, subscriptions: [], providers: p } });
    if (url === '/notifications/events') return Promise.resolve({ data: { events: [{ type: 'alarm.raised', label: 'Alarm raised' }], channels: ['email', 'whatsapp'] } });
    if (url === '/notifications/subscriptions') return Promise.resolve({ data: { subscriptions: [], defaults: [], missingDefaults: missing } });
    if (url === '/notifications/receivers') return Promise.resolve({ data: { receivers: RECEIVERS, providers: p } });
    if (url.startsWith('/notifications/outbox')) {
      return Promise.resolve({ data: { counts: { pending: 0, sending: 0, sent: 2, failed: 0, dead: 1 }, providers: p, outbox: [
        { id: 'o1', channel: 'whatsapp', address: '+919876543210', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'sent', kind: 'template', providerId: 'wamid.1', delivery: { status: 'delivered', at: '2026-09-07T10:00:00Z' }, createdAt: '2026-09-07T10:00:00Z', userName: 'Olivia Operator' },
        { id: 'o2', channel: 'whatsapp', address: '+919876543211', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'dead', lastError: 'Delivery failed — 131026: Message undeliverable', delivery: { status: 'failed', at: '2026-09-07T10:01:00Z', error: '131026: Message undeliverable' }, createdAt: '2026-09-07T10:00:00Z' },
        { id: 'o3', channel: 'email', address: 'm@example.com', eventType: 'alarm.raised', subject: 'Alarm: TSS high', state: 'sent', delivery: null, createdAt: '2026-09-07T10:00:00Z' },
      ] } });
    }
    if (url.startsWith('/notifications/whatsapp/templates')) {
      return Promise.resolve({ data: { ok: true, provider: 'meta', templates: [
        { id: '1', name: 'safekrit_alert', status: 'APPROVED', category: 'UTILITY', language: 'en_US', params: 2, mappedTo: ['*'] },
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
    await waitFor(() => expect(screen.getByLabelText('Provider status')).toHaveTextContent('WhatsApp (Meta Cloud API): template safekrit_alert'));

    const outbox = await screen.findByLabelText('Outbox');
    expect(within(outbox).getAllByText('sent')).toHaveLength(2);
    const receipts = outbox.querySelectorAll('[data-delivery]');
    expect([...receipts].map((r) => r.dataset.delivery)).toEqual(['delivered', 'failed']);

    expect(screen.getByTestId('whatsapp-verified')).toHaveTextContent(/Send “hi”/);

    const section = screen.getByLabelText('WhatsApp templates');
    expect(section.querySelector('table')).toBeNull();
    fireEvent.click(within(section).getByLabelText('Check Meta templates'));
    await waitFor(() => expect(section.querySelector('[data-template="safekrit_alert"]')).not.toBeNull());
    expect(api.get).toHaveBeenCalledWith('/notifications/whatsapp/templates?refresh=true');
    const row = section.querySelector('[data-template="safekrit_alert"]');
    expect(row.querySelector('[data-status]').dataset.status).toBe('APPROVED');
    expect(row).toHaveTextContent('*');
    // A mapped template with the wrong parameter count is called out.
    const bad = section.querySelector('[data-template="hello_world"]');
    expect(bad.querySelector('[data-status]').dataset.status).toBe('PENDING');
    expect(bad.querySelector('td.text-red-600')).not.toBeNull();
  });

  it('lets a person receive at an address other than the login, and says which is which', async () => {
    api.get.mockImplementation(answers('meta'));
    api.put.mockResolvedValue({ data: { email: { enabled: true, address: 'alerts@example.com', verified: true }, whatsapp: { enabled: true, address: '+919876543210', verified: false }, login: { email: 'm@example.com', phone: '+919876543210' }, subscriptions: [], providers: providers('meta') } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    const input = await screen.findByLabelText('Notification email address');
    expect(input).toHaveValue('m@example.com');
    expect(screen.getByTestId('login-email')).toHaveTextContent('Same as your login email');
    expect(screen.getByTestId('profile-mobile')).toHaveTextContent('Mobile on your profile: +919876543210 — used for WhatsApp');
    fireEvent.change(input, { target: { value: 'alerts@example.com' } });
    expect(screen.getByTestId('login-email')).toHaveTextContent('you still sign in as m@example.com');
    fireEvent.click(screen.getByLabelText('Save channels'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/notifications/me/channels', expect.objectContaining({ email: { enabled: true, address: 'alerts@example.com' } })));
    expect(toast).toHaveBeenCalledWith('Notification channels saved');
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

describe('NotificationsTab — receivers for every kind of user', () => {
  it('lists every member with their addresses, saves an edited number, and sends that person a test', async () => {
    api.get.mockImplementation(answers('meta'));
    api.put.mockResolvedValue({ data: { ...RECEIVERS[1], whatsapp: { enabled: true, address: '+919876543299', verified: false }, reachable: { email: true, whatsapp: true } } });
    api.post.mockResolvedValue({ data: { channel: 'whatsapp', address: '+919876543299', state: 'sent' } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    const section = await screen.findByLabelText('Receivers');
    const rows = section.querySelectorAll('[data-receiver]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Maya Manager');
    expect(rows[0].querySelector('[data-verified="yes"]')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('nothing yet — add a policy row for every viewer');
    expect(within(rows[1]).getByTestId('profile-u2')).toHaveTextContent('login v@example.com · mobile +919800000004');
    // No number, no WhatsApp test.
    expect(within(section).getByLabelText('Test WhatsApp to Vikram Viewer')).toBeDisabled();
    expect(within(section).getByLabelText('Save receiver Vikram Viewer')).toBeDisabled();

    fireEvent.change(within(section).getByLabelText('WhatsApp number for Vikram Viewer'), { target: { value: '98765 43299' } });
    fireEvent.click(within(section).getByLabelText('WhatsApp for Vikram Viewer'));
    fireEvent.click(within(section).getByLabelText('Save receiver Vikram Viewer'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/notifications/receivers/u2', { email: { enabled: true, address: 'v@example.com' }, whatsapp: { enabled: true, address: '9876543299' } }));
    await waitFor(() => expect(within(section).getByLabelText('WhatsApp number for Vikram Viewer')).toHaveValue('+919876543299'));
    expect(toast).toHaveBeenCalledWith('Vikram Viewer: receiver saved');

    fireEvent.click(within(section).getByLabelText('Test WhatsApp to Vikram Viewer'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/notifications/test', { channel: 'whatsapp', userId: 'u2' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Test whatsapp sent to +919876543299', true));
  });

  it('installs the missing default policy rows in one click', async () => {
    api.get.mockImplementation(answers('meta'));
    api.post.mockResolvedValue({ data: { added: 1, existing: 13, total: 14 } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    const button = await screen.findByLabelText('Install the default policy for every role');
    expect(button).toHaveTextContent('(1 missing)');
    fireEvent.click(button);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/notifications/subscriptions/defaults'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Default policy: 1 row(s) added, 13 already there'));
  });

  it('says so when every role already has its rows', async () => {
    api.get.mockImplementation(answers('meta', { missing: [] }));
    render(<NotificationsTab showToast={vi.fn()} />);
    const button = await screen.findByLabelText('Install the default policy for every role');
    expect(button).toHaveTextContent('Default policy installed');
    expect(button).toBeDisabled();
  });
});

describe('NotificationsTab — Send test goes to the number on screen', () => {
  const savedMe = (address) => ({ data: {
    email: { enabled: true, address: 'm@example.com', verified: true },
    whatsapp: { enabled: true, address, verified: false },
    login: { email: 'm@example.com', phone: '+919876543210' }, subscriptions: [], providers: providers('meta'),
  } });

  it('saves an edited WhatsApp number first, then sends the test there', async () => {
    api.get.mockImplementation(answers('meta'));
    api.put.mockResolvedValue(savedMe('+916381794189'));
    api.post.mockResolvedValue({ data: { id: 'o9', channel: 'whatsapp', address: '+916381794189', state: 'sent' } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    const input = await screen.findByLabelText('WhatsApp number');
    fireEvent.change(input, { target: { value: '+916381794189' } });
    fireEvent.click(screen.getByLabelText('Send test WhatsApp'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/notifications/test', { channel: 'whatsapp' }));
    expect(api.put).toHaveBeenCalledWith('/notifications/me/channels', expect.objectContaining({ whatsapp: { enabled: true, address: '+916381794189' } }));
    expect(api.put.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Saved and sent to +916381794189', true));
  });

  it('sends without saving when nothing on screen changed', async () => {
    api.get.mockImplementation(answers('meta'));
    api.post.mockResolvedValue({ data: { id: 'o9', channel: 'whatsapp', address: '+919876543210', state: 'sent' } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    await screen.findByLabelText('WhatsApp number');
    fireEvent.click(screen.getByLabelText('Send test WhatsApp'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/notifications/test', { channel: 'whatsapp' }));
    expect(api.put).not.toHaveBeenCalled();
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Test whatsapp sent to +919876543210', true));
  });

  it('does not send when the save of the edited number is refused', async () => {
    api.get.mockImplementation(answers('meta'));
    api.put.mockRejectedValue({ response: { data: { error: 'Not a valid WhatsApp number' } } });
    const toast = vi.fn();
    render(<NotificationsTab showToast={toast} />);
    const input = await screen.findByLabelText('WhatsApp number');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.click(screen.getByLabelText('Send test WhatsApp'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Not a valid WhatsApp number', false));
    expect(api.post).not.toHaveBeenCalled();
  });
});
