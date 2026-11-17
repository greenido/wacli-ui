import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer.tsx';
import { TemplateManagerModal } from '../TemplateManagerModal/TemplateManagerModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { QuickReplyTemplate, UnifiedChat } from '../../types.ts';

const api = vi.hoisted(() => ({
  getMode: vi.fn(),
  setMode: vi.fn(),
  getTemplates: vi.fn(),
  markTemplateUsed: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
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
    api.getTemplates.mockResolvedValue([]);
    api.markTemplateUsed.mockResolvedValue({ id: 'x' });
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

  describe('quick replies', () => {
    const template = (id: string, name: string, body: string): QuickReplyTemplate => ({
      id,
      name,
      body,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      lastUsedAt: null,
    });
    const LATE = template('t-late', 'Running late', 'Ten minutes behind, sorry.');
    const THANKS = template('t-thanks', 'Thanks', 'Thank you!');
    const LATER = template('t-later', 'Later', 'Talk later.');

    beforeEach(() => {
      api.getTemplates.mockResolvedValue([THANKS, LATE, LATER]);
      useAppStore.setState({ activeModal: null, sendConfirmData: null });
    });

    /** Types into the composer the way a change event delivers it. */
    function type(box: HTMLElement, value: string) {
      fireEvent.change(box, { target: { value } });
    }

    async function openWith(value: string) {
      const box = renderComposer();
      act(() => box.focus());
      type(box, value);
      // The footer is there whether or not anything matched; the list is
      // there once the templates have loaded.
      await screen.findByText(/Enter insert/);
      await waitFor(() => expect(screen.queryByText(/Loading templates/)).toBeNull());
      return box;
    }

    it('opens on a leading slash and replaces the search with the template', async () => {
      const box = await openWith('/');

      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        'ThanksThank you!',
        'Running lateTen minutes behind, sorry.',
        'LaterTalk later.',
      ]);

      fireEvent.keyDown(box, { key: 'Enter' });

      expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe('Thank you!');
      expect(screen.queryByRole('listbox')).toBeNull();
      // Picking fills the composer; nothing is staged to send.
      expect(useAppStore.getState().activeModal).toBeNull();
      expect(api.markTemplateUsed).toHaveBeenCalledWith('t-thanks');
    });

    it('narrows as you type and moves with the arrow keys', async () => {
      const box = await openWith('/lat');

      expect(screen.getAllByRole('option')).toHaveLength(2);
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
      expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);

      fireEvent.keyDown(box, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(box, { key: 'Tab' });

      // "Later" starts with the search, so it ranks above "Running late".
      expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe(LATE.body);
    });

    it('closes on Esc and then sends the slash as typed', async () => {
      const box = await openWith('/shrug');
      expect(screen.getByText(/No template matches/)).toBeInTheDocument();

      fireEvent.keyDown(box, { key: 'Escape' });
      expect(screen.queryByText(/No template matches/)).toBeNull();

      fireEvent.keyDown(box, { key: 'Enter' });
      expect(useAppStore.getState().activeModal).toBe('send-confirm');
      expect(useAppStore.getState().sendConfirmData?.messageText).toBe('/shrug');
    });

    it('sends what was typed when no template matches', async () => {
      const box = await openWith('/zzz');

      fireEvent.keyDown(box, { key: 'Enter' });
      expect(useAppStore.getState().sendConfirmData?.messageText).toBe('/zzz');
    });

    it('inserts at the caret when opened from the button', async () => {
      const box = renderComposer() as HTMLTextAreaElement;
      act(() => box.focus());
      type(box, 'Hi  there');
      box.setSelectionRange(3, 3);

      fireEvent.click(screen.getByTitle(/Quick replies/));
      await screen.findByRole('listbox', { name: 'Quick replies' });
      fireEvent.click(screen.getByRole('option', { name: /Thanks/ }));

      expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe('Hi Thank you! there');
    });

    it('opens again once the manager closes and hands focus back', async () => {
      // The dialog returns focus from a layout-effect cleanup, which React runs
      // with its event system off; onFocus never saw it, and the picker stayed
      // hidden, so Enter sent the search text instead of inserting a template.
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <Composer />
          <TemplateManagerModal />
        </QueryClientProvider>
      );
      const box = screen.getByRole('textbox');
      act(() => box.focus());
      type(box, '/');
      await screen.findByRole('listbox', { name: 'Quick replies' });

      fireEvent.click(screen.getByRole('button', { name: 'MANAGE' }));
      await screen.findByRole('dialog');
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(box).toHaveFocus();

      type(box, '/tha');
      await screen.findByRole('listbox', { name: 'Quick replies' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe(THANKS.body);
      expect(useAppStore.getState().activeModal).toBeNull();
    });

    it('opens the manager from the picker', async () => {
      await openWith('/');

      fireEvent.click(screen.getByRole('button', { name: 'MANAGE' }));
      expect(useAppStore.getState().activeModal).toBe('templates');
    });
  });
});
