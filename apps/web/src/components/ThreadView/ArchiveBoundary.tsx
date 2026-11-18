import React from 'react';
import { CloudDownload, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';

/** How many older messages one "ask the phone" request tries to pull back. */
const BACKFILL_BATCH = 200;

interface ArchiveBoundaryProps {
  chatJid: string;
  /** The date the local archive for this chat starts, already formatted. */
  archiveStart: string | null;
  readOnly: boolean;
}

/**
 * The top of the thread once the local archive has run out. wacli can ask the
 * primary device for more, which is the only way past this wall.
 */
export const ArchiveBoundary: React.FC<ArchiveBoundaryProps> = ({ chatJid, archiveStart, readOnly }) => {
  const queryClient = useQueryClient();
  const backfillMutation = useMutation({
    mutationFn: (chat: string) => api.backfillHistory({ chat, count: BACKFILL_BATCH }),
    onSuccess: (_result, chat) => {
      queryClient.invalidateQueries({ queryKey: ['messages', chat] });
      queryClient.invalidateQueries({ queryKey: ['coverage', chat] });
    },
  });

  return (
    <div className="flex flex-col items-center gap-1.5 pb-2">
      <span className="text-[10px] font-mono text-mc-textMuted text-center">
        {archiveStart
          ? `Local archive for this chat starts ${archiveStart}.`
          : 'Start of the local archive for this chat.'}
      </span>
      <button
        onClick={() => backfillMutation.mutate(chatJid)}
        disabled={backfillMutation.isPending || readOnly}
        className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          readOnly
            ? 'Safe read-only mode is active: a backfill writes the local store, so it is disabled.'
            : 'Ask your phone for older messages in this chat and add them to the local archive'
        }
      >
        {backfillMutation.isPending ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            <span>ASKING YOUR PHONE...</span>
          </>
        ) : (
          <>
            <CloudDownload size={12} />
            <span>REQUEST OLDER FROM PHONE</span>
          </>
        )}
      </button>
      {backfillMutation.isError && (
        <span className="text-[10px] font-mono text-mc-danger text-center max-w-sm">
          {(backfillMutation.error as Error).message}
        </span>
      )}
      {backfillMutation.isSuccess && !backfillMutation.isPending && (
        <span className="text-[10px] font-mono text-mc-textMuted text-center max-w-sm">
          Request sent. Your phone answers on its own schedule — anything it returns appears here.
        </span>
      )}
    </div>
  );
};
