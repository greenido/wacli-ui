import type { UnifiedMessage } from '../types.ts';

/**
 * One-line preview of a message, for the chat rail.
 *
 * Twin of `messagePreviewText` in `apps/api/src/wacli/normalize.ts`: the server
 * folds previews for the chat list, and this folds the same message when it
 * arrives over the WebSocket, so the rail updates without another 300 KB scan.
 * Keep the two in step — a drift shows up as a preview that changes shape the
 * next time `/api/chats` is polled.
 */
export function messagePreviewText(msg: UnifiedMessage): string {
  if (msg.revoked) return 'This message was deleted.';

  const caption = (msg.mediaCaption || '').trim();
  const body = (msg.displayText || msg.text || '').trim();

  switch (msg.mediaType) {
    case 'image':
      return caption ? `\u{1F4F7} ${caption}` : '\u{1F4F7} Photo';
    case 'video':
      return caption ? `\u{1F3A5} ${caption}` : '\u{1F3A5} Video';
    case 'audio':
      return '\u{1F3A4} Voice message';
    case 'sticker':
      return 'Sticker';
    case 'document':
      return `\u{1F4C4} ${msg.filename || caption || 'Document'}`;
    default:
      break;
  }

  return body || caption || '';
}
