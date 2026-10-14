import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpModal } from './HelpModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import { SHORTCUT_SECTIONS } from '../../lib/shortcuts.ts';

describe('HelpModal', () => {
  beforeEach(() => {
    useAppStore.setState({ activeModal: 'help' });
  });

  it('stays out of the way until it is asked for', () => {
    useAppStore.setState({ activeModal: null });
    render(<HelpModal />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the written guide rather than the key table', () => {
    render(<HelpModal />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/local operator console/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: /USING MISSION CONTROL/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('lists every catalogued shortcut on the keyboard tab', async () => {
    const user = userEvent.setup();
    render(<HelpModal />);

    await user.click(screen.getByRole('tab', { name: /KEYBOARD/ }));

    const dialog = screen.getByRole('dialog');
    for (const section of SHORTCUT_SECTIONS) {
      expect(within(dialog).getByText(section.title)).toBeInTheDocument();
      for (const row of section.rows) {
        expect(within(dialog).getByText(row.action)).toBeInTheDocument();
      }
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<HelpModal />);

    await user.keyboard('{Escape}');

    expect(useAppStore.getState().activeModal).toBeNull();
  });

  it('closes from the header button', async () => {
    const user = userEvent.setup();
    render(<HelpModal />);

    await user.click(screen.getByRole('button', { name: /close help/i }));

    expect(useAppStore.getState().activeModal).toBeNull();
  });
});
