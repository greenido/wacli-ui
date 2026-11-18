import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { ScheduledMessage } from '../../types.ts';

/**
 * What the LATER tab can do to a queued message, and the state around it.
 *
 * Held by the strip rather than the tab, so an open failure detail or a refusal
 * still on screen survives a look at another tab.
 */
export function useScheduledActions() {
  const queryClient = useQueryClient();

  // A failed message has nothing to show in the thread, so its detail has to
  // open here instead of sending the operator to a conversation that is missing
  // the very message they clicked.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<ScheduledMessage | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  /**
   * Why a cancel or discard did not happen. These are refusals about state the
   * operator cannot see — the message went out a second ago, another pane got
   * there first — so they belong on screen rather than in a console log.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
    onError: (err: unknown) => {
      // The server refuses a cancel it cannot honour — the message already went
      // out, or was cancelled a moment ago in another pane. It used to answer
      // those as successes, so the row simply stopped responding; now the
      // reason is on screen, next to the same list the resend refusals use.
      setActionError(err instanceof Error ? err.message : String(err));
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  const resend = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt?: string }) =>
      api.resendScheduled(id, scheduledAt ? { scheduledAt } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
      setResendTarget(null);
      setResendError(null);
    },
    onError: (err: unknown) => {
      // Includes the server's own refusals (already sent, already in flight,
      // safe mode), which the operator needs to read rather than have swallowed.
      setResendError(err instanceof Error ? err.message : String(err));
    },
  });

  const discard = useMutation({
    mutationFn: (id: string) => api.discardScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err));
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  return {
    expandedId,
    setExpandedId,
    actionError,
    clearActionError: () => setActionError(null),
    cancel,
    discard,
    resend,
    resendTarget,
    resendError,
    openResend: (item: ScheduledMessage) => {
      setResendError(null);
      setResendTarget(item);
    },
    closeResend: () => {
      setResendTarget(null);
      setResendError(null);
    },
  };
}

export type ScheduledActions = ReturnType<typeof useScheduledActions>;
