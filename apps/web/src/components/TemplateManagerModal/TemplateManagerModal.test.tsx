import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TemplateManagerModal } from './TemplateManagerModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { QuickReplyTemplate, UnifiedChat } from '../../types.ts';

const api = vi.hoisted(() => ({
  getTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

vi.mock('../../api/client.ts', () => ({ api, ApiClientError: class extends Error {} }));

const CHAT = { jid: 'ada@s.whatsapp.net', name: 'Ada Lovelace' } as UnifiedChat;

const LATE: QuickReplyTemplate = {
  id: 't-late',
  name: 'Running late',
  body: 'Ten minutes behind, sorry.',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  lastUsedAt: null,
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TemplateManagerModal />
    </QueryClientProvider>
  );
}

describe('TemplateManagerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTemplates.mockResolvedValue([LATE]);
    api.createTemplate.mockResolvedValue(LATE);
    api.updateTemplate.mockResolvedValue(LATE);
    api.deleteTemplate.mockResolvedValue({ id: LATE.id, deleted: true });
    useAppStore.setState({ activeModal: 'templates', selectedChat: CHAT, composerDrafts: {} });
  });

  afterEach(() => {
    useAppStore.setState({ activeModal: null, selectedChat: null, composerDrafts: {} });
  });

  it('renders nothing while closed', () => {
    useAppStore.setState({ activeModal: null });
    renderModal();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts a new template from the open chat’s draft', async () => {
    useAppStore.setState({ composerDrafts: { [CHAT.jid]: 'See you at nine.' } });
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /NEW TEMPLATE/ }));
    expect(screen.getByLabelText('Template text')).toHaveValue('See you at nine.');
    // The button that had focus is gone; the caret has to land somewhere useful.
    expect(screen.getByLabelText('Template name')).toHaveFocus();

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: '  Nine  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE' }));

    await waitFor(() =>
      expect(api.createTemplate).toHaveBeenCalledWith({ name: 'Nine', body: 'See you at nine.' })
    );
  });

  it('does not offer a / search as the new template’s text', () => {
    useAppStore.setState({ composerDrafts: { [CHAT.jid]: '/late' } });
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /NEW TEMPLATE/ }));
    expect(screen.getByLabelText('Template text')).toHaveValue('');
  });

  it('asks for a name before saving', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /NEW TEMPLATE/ }));
    fireEvent.change(screen.getByLabelText('Template text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(screen.getByText(/Give the template a name/)).toBeInTheDocument();
    expect(api.createTemplate).not.toHaveBeenCalled();
  });

  it('edits a template in place', async () => {
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit template "Running late"' }));
    fireEvent.change(screen.getByLabelText('Template text'), { target: { value: 'Five minutes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE' }));

    await waitFor(() =>
      expect(api.updateTemplate).toHaveBeenCalledWith('t-late', {
        name: 'Running late',
        body: 'Five minutes.',
      })
    );
  });

  it('deletes only once confirmed', async () => {
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete template "Running late"' }));
    expect(api.deleteTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /DELETE/ }));
    await waitFor(() => expect(api.deleteTemplate).toHaveBeenCalledWith('t-late'));
  });
});
