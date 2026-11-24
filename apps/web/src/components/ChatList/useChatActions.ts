import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { cancelPendingRead, markChatAsRead } from '../../lib/chatRead.ts';
import { applyChatState, describeChatState, type ChatStateChange } from '../../lib/chatState.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import type { UnifiedChat } from '../../types.ts';

/** How long "Pinned Ada" stays on screen. Long enough to read, then gone. */
const DONE_NOTICE_MS = 3000;

export interface ChatActionStatus {
  /** `done` fades on its own; the other two wait to be dismissed. */
  kind: 'done' | 'error' | 'blocked';
  text: string;
}

/**
 * Pin, mute, archive, and read state, from the rail.
 *
 * These change the account on every linked device but are one click to undo,
 * so they get the reaction's treatment rather than a send's: no confirmation
 * step, the rail shows the change at once, and safe mode still has the last
 * word. A refusal puts the rail back the way the archive has it and says why.
 */
export function useChatActions() {
  const queryClient = useQueryClient();
  const { isReadOnly } = useSafeMode();
  const [status, setStatus] = useState<ChatActionStatus | null>(null);

  useEffect(() => {
    if (status?.kind !== 'done') return;
    const timer = setTimeout(() => setStatus(null), DONE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const { mutate } = useMutation({
    mutationFn: ({ chat, change }: { chat: UnifiedChat; change: ChatStateChange }) =>
      api.setChatState({ chat: chat.jid, ...change }),
    onMutate: async ({ chat, change }) => {
      // A poll already on its way back would land the old state on top of
      // the new one.
      await queryClient.cancelQueries({ queryKey: ['chats'] });
      queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) =>
        old?.map((c) => (c.jid === chat.jid ? applyChatState(c, change) : c))
      );
    },
    onSuccess: (_data, { chat, change }) => {
      setStatus({ kind: 'done', text: describeChatState(change, chat.name) });
    },
    onError: (err, { chat, change }) => {
      const reason = err instanceof Error ? err.message : 'WhatsApp did not take the change.';
      setStatus({
        kind: 'error',
        text: `Could not ${change.action.replace('-', ' ')} ${chat.name}: ${reason}`,
      });
    },
    // Settled either way: on success the archive confirms what the rail shows,
    // on failure it takes the optimistic change back.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });

  const run = useCallback(
    (chat: UnifiedChat, change: ChatStateChange) => {
      if (isReadOnly) {
        setStatus({
          kind: 'blocked',
          text: 'Safe mode is on. Unlock live sends to pin, mute, archive or mark chats.',
        });
        return;
      }
      // Opening a chat queues its read receipt a few seconds out; left alone,
      // it would quietly undo an unread mark made in that window.
      if (change.action === 'mark-unread') cancelPendingRead(chat.jid);
      mutate({ chat, change });
    },
    [isReadOnly, mutate]
  );

  /** The other half of the unread toggle, through the usual read path. */
  const markRead = useCallback(
    (chat: UnifiedChat) => {
      if (isReadOnly) {
        setStatus({
          kind: 'blocked',
          text: 'Safe mode is on. Unlock live sends to mark chats read.',
        });
        return;
      }
      markChatAsRead(queryClient, chat.jid);
      setStatus({ kind: 'done', text: `Marked ${chat.name} read` });
    },
    [isReadOnly, queryClient]
  );

  const dismiss = useCallback(() => setStatus(null), []);

  return { run, markRead, status, dismiss, isReadOnly };
}
