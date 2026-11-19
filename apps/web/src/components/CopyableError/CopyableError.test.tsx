import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyableError } from './CopyableError.tsx';

describe('CopyableError', () => {
  it('copies the message exactly as shown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const message = 'sync failed: store is locked by pid 1234';

    render(<CopyableError message={message} />);
    expect(screen.getByText(message)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Copy error message' }));
    expect(writeText).toHaveBeenCalledWith(message);
    expect(await screen.findByRole('button', { name: 'Error message copied' })).toBeTruthy();
  });

  it('selects the message for a manual copy when the clipboard is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const message = "failed to get key 00000000A1B2: didn't find app state key";

    render(<CopyableError message={message} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy error message' }));

    expect(String(window.getSelection())).toBe(message);
  });
});
