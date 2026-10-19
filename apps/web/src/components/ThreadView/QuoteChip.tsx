import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, ApiClientError } from '../../api/client.ts';
import { ensureAwake } from '../../hooks/useSleepMode.ts';
import { messagePreviewText } from '../../lib/messagePreview.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import type { UnifiedMessage } from '../../types.ts';

interface QuoteChipProps {
  /** The id the reply quotes. */
  quotedMsgId: string;
  /** The quoted message when the thread has it loaded; null otherwise. */
  quoted: UnifiedMessage | null;
  /** The quote as the reply itself carries it, for when it is not loaded. */
  quotedText: string | null;
  /** The chat to look the quoted message up in. */
  chatJid: string;
  onJump: (msgId: string, at: string) => void;
}

/** Where a lookup for an unloaded quote got to. */
type Lookup = 'idle' | 'looking' | 'missing' | 'failed';

function quotedSender(msg: UnifiedMessage): string {
  if (msg.fromMe) return 'You';
  return msg.senderName || msg.senderJid.split('@')[0] || 'Unknown';
}

/**
 * What a reply is replying to, above its body, and the way back to it.
 *
 * A quote the thread has loaded is named and previewed from the loaded copy.
 * One it has not is shown from the text the reply carries, and is looked up
 * only when clicked: looking every one up as the thread renders would spawn a
 * wacli read per reply, and many quotes point past anything sync ever pulled. Clicked, it is looked up once — found, the
 * thread opens around it the way a search hit does; not stored, the chip says
 * so rather than sending the operator off to page through history for it.
 */
export function QuoteChip({ quotedMsgId, quoted, quotedText, chatJid, onJump }: QuoteChipProps) {
  const queryClient = useQueryClient();
  const [lookup, setLookup] = useState<Lookup>('idle');

  const handleClick = async () => {
    if (quoted) {
      onJump(quoted.msgId, quoted.ts);
      return;
    }
    if (lookup === 'looking' || lookup === 'missing') return;

    setLookup('looking');
    await ensureAwake(queryClient, 'jump to quoted message');
    try {
      const found = await api.getMessage({ chat: chatJid, id: quotedMsgId });
      setLookup('idle');
      onJump(found.msgId, found.ts);
    } catch (err) {
      setLookup(err instanceof ApiClientError && err.status === 404 ? 'missing' : 'failed');
    }
  };

  const preview = quoted ? messagePreviewText(quoted) : (quotedText ?? '');
  const heading = quoted
    ? quotedSender(quoted)
    : lookup === 'missing'
      ? 'Not in the local archive'
      : lookup === 'failed'
        ? 'Could not look it up — click to try again'
        : 'Earlier message';

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={lookup === 'missing'}
      className="mb-1.5 w-full min-w-0 text-start rounded bg-mc-bg/60 border-l-2 border-mc-live px-2 py-1 font-mono text-[11px] hover:bg-mc-surfaceHover transition-colors disabled:cursor-default disabled:hover:bg-mc-bg/60"
      title={quoted || lookup === 'idle' ? 'Jump to the quoted message' : heading}
    >
      <span
        className={`flex items-center gap-1.5 truncate ${
          quoted ? 'text-mc-live font-semibold' : 'italic text-mc-textMuted'
        }`}
      >
        {lookup === 'looking' && <Loader2 size={11} className="animate-spin shrink-0" />}
        <span className="truncate">{heading}</span>
      </span>
      {preview && (
        <span dir={detectTextDirection(preview)} className="block text-mc-textMuted truncate">
          {preview}
        </span>
      )}
    </button>
  );
}
