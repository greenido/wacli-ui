import React from 'react';
import { ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';

/**
 * The confirmation behind the mode shortcut. Safe read-only mode is the one
 * guardrail standing between a keystroke and a message leaving this machine, so
 * the chord opens this rather than flipping the switch under the operator.
 */
export const ModeConfirmModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const queryClient = useQueryClient();

  const dialogRef = useModalDialog<HTMLDivElement>(activeModal === 'mode-confirm', () =>
    setActiveModal(null)
  );

  const { data: modeData } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
  });

  const modeMutation = useMutation({
    mutationFn: (newReadOnly: boolean) => {
      localStorage.setItem('wacli_safe_mode', String(newReadOnly));
      return api.setMode(newReadOnly);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setActiveModal(null);
    },
  });

  if (activeModal !== 'mode-confirm') return null;

  const isReadOnly = modeData?.readOnly ?? true;
  const goingLive = isReadOnly;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mode-confirm-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-md flex flex-col font-sans"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2
            id="mode-confirm-title"
            className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-text"
          >
            {goingLive ? (
              <ShieldAlert size={16} className="text-mc-live" />
            ) : (
              <ShieldCheck size={16} className="text-mc-safe" />
            )}
            <span>{goingLive ? 'UNLOCK LIVE SENDS?' : 'LOCK TO SAFE MODE?'}</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-[12px] leading-relaxed text-mc-textMuted">
          <p>
            {goingLive
              ? 'Outgoing messages, replies, reactions and history backfills become possible. Every send still passes its own confirmation step before anything leaves this machine.'
              : 'Outgoing messages, replies, reactions and history backfills are refused. Anything already scheduled will fail loudly when it comes due rather than going out.'}
          </p>
          <p className="font-mono text-[11px]">
            <span className="text-mc-textMuted">Mode: </span>
            <span className={isReadOnly ? 'text-mc-safe' : 'text-mc-live'}>
              {isReadOnly ? 'SAFE (R/O)' : 'LIVE'}
            </span>
            <span className="text-mc-textMuted"> → </span>
            <span className={goingLive ? 'text-mc-live' : 'text-mc-safe'}>
              {goingLive ? 'LIVE' : 'SAFE (R/O)'}
            </span>
          </p>
          {modeMutation.isError && (
            <p className="text-mc-danger font-mono text-[11px]">
              {(modeMutation.error as Error).message}
            </p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-mc-border flex items-center justify-end gap-2">
          <button
            onClick={() => setActiveModal(null)}
            className="px-3 py-1.5 rounded text-xs font-mono text-mc-textMuted border border-mc-border hover:text-mc-text hover:bg-mc-surfaceHover transition-colors"
          >
            CANCEL
          </button>
          <button
            data-autofocus
            onClick={() => modeMutation.mutate(!isReadOnly)}
            disabled={modeMutation.isPending}
            className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all disabled:opacity-50 ${
              goingLive
                ? 'bg-mc-live/20 text-mc-live border border-mc-live/60 hover:bg-mc-live/30'
                : 'bg-mc-safe/20 text-mc-safe border border-mc-safe/60 hover:bg-mc-safe/30'
            }`}
          >
            {modeMutation.isPending
              ? 'SWITCHING...'
              : goingLive
              ? 'UNLOCK LIVE SENDS'
              : 'LOCK (SAFE MODE)'}
          </button>
        </div>
      </div>
    </div>
  );
};
