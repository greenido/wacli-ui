import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MediaViewer } from './MediaViewer.tsx';
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
