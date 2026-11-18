import React, { useState } from 'react';
import { AlertTriangle, Clock, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { POLL_SCHEDULED_MS } from '../../lib/queryOptions.ts';

/** The messages queued for this chat (Send Later), above the thread, each with a cancel. */
export const ScheduledBanner: React.FC<{ chatJid: string }> = ({ chatJid }) => {
  const queryClient = useQueryClient();

  // The queue answers with its pending messages already separated, so there
  // is nothing to filter here.
  const { data: scheduledForChat } = useQuery({
    queryKey: ['scheduled', chatJid],
    queryFn: () => api.getScheduled({ chat: chatJid }),
    refetchInterval: POLL_SCHEDULED_MS,
  });

  const pendingScheduled = scheduledForChat?.pending ?? [];

  // A cancel is refused once the message is already going out. The banner has
  // to say so, or the click looks like it worked while the message is sent.
  // Kept per chat, like the reaction error, so it does not follow the operator.
  const [cancelRefusal, setCancelRefusal] = useState<{ jid: string; error: string } | null>(null);

  const cancelScheduledMutation = useMutation({
    mutationFn: ({ id }: { id: string; chat: string }) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
    onError: (err, { chat }) => {
      setCancelRefusal({ jid: chat, error: err instanceof Error ? err.message : String(err) });
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  return (
    <>
      {pendingScheduled.length > 0 && (
        <div className="bg-mc-surface border-b border-mc-border/80 px-3 py-2 text-xs font-mono text-mc-text space-y-1">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-mc-live shrink-0 animate-pulse" />
            <span className="text-mc-live font-semibold">SCHEDULED ({pendingScheduled.length})</span>
          </div>
          {/* Capped and scrollable, so a long queue cannot push the thread off screen. */}
          <ul className="max-h-28 overflow-y-auto space-y-1">
            {pendingScheduled.map((item) => {
              const label = item.message || item.fileName || '';
              return (
                <li key={item.id} className="flex items-center justify-between gap-2 pl-6">
                  <span className="truncate text-mc-textMuted text-[11px]">
                    {label} (due{' '}
                    {new Date(item.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                  </span>
                  {/* Already handed to wacli: there is nothing left to cancel. */}
                  {item.status === 'sending' ? (
                    <span className="text-[10px] text-mc-live font-semibold shrink-0">SENDING NOW</span>
                  ) : (
                    <button
                      onClick={() => cancelScheduledMutation.mutate({ id: item.id, chat: item.to })}
                      className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors shrink-0"
                      title={`Cancel scheduled message: ${label}`}
                    >
                      <Trash2 size={11} />
                      <span>CANCEL</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {cancelRefusal && cancelRefusal.jid === chatJid && (
        <div
          role="alert"
          className="bg-mc-surface border-b border-mc-danger/40 px-3 py-1.5 flex items-center gap-2 text-[11px] font-mono text-mc-danger"
        >
          <AlertTriangle size={13} className="shrink-0" />
          <span className="flex-1 break-words">Not cancelled: {cancelRefusal.error}</span>
          <button
            onClick={() => setCancelRefusal(null)}
            className="shrink-0 px-1.5 py-0.5 rounded border border-mc-danger/40 hover:bg-mc-surfaceHover transition-colors"
          >
            DISMISS
          </button>
        </div>
      )}
    </>
  );
};
