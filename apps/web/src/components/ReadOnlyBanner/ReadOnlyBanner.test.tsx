import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReadOnlyBanner } from './ReadOnlyBanner.tsx';

const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getMode: getMode, setMode: setMode },
}));

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReadOnlyBanner />
    </QueryClientProvider>
  );
}

describe('ReadOnlyBanner', () => {
  beforeEach(() => {
    getMode.mockReset();
    setMode.mockReset();
    setMode.mockResolvedValue({ readOnly: false });
  });

  it('shows the safe-mode lock while read-only is active', async () => {
    getMode.mockResolvedValue({ readOnly: true });
    renderBanner();

    expect(await screen.findByText(/SAFE READ-ONLY MODE ACTIVE/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /UNLOCK LIVE SENDS/i })).toBeInTheDocument();
  });

  it('shows live operator mode once the operator has unlocked', async () => {
    getMode.mockResolvedValue({ readOnly: false });
    renderBanner();

    expect(await screen.findByText(/LIVE OPERATOR MODE/i)).toBeInTheDocument();
  });

  it('persists the unlock to the server rather than only the UI', async () => {
    const user = userEvent.setup();
    getMode.mockResolvedValue({ readOnly: true });
    renderBanner();

    await user.click(await screen.findByRole('button', { name: /UNLOCK LIVE SENDS/i }));

    await waitFor(() => expect(setMode).toHaveBeenCalledWith(false));
  });
});
