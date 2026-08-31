import React, { useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  RotateCw,
  Terminal,
  Settings,
  ChevronDown,
  ChevronUp,
  X,
  Copy,
  Check,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';

export const WacliStatusBanner: React.FC = () => {
  const queryClient = useQueryClient();
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const {
    data: health,
    isLoading,
    isError,
    error,
    isFetching,
  } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: 5000,
  });

  const handleRecheck = async () => {
    await queryClient.invalidateQueries({ queryKey: ['health'] });
    await queryClient.invalidateQueries({ queryKey: ['chats'] });
  };

  const handleCopy = (cmd: string) => {
    navigator.clipboard.writeText(cmd).catch(() => {});
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  // If loading for first time or dismissed, don't show
  if (isLoading || isDismissed) {
    return null;
  }

  // Backend API connection failed
  if (isError) {
    return (
      <div className="bg-mc-danger/15 border-b border-mc-danger/50 text-mc-danger px-4 py-2.5 text-xs font-mono select-none flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2 min-w-0">
          <AlertOctagon size={16} className="shrink-0 text-mc-danger animate-pulse" />
          <span className="font-bold">BACKEND UNREACHABLE:</span>
          <span className="text-mc-text truncate">
            {error instanceof Error ? error.message : 'Cannot connect to Mission Control API server.'}
          </span>
        </div>
        <button
          onClick={handleRecheck}
          disabled={isFetching}
          className="flex items-center gap-1 bg-mc-danger/20 hover:bg-mc-danger/30 text-mc-danger border border-mc-danger/50 px-2.5 py-1 rounded text-[11px] font-semibold transition-all shrink-0 ml-3"
        >
          <RotateCw size={12} className={isFetching ? 'animate-spin' : ''} />
          <span>RETRY</span>
        </button>
      </div>
    );
  }

  // If wacli is installed and working normally, no banner needed
  if (health?.wacliInstalled && health?.wacliWorking && health.statusSummary === 'ok') {
    return null;
  }

  const isNotInstalled = health?.wacliInstalled === false || health?.statusSummary === 'not_installed';
  const isNotAuth = health?.statusSummary === 'not_authenticated' || health?.doctor?.authenticated === false;

  return (
    <div
      aria-label="System diagnostic warning"
      className={`border-b text-xs font-mono select-none transition-all shadow-md ${
        isNotInstalled
          ? 'bg-[#2A1515] border-mc-danger/60 text-mc-danger'
          : 'bg-[#2A2315] border-mc-safe/60 text-mc-safe'
      }`}
    >
      <div className="px-4 py-2.5 flex items-center justify-between gap-3">
        {/* Left: Icon & Title */}
        <div className="flex items-center gap-2.5 min-w-0">
          {isNotInstalled ? (
            <AlertOctagon size={18} className="shrink-0 text-mc-danger animate-pulse" />
          ) : (
            <AlertTriangle size={18} className="shrink-0 text-mc-safe animate-pulse" />
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 min-w-0">
            <span className="font-bold tracking-wider uppercase text-sm">
              {isNotInstalled
                ? 'wacli CLI Not Installed'
                : isNotAuth
                ? 'WhatsApp Session Not Paired'
                : 'wacli CLI Issue Detected'}
            </span>
            <span className="text-[11px] text-mc-text truncate">
              {health?.statusMessage || health?.lastError || (isNotInstalled
                ? 'The wacli command-line tool was not found in your system PATH.'
                : 'wacli is installed but is not ready to communicate with WhatsApp.')}
            </span>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 px-2 py-1 rounded bg-mc-surface/80 hover:bg-mc-surface text-mc-text border border-mc-border text-[11px] transition-colors"
            title="Toggle setup instructions"
          >
            <Terminal size={12} />
            <span className="hidden sm:inline">{isExpanded ? 'Hide Guide' : 'How to Fix'}</span>
            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          <button
            onClick={handleRecheck}
            disabled={isFetching}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold border transition-all ${
              isNotInstalled
                ? 'bg-mc-danger/20 hover:bg-mc-danger/30 text-mc-danger border-mc-danger/50'
                : 'bg-mc-safe/20 hover:bg-mc-safe/30 text-mc-safe border-mc-safe/50'
            }`}
            title="Re-run health checks"
          >
            <RotateCw size={12} className={isFetching ? 'animate-spin' : ''} />
            <span>RE-CHECK</span>
          </button>

          <button
            onClick={() => setActiveModal('settings')}
            className="p-1 rounded text-mc-textMuted hover:text-mc-text hover:bg-mc-surface transition-colors"
            title="Open Settings & Diagnostics"
          >
            <Settings size={14} />
          </button>

          <button
            onClick={() => setIsDismissed(true)}
            className="p-1 rounded text-mc-textMuted hover:text-mc-text hover:bg-mc-surface transition-colors ml-1"
            title="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Expandable Setup & Fix Instructions */}
      {isExpanded && (
        <div className="px-4 py-3 bg-mc-bg/95 border-t border-mc-border text-mc-text space-y-3 font-sans">
          {isNotInstalled ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-mc-text">
                <span className="font-mono text-mc-danger font-semibold">wacli</span> is the underlying CLI required to communicate with WhatsApp. To install it, run one of the following commands in your terminal:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
                {/* Homebrew */}
                <div className="p-2.5 bg-mc-surface rounded border border-mc-border space-y-1">
                  <div className="text-[11px] text-mc-textMuted font-semibold flex items-center justify-between">
                    <span>macOS (Homebrew)</span>
                    <button
                      onClick={() => handleCopy('brew install stevemcquaid/wacli/wacli')}
                      className="text-mc-live hover:underline flex items-center gap-1 text-[10px]"
                    >
                      {copiedCmd === 'brew install stevemcquaid/wacli/wacli' ? (
                        <>
                          <Check size={10} /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={10} /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <code className="text-mc-live text-[11px] block select-all">
                    brew install stevemcquaid/wacli/wacli
                  </code>
                </div>

                {/* Go install */}
                <div className="p-2.5 bg-mc-surface rounded border border-mc-border space-y-1">
                  <div className="text-[11px] text-mc-textMuted font-semibold flex items-center justify-between">
                    <span>Go (Universal)</span>
                    <button
                      onClick={() => handleCopy('go install github.com/stevemcquaid/wacli@latest')}
                      className="text-mc-live hover:underline flex items-center gap-1 text-[10px]"
                    >
                      {copiedCmd === 'go install github.com/stevemcquaid/wacli@latest' ? (
                        <>
                          <Check size={10} /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={10} /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <code className="text-mc-live text-[11px] block select-all">
                    go install github.com/stevemcquaid/wacli@latest
                  </code>
                </div>
              </div>

              <div className="text-[11px] text-mc-textMuted font-mono pt-1">
                Once installed, click <span className="text-mc-live font-semibold">RE-CHECK</span> above to connect Mission Control.
              </div>
            </div>
          ) : isNotAuth ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-mc-text">
                <span className="font-mono text-mc-safe font-semibold">wacli</span> is installed, but your WhatsApp account is not paired.
              </p>
              <div className="p-2.5 bg-mc-surface rounded border border-mc-border space-y-1 font-mono text-xs max-w-lg">
                <div className="text-[11px] text-mc-textMuted font-semibold flex items-center justify-between">
                  <span>Pair WhatsApp Account</span>
                  <button
                    onClick={() => handleCopy('wacli auth')}
                    className="text-mc-live hover:underline flex items-center gap-1 text-[10px]"
                  >
                    {copiedCmd === 'wacli auth' ? (
                      <>
                        <Check size={10} /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={10} /> Copy
                      </>
                    )}
                  </button>
                </div>
                <code className="text-mc-live text-[11px] block select-all">wacli auth</code>
                <p className="text-[10px] text-mc-textMuted pt-1 font-sans">
                  Scan the QR code printed in your terminal with WhatsApp on your phone (Linked Devices &gt; Link a Device).
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-mc-text">
                wacli encountered an error. Check the diagnostics or restart the background sync daemon:
              </p>
              {health?.lastError && (
                <div className="p-2 bg-mc-danger/10 border border-mc-danger/30 rounded text-xs font-mono text-mc-danger">
                  {health.lastError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
