import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagManagerModal } from './TagManagerModal.tsx';
import { useAppStore } from '../../store/appStore.ts';

const getTags = vi.hoisted(() => vi.fn());
const renameTag = vi.hoisted(() => vi.fn());
const deleteTag = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getTags, renameTag, deleteTag },
  ApiClientError: class extends Error {},
}));

const VOCABULARY = {
  tags: ['clients', 'work'],
  byJid: {
    'alice@s.whatsapp.net': ['work'],
    'bob@s.whatsapp.net': ['work'],
    'carol@s.whatsapp.net': ['clients'],
  },
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TagManagerModal />
    </QueryClientProvider>
  );
}

describe('TagManagerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTags.mockResolvedValue(VOCABULARY);
    renameTag.mockResolvedValue({ from: 'work', to: 'clients', renamed: 2, merged: false });
    deleteTag.mockResolvedValue({ tag: 'work', removed: 2 });
    useAppStore.setState({ activeModal: 'tag-manager', tagFilter: null });
  });

  afterEach(() => {
    useAppStore.setState({ activeModal: null, tagFilter: null });
  });

  it('stays closed until it is asked for', () => {
    useAppStore.setState({ activeModal: null });
    renderModal();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('states how many chats each tag reaches, so neither button is a leap', async () => {
    renderModal();

    expect(await screen.findByText('2 chats')).toBeInTheDocument();
    expect(screen.getByText('1 chat')).toBeInTheDocument();
  });

  it('says so plainly when there is no vocabulary yet', async () => {
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    renderModal();

    expect(await screen.findByText(/No tags yet/i)).toBeInTheDocument();
  });

  it('renames a tag everywhere it is used', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, 'projects');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    await waitFor(() => expect(renameTag).toHaveBeenCalledWith({ from: 'work', to: 'projects' }));
  });

  it('folds the new name before sending it, so no second spelling gets in', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, '  Follow Up ');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    await waitFor(() => expect(renameTag).toHaveBeenCalledWith({ from: 'work', to: 'follow-up' }));
  });

  it('asks before merging into a name that already exists, rather than after', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, 'clients');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    // The first press explains the merge and its reach; nothing has moved yet.
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // work (alice, bob) unioned with clients (carol) is three chats, not four.
    expect(screen.getByText(/3 chats/)).toBeInTheDocument();
    expect(renameTag).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'MERGE' }));
    await waitFor(() => expect(renameTag).toHaveBeenCalledWith({ from: 'work', to: 'clients' }));
  });

  it('re-asks when the name changes after the merge prompt was answered', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, 'clients');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));
    await screen.findByText(/already exists/i);

    // Editing makes it a different question, so the prompt stands down and the
    // button stops offering to merge.
    await user.type(input, '-eu');
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'SAVE' }));
    await waitFor(() => expect(renameTag).toHaveBeenCalledWith({ from: 'work', to: 'clients-eu' }));
  });

  it('refuses a name that folds away to nothing', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(await screen.findByText(/needs at least one character/i)).toBeInTheDocument();
    expect(renameTag).not.toHaveBeenCalled();
  });

  it('treats a rename to the same name as a cancel, not a round trip', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(renameTag).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByLabelText('New name for tag "work"')).not.toBeInTheDocument()
    );
  });

  it('carries a rail filtered on the old name over to the new one', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ tagFilter: 'work' });
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, 'projects');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    await waitFor(() => expect(useAppStore.getState().tagFilter).toBe('projects'));
  });

  it('names the reach in the delete confirmation, and waits for it', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Delete tag "work"' }));

    expect(screen.getByText(/Remove/)).toBeInTheDocument();
    expect(screen.getByText(/2 chats/)).toBeInTheDocument();
    expect(deleteTag).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'DELETE' }));
    await waitFor(() => expect(deleteTag).toHaveBeenCalledWith({ tag: 'work' }));
  });

  it('drops the delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Delete tag "work"' }));
    await user.click(screen.getByRole('button', { name: 'CANCEL' }));

    expect(deleteTag).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Delete tag "work"' })).toBeInTheDocument();
  });

  it('clears a rail filtered on a tag that just stopped existing', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ tagFilter: 'work' });
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Delete tag "work"' }));
    await user.click(screen.getByRole('button', { name: 'DELETE' }));

    await waitFor(() => expect(useAppStore.getState().tagFilter).toBeNull());
  });

  it('leaves a rail filtered on some other tag alone', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ tagFilter: 'clients' });
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Delete tag "work"' }));
    await user.click(screen.getByRole('button', { name: 'DELETE' }));

    await waitFor(() => expect(deleteTag).toHaveBeenCalled());
    expect(useAppStore.getState().tagFilter).toBe('clients');
  });

  it('opens at most one row, so no Save is ambiguous', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));
    expect(screen.getByLabelText('New name for tag "work"')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete tag "clients"' }));
    expect(screen.queryByLabelText('New name for tag "work"')).not.toBeInTheDocument();
  });

  it('surfaces a failed rename instead of pretending it landed', async () => {
    const user = userEvent.setup();
    renameTag.mockRejectedValue(new Error('tags.json is read-only'));
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));

    const input = screen.getByLabelText('New name for tag "work"');
    await user.clear(input);
    await user.type(input, 'projects');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(await screen.findByText('tags.json is read-only')).toBeInTheDocument();
  });

  it('closes the open row on Escape without closing the whole dialog', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('button', { name: 'Rename tag "work"' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('New name for tag "work"')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(useAppStore.getState().activeModal).toBe('tag-manager');
  });
});
