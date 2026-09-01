import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModalDialog } from './useModalDialog.ts';

function Dialog({ onClose, isOpen = true }: { onClose: () => void; isOpen?: boolean }) {
  const ref = useModalDialog<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button>first</button>
      <button>second</button>
      <button>last</button>
    </div>
  );
}

describe('useModalDialog', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog on open', () => {
    render(<Dialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    render(<Dialog onClose={vi.fn()} />);

    screen.getByRole('button', { name: 'last' }).focus();
    await user.tab();

    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = userEvent.setup();
    render(<Dialog onClose={vi.fn()} />);

    screen.getByRole('button', { name: 'first' }).focus();
    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('does not trap keys while closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} isOpen={false} />);

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to the trigger when the dialog unmounts', async () => {
    const onClose = vi.fn();
    render(<button>opener</button>);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();

    const { unmount } = render(<Dialog onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();

    unmount();

    expect(opener).toHaveFocus();
  });
});
