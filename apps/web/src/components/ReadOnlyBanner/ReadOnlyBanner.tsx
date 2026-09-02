import React, { useState, useEffect } from 'react';
import { ShieldAlert, Unlock, Lock, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { POLL_MODE_MS } from '../../lib/queryOptions.ts';

const STORAGE_KEY = 'wacli_safe_mode';

export const ReadOnlyBanner: React.FC = () => {
  const queryClient = useQueryClient();

  const { data: modeData } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
    refetchInterval: POLL_MODE_MS,
  });

  React.useEffect(() => {
    if (modeData && typeof modeData.readOnly === 'boolean') {
      localStorage.setItem(STORAGE_KEY, String(modeData.readOnly));
    }
  }, [modeData]);

  const mutation = useMutation({
    mutationFn: (newReadOnly: boolean) => {
      localStorage.setItem(STORAGE_KEY, String(newReadOnly));
      return api.setMode(newReadOnly);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const isReadOnly = modeData?.readOnly ?? (localStorage.getItem(STORAGE_KEY) !== null ? localStorage.getItem(STORAGE_KEY) === 'true' : false);

  const [prevMode, setPrevMode] = useState(isReadOnly);
  const [isDismissed, setIsDismissed] = useState(false);

  // When mode changes, reset dismissed state during render
  if (prevMode !== isReadOnly) {
    setPrevMode(isReadOnly);
    setIsDismissed(false);
  }

  // Auto-hide the top status line after 5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsDismissed(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [isReadOnly]);

  if (isDismissed) {
    return null;
  }

  if (!isReadOnly) {
    return (
      <header className="h-7 bg-mc-surface border-b border-mc-border flex items-center justify-between px-3 text-xs font-mono text-mc-live select-none">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-mc-live animate-pulse" />
          <span>LIVE OPERATOR MODE (MUTATIONS ENABLED)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => mutation.mutate(true)}
            className="flex items-center gap-1 text-mc-textMuted hover:text-mc-safe transition-colors px-1.5 py-0.5 rounded border border-mc-border hover:border-mc-safe text-[11px]"
            title="Engage safe read-only lock"
          >
            <Lock size={12} />
            <span>ENGAGE SAFE MODE</span>
          </button>
          <button
            onClick={() => setIsDismissed(true)}
            className="p-0.5 text-mc-textMuted hover:text-mc-text rounded transition-colors"
            title="Dismiss status banner"
          >
            <X size={12} />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="h-8 bg-[#E8B96A]/10 border-b border-[#E8B96A]/40 flex items-center justify-between px-3 text-xs font-mono text-mc-safe select-none">
      <div className="flex items-center gap-2">
        <ShieldAlert size={15} className="text-mc-safe shrink-0" />
        <span className="font-semibold">SAFE READ-ONLY MODE ACTIVE:</span>
        <span className="text-mc-text hidden sm:inline">Sending, replying, and mutating operations are locked.</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => mutation.mutate(false)}
          disabled={mutation.isPending}
          className="flex items-center gap-1.5 bg-[#E8B96A]/20 hover:bg-[#E8B96A]/30 text-mc-safe border border-mc-safe/50 hover:border-mc-safe px-2 py-0.5 rounded text-[11px] font-semibold transition-all"
          title="Switch to live mode to allow outgoing messages"
        >
          <Unlock size={12} />
          <span>UNLOCK LIVE SENDS</span>
        </button>
        <button
          onClick={() => setIsDismissed(true)}
          className="p-0.5 text-mc-safe/70 hover:text-mc-safe rounded transition-colors"
          title="Dismiss status banner"
        >
          <X size={13} />
        </button>
      </div>
    </header>
  );
};
