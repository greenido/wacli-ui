import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModeConfirmModal } from './ModeConfirmModal.tsx';
import { useAppStore } from '../../store/appStore.ts';

const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({ api: { getMode, setMode } }));

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModeConfirmModal />
    </QueryClientProvider>
  );
}

/**
 * The confirmation behind the mode shortcut. Safe read-only mode is the one
 * guardrail between a keystroke and a message leaving this machine, so this
 * dialog exists to keep the chord from flipping it under the operator.
 */
describe('ModeConfirmModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getMode.mockResolvedValue({ readOnly: true });
    setMode.mockResolvedValue({ readOnly: false });
    useAppStore.setState({ activeModal: 'mode-confirm' });
  });

  afterEach(() => {
    useAppStore.setState({ activeModal: null });
  });

  it('stays out of the way until it is asked for', () => {
    useAppStore.setState({ activeModal: null });
    renderModal();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers to unlock when safe mode is on', async () => {
    renderModal();

    expect(await screen.findByText(/UNLOCK LIVE SENDS\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^UNLOCK LIVE SENDS$/ })).toBeInTheDocument();
  });

  it('offers to lock when sends are live', async () => {
    getMode.mockResolvedValue({ readOnly: false });
    renderModal();

    expect(await screen.findByText(/LOCK TO SAFE MODE\?/)).toBeInTheDocument();
  });

  /**
   * Before this dialog read its mode through the shared hook, an unknown state
   * rendered as unlocked — so the shortcut opened a dialog offering to *lock* a
   * console that was already locked.
   */
  it('assumes locked before the server has answered', () => {
    getMode.mockReturnValue(new Promise(() => {}));
    renderModal();

    expect(screen.getByText(/UNLOCK LIVE SENDS\?/)).toBeInTheDocument();
  });

  it('changes nothing until the operator confirms', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText(/UNLOCK LIVE SENDS\?/);

    await user.click(screen.getByRole('button', { name: /CANCEL/i }));

    expect(setMode).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppStore.getState().activeModal).toBeNull());
  });

  it('closes once the server has taken the change', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText(/UNLOCK LIVE SENDS\?/);

    await user.click(screen.getByRole('button', { name: /^UNLOCK LIVE SENDS$/ }));

    await waitFor(() => expect(setMode).toHaveBeenCalledWith(false));
    await waitFor(() => expect(useAppStore.getState().activeModal).toBeNull());
  });

  /**
   * Closing on a refused flip reports the change as done. The dialog used to
   * close from `onSuccess` only, but the localStorage write happened before the
   * request — so a refusal left the console believing the opposite of the
   * server.
   */
  it('stays open and says why when the server refuses', async () => {
    setMode.mockRejectedValue(new Error('Safe read-only mode is active.'));
    const user = userEvent.setup();
    renderModal();
    await screen.findByText(/UNLOCK LIVE SENDS\?/);

    await user.click(screen.getByRole('button', { name: /^UNLOCK LIVE SENDS$/ }));

    expect(await screen.findByText(/Safe read-only mode is active\./)).toBeInTheDocument();
    expect(useAppStore.getState().activeModal).toBe('mode-confirm');
  });

  it('does not record a mode the server refused', async () => {
    setMode.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderModal();
    await screen.findByText(/UNLOCK LIVE SENDS\?/);

    await user.click(screen.getByRole('button', { name: /^UNLOCK LIVE SENDS$/ }));

    await waitFor(() => expect(screen.getByText(/nope/)).toBeInTheDocument());
    expect(localStorage.getItem('wacli_safe_mode')).not.toBe('false');
  });
});
