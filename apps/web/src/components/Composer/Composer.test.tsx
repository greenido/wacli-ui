import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

const api = vi.hoisted(() => ({
  getMode: vi.fn(),
  setMode: vi.fn(),
}));

vi.mock('../../api/client.ts', () => ({ api, ApiClientError: class extends Error {} }));

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

function renderComposer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Composer />
    </QueryClientProvider>
  );
  return screen.getByRole('textbox');
}

const screenshot = () => new File(['png'], 'screenshot.png', { type: 'image/png' });

/** What a paste or a drop carries, as far as the composer reads it. */
function carrying(files: File[], text = '') {
  return {
    files,
    types: files.length > 0 ? ['Files'] : ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  };
}

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Live sends, remembered and confirmed, so the composer itself renders.
    localStorage.setItem('wacli_safe_mode', 'false');
    api.getMode.mockResolvedValue({ readOnly: false });
    useAppStore.setState({ selectedChat: CHAT, composerDrafts: {}, composerFiles: {} });
  });

  afterEach(() => {
    localStorage.removeItem('wacli_safe_mode');
    useAppStore.setState({ selectedChat: null, composerDrafts: {}, composerFiles: {} });
  });

  describe('growing with the draft', () => {
    beforeEach(() => {
      // jsdom lays nothing out, so the content height is modelled: 20px a line
      // and 16px of padding.
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          return this.value.split('\n').length * 20 + 16;
        },
      });
    });

    afterEach(() => {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    });

    it('fits the draft instead of showing one line of it at a time', () => {
      const box = renderComposer();

      act(() => useAppStore.getState().setComposerDraft(CHAT.jid, 'one\ntwo\nthree'));
      expect(box.style.height).toBe('76px');

      // And shrinks back once the draft is gone.
      act(() => useAppStore.getState().setComposerDraft(CHAT.jid, ''));
      expect(box.style.height).toBe('36px');
    });
  });

  it('attaches a file pasted in', () => {
    const box = renderComposer();

    fireEvent.paste(box, { clipboardData: carrying([screenshot()]) });

    expect(useAppStore.getState().composerFiles[CHAT.jid]?.name).toBe('screenshot.png');
    expect(screen.getByText(/screenshot\.png/)).toBeInTheDocument();
  });

  it('pastes text as text, even when a picture of it comes along', () => {
    const box = renderComposer();

    // What copying cells from a spreadsheet puts on the clipboard.
    fireEvent.paste(box, { clipboardData: carrying([screenshot()], 'A1\tB1') });

    expect(useAppStore.getState().composerFiles[CHAT.jid]).toBeUndefined();
  });

  it('attaches a file dropped on it, and says where to drop while one is dragged over', () => {
    renderComposer();
    const composer = screen.getByRole('region', { name: 'Message composer' });

    fireEvent.dragOver(composer, { dataTransfer: carrying([screenshot()]) });
    expect(screen.getByText('DROP TO ATTACH')).toBeInTheDocument();

    fireEvent.drop(composer, { dataTransfer: carrying([screenshot()]) });

    expect(useAppStore.getState().composerFiles[CHAT.jid]?.name).toBe('screenshot.png');
    expect(screen.queryByText('DROP TO ATTACH')).not.toBeInTheDocument();
  });

  it('leaves text dragged over it alone', () => {
    renderComposer();
    const composer = screen.getByRole('region', { name: 'Message composer' });

    fireEvent.dragOver(composer, { dataTransfer: carrying([]) });

    expect(screen.queryByText('DROP TO ATTACH')).not.toBeInTheDocument();
  });
});
