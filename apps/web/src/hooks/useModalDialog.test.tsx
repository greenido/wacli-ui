import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModalDialog } from './useModalDialog.ts';

function Dialog({
  onClose,
  isOpen = true,
  autoFocusLast = false,
  onLastClick,
}: {
  onClose: () => void;
  isOpen?: boolean;
  autoFocusLast?: boolean;
  onLastClick?: () => void;
}) {
  const ref = useModalDialog<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button>first</button>
      <button>second</button>
      <button data-autofocus={autoFocusLast ? '' : undefined} onClick={onLastClick}>
        last
      </button>
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

  it('focuses the control marked data-autofocus instead of the first one', () => {
    render(<Dialog onClose={vi.fn()} autoFocusLast />);
    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('ignores the auto-repeat of a held Enter, which would fire the focused control', async () => {
    const user = userEvent.setup();
    const onLastClick = vi.fn();
    render(<Dialog onClose={vi.fn()} autoFocusLast onLastClick={onLastClick} />);
    const focused = screen.getByRole('button', { name: 'last' });

    // The key that opened the dialog is still held: its repeats arrive here, on
    // a control the user has not seen yet. Cancelling the event is what stops
    // the browser activating the button.
    const repeat = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    focused.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(onLastClick).not.toHaveBeenCalled();

    // A deliberate press still activates it.
    await user.keyboard('{Enter}');
    expect(onLastClick).toHaveBeenCalledTimes(1);
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
