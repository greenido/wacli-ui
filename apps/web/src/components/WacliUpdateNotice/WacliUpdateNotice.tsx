import React, { useState } from 'react';
import { ArrowUpCircle, Check, Copy, ExternalLink, X } from 'lucide-react';
import { useHealth } from '../../hooks/useHealth.ts';

const DISMISSED_KEY = 'wacli_update_dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * Says so when a newer wacli is out, with the command that takes it. It never
 * upgrades anything itself: a release can regress what the console relies on,
 * so when to take one is the operator's call.
 *
 * Dismissing it hides that release only. The next one is news again.
 */
export const WacliUpdateNotice: React.FC = () => {
  const { data: health } = useHealth();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [copied, setCopied] = useState(false);

  const update = health?.wacliUpdate;
  if (!update || dismissed === update.latestVersion) return null;

  // `wacli 0.19.0` as the binary prints it; the name is already in the sentence.
  const installed = health?.wacliVersion?.replace(/^wacli\s+/, '');

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, update.latestVersion);
    } catch {
      // Hidden for this session regardless.
    }
    setDismissed(update.latestVersion);
  };

  const handleCopy = (command: string) => {
    navigator.clipboard.writeText(command).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="status"
      aria-label="wacli update available"
      className="bg-mc-surface border-b border-mc-border px-4 py-1.5 text-[11px] font-mono flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2 min-w-0 text-mc-text">
        <ArrowUpCircle size={14} className="shrink-0 text-mc-live" />
        <span className="truncate">
          wacli {update.latestVersion} is available{installed ? ` (you have ${installed})` : ''}.{' '}
          {update.upgradeCommand ? (
            <>
              Run <code className="text-mc-live select-all">{update.upgradeCommand}</code>, then restart
              Mission Control.
            </>
          ) : (
            'Install it, then restart Mission Control.'
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {update.upgradeCommand && (
          <button
            onClick={() => handleCopy(update.upgradeCommand!)}
            className="text-mc-live hover:underline flex items-center gap-1"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
        <a
          href={update.releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="text-mc-textMuted hover:text-mc-text flex items-center gap-1"
        >
          <ExternalLink size={11} />
          <span>Release notes</span>
        </a>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss wacli update notice"
          className="p-0.5 rounded text-mc-textMuted hover:text-mc-text hover:bg-mc-bg"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
};
