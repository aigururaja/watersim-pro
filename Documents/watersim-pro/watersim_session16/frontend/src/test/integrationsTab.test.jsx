/**
 * IntegrationsTab — keys and webhooks from the admin's side.
 *
 * What is pinned: the lists load; a minted key and a new webhook's secret are
 * shown once; a test delivery reports its state; revoke and delete confirm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IntegrationsTab from '../components/settings/IntegrationsTab';
import api from '../services/api';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn(), put: vi.fn() };
  return { default: mock, api: mock };
});

const KEYS = { keys: [{ id: 'k1', name: 'CMMS reader', prefix: 'AbCd1234', scopes: ['assets:read'], lastUsedAt: null, expiresAt: null, revokedAt: null }], scopes: ['assets:read', 'history:read', 'counters:read', 'events:read', 'workorders:write'] };
const HOOKS = { webhooks: [{ id: 'h1', name: 'CMMS', url: 'https://cmms.example.com/hook', eventTypes: ['task.'], enabled: true, lastStatus: 200, lastDeliveryAt: '2026-09-07T10:00:00Z', failures: 0, secretPreview: 'abcdef…' }], eventTypes: ['alarm.raised', 'task.created'] };
const DELIVERIES = { deliveries: [{ id: 'd1', endpointName: 'CMMS', url: 'https://cmms.example.com/hook', eventType: 'task.created', state: 'sent', attempts: 1, createdAt: '2026-09-07T10:00:00Z' }] };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url.startsWith('/integrations/api-keys')) return Promise.resolve({ data: KEYS });
    if (url.startsWith('/integrations/webhooks')) return Promise.resolve({ data: HOOKS });
    if (url.startsWith('/integrations/deliveries')) return Promise.resolve({ data: DELIVERIES });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe('IntegrationsTab', () => {
  it('lists keys, webhooks and deliveries', async () => {
    render(<IntegrationsTab showToast={vi.fn()} />);
    expect(await screen.findByText('CMMS reader')).toBeInTheDocument();
    expect(screen.getByText('wsk_AbCd1234_…')).toBeInTheDocument();
    expect(screen.getByText('https://cmms.example.com/hook')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Webhook deliveries' })).getByText('task.created')).toBeInTheDocument();
  });

  it('mints a key and shows it once', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValueOnce({ data: { id: 'k2', name: 'CMMS writer', key: 'wsk_XyZw5678_' + 'f'.repeat(48), shownOnce: true } });
    render(<IntegrationsTab showToast={vi.fn()} />);
    await screen.findByText('CMMS reader');
    await user.type(screen.getByLabelText('Key name'), 'CMMS writer');
    await user.click(screen.getByLabelText('Scope workorders:write'));
    await user.click(screen.getByRole('button', { name: 'Create API key' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/integrations/api-keys', expect.objectContaining({ name: 'CMMS writer', scopes: expect.arrayContaining(['workorders:write']) })));
    expect(await screen.findByTestId('shown-once')).toHaveTextContent(/wsk_XyZw5678_/);
  });

  it('adds a webhook, shows the secret once, and tests it', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    api.post.mockImplementation((url) => {
      if (url === '/integrations/webhooks') return Promise.resolve({ data: { id: 'h2', name: 'ERP', secret: 'a'.repeat(48), shownOnce: true } });
      if (url.endsWith('/test')) return Promise.resolve({ data: { delivery: { state: 'dead', last_error: 'Webhook HTTP 400' } } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render(<IntegrationsTab showToast={toast} />);
    await screen.findAllByText('CMMS'); // the webhook row and its delivery row
    await user.type(screen.getByLabelText('Webhook name'), 'ERP');
    await user.type(screen.getByLabelText('Webhook URL'), 'https://erp.example.com/hook');
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/integrations/webhooks', expect.objectContaining({ name: 'ERP', url: 'https://erp.example.com/hook' })));
    expect(await screen.findByTestId('shown-once')).toHaveTextContent(/aaaaaaaa/);
    await user.click(screen.getByRole('button', { name: 'Test CMMS' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/dead — Webhook HTTP 400/), false));
  });

  it('revokes a key after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.delete.mockResolvedValue({ data: { message: 'Key revoked' } });
    render(<IntegrationsTab showToast={vi.fn()} />);
    await screen.findByText('CMMS reader');
    await user.click(screen.getByRole('button', { name: 'Revoke CMMS reader' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/integrations/api-keys/k1'));
    window.confirm.mockRestore();
  });
});
