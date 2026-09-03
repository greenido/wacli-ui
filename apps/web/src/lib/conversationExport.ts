import { messagePreviewText } from './messagePreview.ts';
import type { ConversationExport } from '../types.ts';

/** Safe on every filesystem the operator is likely to save this on. */
export function exportFileName(chatName: string, chatJid: string, extension: string): string {
  const base = (chatName || chatJid.split('@')[0] || 'conversation')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base || 'conversation'}-${stamp}.${extension}`;
}

function transcriptLine(ts: string, sender: string, body: string): string {
  const when = new Date(ts);
  const stamp = Number.isNaN(when.getTime()) ? ts : when.toISOString().replace('T', ' ').slice(0, 16);
  return `[${stamp}] ${sender}: ${body}`;
}

/**
 * A conversation as something a person can read: oldest first, one line per
 * message, media described rather than dropped. The JSON export keeps every
 * field; this keeps the conversation.
 */
export function formatTranscript(data: ConversationExport): string {
  const header = [
    `Conversation: ${data.chatName}`,
    `JID: ${data.chatJid}`,
    `Exported: ${data.exportedAt}`,
    `Messages: ${data.count}${data.truncated ? ' (truncated — the export limit was reached)' : ''}`,
    '',
  ];

  // wacli hands back newest first; a transcript reads the other way.
  const lines = [...data.messages].reverse().map((msg) => {
    const sender = msg.fromMe ? 'Me' : msg.senderName || msg.senderJid.split('@')[0] || 'Unknown';
    if (msg.reactionToId) {
      return transcriptLine(msg.ts, sender, `reacted ${msg.reactionEmoji ?? ''} to an earlier message`.trim());
    }
    return transcriptLine(msg.ts, sender, messagePreviewText(msg) || '(no content)');
  });

  return [...header, ...lines, ''].join('\n');
}

export function formatExportJson(data: ConversationExport): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Hands the file to the browser. Local app, real filesystem — no clipboard
 * fallback needed, but a failure must not take the thread down with it.
 */
export function downloadFile(fileName: string, mimeType: string, content: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
