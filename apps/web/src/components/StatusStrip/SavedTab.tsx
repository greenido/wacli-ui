import React from 'react';
import { X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import type { BookmarkEntry } from '../../types.ts';
import type { OpenMessage } from './useOpenMessage.ts';

interface SavedTabProps {
  bookmarks: BookmarkEntry[];
  isPending: boolean;
  selectedJid: string | undefined;
  openMessage: OpenMessage;
}

/** SAVED: bookmarked messages, each a jump into its thread. */
export const SavedTab: React.FC<SavedTabProps> = ({ bookmarks, isPending, selectedJid, openMessage }) => {
  const queryClient = useQueryClient();
  const unbookmarkMutation = useMutation({
    mutationFn: ({ chat, id }: { chat: string; id: string }) =>
      api.bookmarkMessage({ chat, id, bookmarked: false }),
    onSuccess: (_data, { chat }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
      void queryClient.invalidateQueries({ queryKey: ['messages', chat] });
    },
  });

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
      {bookmarks.length === 0 ? (
        <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
          {isPending ? 'Loading bookmarks…' : 'No bookmarked messages.'}
        </div>
      ) : (
        bookmarks.map((bm) => {
          const isSelected = selectedJid === bm.chatJid;
          const jumpToBookmark = () => {
            const hint = bm.text && bm.ts ? { text: bm.text, sentAfter: bm.ts } : undefined;
            openMessage(bm.chatJid, bm.chatName, bm.msgId, hint, bm.ts ?? null);
          };
          return (
            <div
              key={bm.msgId}
              role="button"
              tabIndex={0}
              onClick={jumpToBookmark}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  jumpToBookmark();
                }
              }}
              className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                isSelected
                  ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                  : 'border-mc-border/70'
              }`}
              title="Open conversation and jump to this bookmarked message"
            >
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-mc-textMuted">
                  {new Date(bm.ts || bm.createdAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                  })}{' '}
                  {new Date(bm.ts || bm.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    unbookmarkMutation.mutate({ chat: bm.chatJid, id: bm.msgId });
                  }}
                  disabled={unbookmarkMutation.isPending}
                  className="text-mc-textMuted hover:text-mc-danger transition-colors"
                  title="Remove bookmark"
                  aria-label="Remove bookmark"
                >
                  <X size={11} />
                </button>
              </div>
              <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                <span className="truncate">{bm.chatName || bm.chatJid}</span>
                <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">
                  OPEN →
                </span>
              </div>
              <div
                dir={detectTextDirection(bm.text || bm.msgId)}
                className="text-mc-textMuted truncate text-start"
              >
                {bm.senderName && <span>{bm.senderName}: </span>}
                <span>{bm.text || bm.msgId}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
