import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { foldReactions, type PendingReaction } from '../../lib/reactionFold.ts';
import type { UnifiedMessage } from '../../types.ts';

/** Stable empty map, so switching chats does not churn the fold's dependencies. */
const NO_PENDING_REACTIONS: Record<string, PendingReaction> = {};

/**
 * The thread's messages with reactions folded onto them, and reacting from here.
 *
 * A reaction sent from here shows at once and is held on screen until the
 * archive catches up. Sending one costs a wacli spawn, the store lock, the send
 * itself and a post-send wait, and the row only reaches the thread on the poll
 * after that, which is why a click used to sit there doing nothing for most of
 * a minute.
 */
export function useThreadReactions(chatJid: string | null, loadedMessages: UnifiedMessage[]) {
  const queryClient = useQueryClient();

  // Keyed by the message reacted to — all one reaction of ours can be. Which
  // chat it was decided for is part of the state, the same way the history
  // window is: reading it back through the current selection is what scopes it
  // to one conversation without an effect to keep the two in step.
  const [reactionState, setReactionState] = useState<{
    jid: string | null;
    pending: Record<string, PendingReaction>;
    error: string | null;
  }>({ jid: null, pending: NO_PENDING_REACTIONS, error: null });

  const reactionsAreForThisChat = reactionState.jid === chatJid;
  const pendingReactions = reactionsAreForThisChat ? reactionState.pending : NO_PENDING_REACTIONS;
  const reactionError = reactionsAreForThisChat ? reactionState.error : null;

  const dismissReactionError = () =>
    setReactionState((prev) => (prev.error ? { ...prev, error: null } : prev));

  const { messages, reactionsMap, myArchivedReactions } = useMemo(
    () => foldReactions(loadedMessages, pendingReactions),
    [loadedMessages, pendingReactions]
  );

  const reactMutation = useMutation({
    mutationFn: ({ msg, emoji, chat }: { msg: UnifiedMessage; emoji: string; chat: string }) =>
      api.sendReact({
        to: chat,
        id: msg.msgId,
        reaction: emoji,
        sender: msg.senderJid || undefined,
        confirm: true,
      }),
    onError: (err, { msg }) => {
      // Showing the emoji before the send lands is only honest if a refusal
      // takes it away again and says why.
      setReactionState((prev) => {
        const { [msg.msgId]: _rolledBack, ...rest } = prev.pending;
        return {
          ...prev,
          pending: rest,
          error: err instanceof Error ? err.message : 'The reaction did not go out.',
        };
      });
    },
    onSuccess: (_data, { msg, chat }) => {
      // Ask for the archive's own row now rather than waiting out the poll, so
      // the optimistic emoji is a stand-in for a second or two, not half a minute.
      void queryClient.invalidateQueries({
        queryKey: ['messages', msg.chatJid || chat],
      });
    },
  });

  const react = (msg: UnifiedMessage, emoji: string) => {
    if (!chatJid) return;
    setReactionState({
      jid: chatJid,
      // What the archive says right now is the mark this stand-in watches for.
      pending: {
        ...pendingReactions,
        [msg.msgId]: { emoji, was: myArchivedReactions.get(msg.msgId) ?? '' },
      },
      error: null,
    });
    reactMutation.mutate({ msg, emoji, chat: chatJid });
  };

  // Everything a row is handed stays the same object while its message does,
  // which is what lets MessageRow skip the redraw. `react` closes over state
  // that changes with every message, so rows reach it through a ref.
  const reactRef = useRef(react);
  useEffect(() => {
    reactRef.current = react;
  });
  const onReact = useCallback(
    (msg: UnifiedMessage, emoji: string) => reactRef.current(msg, emoji),
    []
  );

  return { messages, reactionsMap, reactionError, dismissReactionError, onReact };
}
