import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWakeOnIntent } from './useWakeOnIntent.ts';
import { ensureAwake, useSleepMode } from './useSleepMode.ts';
import { useAppStore } from '../store/appStore.ts';
import type { SleepState, UnifiedChat } from '../types.ts';

const getSleep = vi.hoisted(() => vi.fn());
const setSleep = vi.hoisted(() => vi.fn());

vi.mock('../api/client.ts', () => ({
  api: { getSleep, setSleep },
}));

const AWAKE: SleepState = { sleeping: false, since: null };
const ASLEEP: SleepState = { sleeping: true, since: '2026-09-15T22:14:00.000Z' };

function chat(jid: string, name: string): UnifiedChat {
  return {
    jid,
    kind: 'dm',
    name,
    lastMessageTs: null,
    lastMessage: null,
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
  };
}

const ADA = chat('15550100001@s.whatsapp.net', 'Ada Lovelace');
const GRACE = chat('15550100002@s.whatsapp.net', 'Grace Hopper');

let client: QueryClient;

/** Returns what the hook itself reads, so a test can wait until it has seen a state. */
function mount(searchOpen = false) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    (props: { searchOpen: boolean }) => {
      useWakeOnIntent(props);
      return useSleepMode();
    },
    { wrapper, initialProps: { searchOpen } }
  );
}

/** Mounts a page whose first answer was awake, then puts it to sleep by push. */
async function mountAsleepAfterLoad(searchOpen = false) {
  getSleep.mockResolvedValue(AWAKE);
  const view = mount(searchOpen);
  await waitFor(() => expect(view.result.current.awake).toBe(true));
  act(() => client.setQueryData(['sleep'], ASLEEP));
  await waitFor(() => expect(view.result.current.sleeping).toBe(true));
  return view;
}

/** Long enough for anything the last step set off to have run. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe('ensureAwake', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setSleep.mockReset();
    setSleep.mockResolvedValue(AWAKE);
  });

  it('does nothing while the app is awake', async () => {
    client.setQueryData(['sleep'], AWAKE);

    await ensureAwake(client, 'open chat');

    expect(setSleep).not.toHaveBeenCalled();
  });

  it('wakes a sleeping app once, however many ask at the same moment', async () => {
    client.setQueryData(['sleep'], ASLEEP);

    await Promise.all([
      ensureAwake(client, 'open chat'),
      ensureAwake(client, 'rail filter'),
      ensureAwake(client, 'load older'),
    ]);

    expect(setSleep).toHaveBeenCalledTimes(1);
    expect(setSleep).toHaveBeenCalledWith(false, 'open chat');
    expect(client.getQueryData(['sleep'])).toEqual(AWAKE);
  });

  it('settles rather than throwing when the wake is refused, so the caller can go on', async () => {
    client.setQueryData(['sleep'], ASLEEP);
    setSleep.mockRejectedValueOnce(new Error('API unreachable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureAwake(client, 'export')).resolves.toBeUndefined();

    expect(client.getQueryData(['sleep'])).toEqual(ASLEEP);
    warn.mockRestore();
  });
});

describe('useWakeOnIntent', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getSleep.mockReset();
    setSleep.mockReset();
    setSleep.mockResolvedValue(AWAKE);
    useAppStore.setState({
      selectedChat: ADA,
      chatFilter: 'all',
      searchQuery: '',
      activeModal: null,
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, activeModal: null, searchQuery: '', chatFilter: 'all' });
  });

  it('wakes a page that loads asleep, once', async () => {
    getSleep.mockResolvedValue(ASLEEP);

    const { result } = mount();

    await waitFor(() => expect(result.current.awake).toBe(true));
    await settle();
    expect(setSleep).toHaveBeenCalledTimes(1);
    expect(setSleep).toHaveBeenCalledWith(false, 'page load');
  });

  it('leaves the app asleep when sleep is pushed, or re-read on a reconnect', async () => {
    const { result } = await mountAsleepAfterLoad();
    await settle();

    // What the socket does on a reconnect: read the state again.
    getSleep.mockClear();
    getSleep.mockResolvedValue({ ...ASLEEP });
    await act(() => client.invalidateQueries({ queryKey: ['sleep'] }));
    await settle();

    expect(getSleep).toHaveBeenCalledTimes(1);
    expect(result.current.sleeping).toBe(true);
    expect(setSleep).not.toHaveBeenCalled();
  });

  it.each([
    ['open chat', () => useAppStore.setState({ selectedChat: GRACE })],
    ['rail filter', () => useAppStore.setState({ chatFilter: 'unread' })],
    ['rail search', () => useAppStore.setState({ searchQuery: 'ada' })],
    ['new chat', () => useAppStore.setState({ activeModal: 'new-chat' })],
    ['chat info', () => useAppStore.setState({ activeModal: 'chat-info' })],
  ])('wakes it for %s', async (reason, act_) => {
    const { result } = await mountAsleepAfterLoad();

    act(act_);

    await waitFor(() => expect(result.current.awake).toBe(true));
    await settle();
    expect(setSleep).toHaveBeenCalledTimes(1);
    expect(setSleep).toHaveBeenCalledWith(false, reason);
  });

  it('wakes it when search opens', async () => {
    const { result, rerender } = await mountAsleepAfterLoad();

    rerender({ searchOpen: true });

    await waitFor(() => expect(result.current.awake).toBe(true));
    expect(setSleep).toHaveBeenCalledWith(false, 'search');
  });

  it.each([
    ['Help', () => useAppStore.setState({ activeModal: 'help' })],
    ['Settings', () => useAppStore.setState({ activeModal: 'settings' })],
    ['the tag manager', () => useAppStore.setState({ activeModal: 'tag-manager' })],
    ['the safe-mode switch', () => useAppStore.setState({ activeModal: 'mode-confirm' })],
    ['the chat already open', () => useAppStore.setState({ selectedChat: { ...ADA } })],
    ['a tag filter', () => useAppStore.setState({ tagFilter: 'work' })],
  ])('leaves it asleep for %s', async (_what, act_) => {
    const { result } = await mountAsleepAfterLoad();

    act(act_);
    await settle();

    expect(result.current.sleeping).toBe(true);
    expect(setSleep).not.toHaveBeenCalled();
  });

  it('does not wake an app that is already awake', async () => {
    getSleep.mockResolvedValue(AWAKE);
    const { result } = mount();
    await waitFor(() => expect(result.current.awake).toBe(true));

    act(() => useAppStore.setState({ selectedChat: GRACE, chatFilter: 'pinned' }));
    await settle();

    expect(setSleep).not.toHaveBeenCalled();
  });
});
