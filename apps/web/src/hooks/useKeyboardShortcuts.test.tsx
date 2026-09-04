import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.ts';
import { useAppStore } from '../store/appStore.ts';
import type { UnifiedChat } from '../types.ts';

const CHAT: UnifiedChat = {
  jid: 'alice@s.whatsapp.net',
  kind: 'dm',
  name: 'Alice',
  lastMessageTs: null,
  lastMessage: null,
  lastMessageFromMe: false,
  archived: false,
  pinned: false,
  mutedUntil: 0,
  unread: false,
  unreadCount: 0,
};

const onToggleSearch = vi.fn();

const Harness: React.FC<{ isSearchOpen?: boolean }> = ({ isSearchOpen = false }) => {
  useKeyboardShortcuts({ isSearchOpen, onToggleSearch });
  return <textarea aria-label="composer" />;
};

function renderHarness(isSearchOpen = false) {
  return render(<Harness isSearchOpen={isSearchOpen} />);
}

const composer = () => screen.getByLabelText('composer');
const command = () => useAppStore.getState().uiCommand?.name;

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    onToggleSearch.mockClear();
    useAppStore.setState({
      activeModal: null,
      chatFilter: 'all',
      selectedChat: CHAT,
      uiCommand: null,
    });
  });

  it('opens the help modal on ?', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.keyboard('?');

    expect(useAppStore.getState().activeModal).toBe('help');
  });

  it('leaves single keys alone while the operator is typing', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(composer());
    await user.keyboard('?n1');

    expect(useAppStore.getState().activeModal).toBeNull();
    expect(useAppStore.getState().chatFilter).toBe('all');
    // The keys went where they were aimed.
    expect(composer()).toHaveValue('?n1');
  });

  it('steps out of the composer on Escape, which brings single keys back', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(composer());
    expect(composer()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(composer()).not.toHaveFocus();

    await user.keyboard('n');
    expect(useAppStore.getState().activeModal).toBe('new-chat');
  });

  it('picks a rail filter with the number keys', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.keyboard('2');
    expect(useAppStore.getState().chatFilter).toBe('unread');

    await user.keyboard('5');
    expect(useAppStore.getState().chatFilter).toBe('archived');
  });

  it('toggles search on the modifier chord even while typing', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(composer());
    await user.keyboard('{Control>}k{/Control}');

    expect(onToggleSearch).toHaveBeenCalledTimes(1);
    expect(composer()).toHaveValue('');
  });

  it('asks before switching operator mode rather than flipping it', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.keyboard('{Control>}{Shift>}L{/Shift}{/Control}');

    expect(useAppStore.getState().activeModal).toBe('mode-confirm');
  });

  it('publishes thread commands only while a chat is open', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.keyboard('r');
    expect(command()).toBe('thread:reply-latest');

    useAppStore.setState({ selectedChat: null, uiCommand: null });
    await user.keyboard('o');
    expect(command()).toBeUndefined();
  });

  it('hands the keyboard to whichever dialog is up', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeModal: 'settings' });
    renderHarness();

    await user.keyboard('n1?');

    expect(useAppStore.getState().activeModal).toBe('settings');
    expect(useAppStore.getState().chatFilter).toBe('all');
  });

  it('leaves the search palette alone except for the chord that closes it', async () => {
    const user = userEvent.setup();
    renderHarness(true);

    await user.keyboard('n');
    expect(useAppStore.getState().activeModal).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
  });
});
