import React from 'react';
import { AlertOctagon, AlertTriangle, Terminal } from 'lucide-react';
import type { MissionControlStatus } from '../../types.ts';

/**
 * The thread pane with no chat open: what to install or pair first, when
 * that is what stands in the way, or else a prompt to pick a chat.
 */
export const ThreadEmptyState: React.FC<{ health: MissionControlStatus | undefined }> = ({ health }) => {
  if (health?.wacliInstalled === false) {
    return (
      <section
        aria-label="Conversation Thread"
        className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
      >
        <div className="text-center space-y-4 max-w-md">
          <div className="w-12 h-12 rounded-full bg-mc-danger/10 border border-mc-danger/40 text-mc-danger flex items-center justify-center mx-auto">
            <AlertOctagon size={24} />
          </div>
          <div className="space-y-1">
            <div className="font-mono text-xs tracking-widest uppercase text-mc-danger font-bold">
              wacli CLI Not Installed
            </div>
            <div className="text-sm font-semibold text-mc-text">
              Command-line tool required
            </div>
            <p className="text-xs text-mc-textMuted font-sans">
              Mission Control connects to WhatsApp through the <code className="text-mc-danger font-mono font-semibold">wacli</code> CLI. Please install it on your system to view and manage messages.
            </p>
          </div>
          <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
            <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
              <Terminal size={12} /> Install command:
            </div>
            <code className="text-mc-accent text-xs block select-all">
              brew install openclaw/tap/wacli
            </code>
          </div>
        </div>
      </section>
    );
  }

  if (health?.statusSummary === 'not_authenticated' || (health?.doctor && !health.doctor.authenticated)) {
    return (
      <section
        aria-label="Conversation Thread"
        className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
      >
        <div className="text-center space-y-4 max-w-md">
          <div className="w-12 h-12 rounded-full bg-mc-safe/10 border border-mc-safe/40 text-mc-safe flex items-center justify-center mx-auto">
            <AlertTriangle size={24} />
          </div>
          <div className="space-y-1">
            <div className="font-mono text-xs tracking-widest uppercase text-mc-safe font-bold">
              WhatsApp Account Not Paired
            </div>
            <div className="text-sm font-semibold text-mc-text">
              Pair your device to get started
            </div>
            <p className="text-xs text-mc-textMuted font-sans">
              Run the authentication command in your terminal and scan the QR code with WhatsApp on your phone:
            </p>
          </div>
          <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
            <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
              <Terminal size={12} /> Terminal command:
            </div>
            <code className="text-mc-accent text-xs block select-all">
              wacli auth
            </code>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Conversation Thread"
      className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-textMuted select-none"
    >
      <div className="text-center space-y-2">
        <div className="font-mono text-xs tracking-widest uppercase">wacli Mission Control</div>
        <div className="text-sm">Select a chat from the rail to view messages.</div>
      </div>
    </section>
  );
};
