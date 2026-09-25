import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaViewer } from './MediaViewer.tsx';
import { api } from '../../api/client.ts';
import type { UnifiedMessage } from '../../types.ts';

const CHAT_JID = '15551234567@s.whatsapp.net';

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: CHAT_JID,
    chatName: 'Alice',
    msgId: 'wamid.STICKER1',
    senderJid: CHAT_JID,
    senderName: 'Alice',
    ts: new Date().toISOString(),
    fromMe: false,
    text: '',
    displayText: '',
    isForwarded: false,
    reactionToId: null,
    reactionEmoji: null,
    mediaType: 'sticker',
    mediaCaption: null,
    filename: null,
    mimeType: 'image/webp',
    localPath: null,
    starred: false,
    edited: false,
    revoked: false,
    ...overrides,
  } as UnifiedMessage;
}

describe('MediaViewer stickers', () => {
  it('renders a sticker as an image instead of a generic file card', () => {
    render(<MediaViewer msg={makeMessage()} chatJid={CHAT_JID} />);

    const img = screen.getByRole('img');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toContain('/api/media/content');

    // The old behaviour fell through to the document branch, which showed the
    // filename and a GET button rather than the sticker itself.
    expect(screen.queryByText(/sticker_attachment/i)).not.toBeInTheDocument();
    expect(screen.queryByText('GET')).not.toBeInTheDocument();
  });

  it('does not crop the sticker, so transparent art is not clipped', () => {
    render(<MediaViewer msg={makeMessage()} chatJid={CHAT_JID} />);

    const img = screen.getByRole('img');
    expect(img.className).toContain('object-contain');
    expect(img.className).not.toContain('object-cover');
  });

  it('offers the sticker download with a .webp extension', () => {
    render(<MediaViewer msg={makeMessage()} chatJid={CHAT_JID} />);

    const link = screen.getByTitle('Download sticker');
    expect(link).toHaveAttribute('download', 'sticker.webp');
    expect(link.getAttribute('href')).toContain('filename=sticker.webp');
  });

  it('prefers a sticker filename supplied by wacli over the fallback', () => {
    render(<MediaViewer msg={makeMessage({ filename: 'party-parrot.webp' })} chatJid={CHAT_JID} />);

    expect(screen.getByTitle('Download sticker')).toHaveAttribute(
      'download',
      'party-parrot.webp'
    );
  });

  it('still renders unknown media types as a document card', () => {
    render(<MediaViewer msg={makeMessage({ mediaType: 'document' })} chatJid={CHAT_JID} />);

    expect(screen.getByText('document_attachment')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('MediaViewer image lightbox', () => {
  const photo = () =>
    makeMessage({ msgId: 'wamid.IMG1', mediaType: 'image', mimeType: 'image/png', filename: 'sketch.png' });

  it('opens as a dialog of its own, outside the message it came from', async () => {
    const user = userEvent.setup();
    const { container } = render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);

    await user.click(screen.getByRole('img', { name: 'sketch.png' }));

    const dialog = screen.getByRole('dialog', { name: 'Image: sketch.png' });
    // Rendered inside the bubble, it shared the message row's stacking context,
    // and every later message painted over the open image.
    expect(container.contains(dialog)).toBe(false);
    expect(screen.getByRole('button', { name: 'Close image viewer' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);

    await user.click(screen.getByRole('img', { name: 'sketch.png' }));
    const dialog = screen.getByRole('dialog', { name: 'Image: sketch.png' });
    await user.keyboard('{Escape}');

    expect(dialog).not.toBeInTheDocument();
  });
});

describe('MediaViewer image thumbnails', () => {
  const photo = () =>
    makeMessage({ msgId: 'wamid.IMG1', mediaType: 'image', mimeType: 'image/png', filename: 'sketch.png' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is fetched only when scrolled near, in a box held open until it loads', () => {
    render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);

    const img = screen.getByRole('img', { name: 'sketch.png' });
    expect(img).toHaveAttribute('loading', 'lazy');
    // Collapsed to nothing before it loads, a lazy image counts as in view
    // wherever it is, and shoves the thread around when it arrives.
    expect(img.parentElement!.className).toContain('aspect-[4/3]');

    fireEvent.load(img);
    expect(img.parentElement!.className).not.toContain('aspect-[4/3]');
  });

  it('offers a retry in place of a broken image', () => {
    render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);

    fireEvent.error(screen.getByRole('img', { name: 'sketch.png' }));

    expect(screen.queryByRole('img', { name: 'sketch.png' })).not.toBeInTheDocument();
    expect(screen.getByText('Image unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeEnabled();
  });

  it('downloads it again on retry, and shows it once it is on disk', async () => {
    const user = userEvent.setup();
    const download = vi
      .spyOn(api, 'downloadMedia')
      .mockResolvedValue({ downloaded: true, localPath: '/store/media/IMG1.png' });
    render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);
    fireEvent.error(screen.getByRole('img', { name: 'sketch.png' }));

    await user.click(screen.getByRole('button', { name: /retry/i }));

    // The explicit download, which skips the server's memory of the failure.
    // Asking for the same URL again would only have replayed it.
    expect(download).toHaveBeenCalledWith({ chat: CHAT_JID, id: 'wamid.IMG1' });
    const img = await screen.findByRole('img', { name: 'sketch.png' });
    expect(new URL(img.getAttribute('src')!, 'http://mc.test').searchParams.get('path')).toBe(
      '/store/media/IMG1.png'
    );
  });

  it('says why when the retry fails too, and can be tried again', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'downloadMedia').mockRejectedValue(
      new Error('failed to download media: unexpected status code 403 Forbidden')
    );
    render(<MediaViewer msg={photo()} chatJid={CHAT_JID} />);
    fireEvent.error(screen.getByRole('img', { name: 'sketch.png' }));

    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText(/403 Forbidden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeEnabled();
  });

  it('does the same for a sticker', () => {
    render(<MediaViewer msg={makeMessage()} chatJid={CHAT_JID} />);

    fireEvent.error(screen.getByRole('img', { name: 'Sticker' }));

    expect(screen.getByText('Sticker unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
