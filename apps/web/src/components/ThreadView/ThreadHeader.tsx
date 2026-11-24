import React from 'react';
import { Info } from 'lucide-react';
import { useAppStore } from '../../store/appStore.ts';
import { ExportMenu } from './ExportMenu.tsx';
import type { ChatCoverage, UnifiedChat } from '../../types.ts';

interface ThreadHeaderProps {
  chat: UnifiedChat;
  coverage: ChatCoverage | null;
  /** The date the local archive for this chat starts, already formatted. */
  archiveStart: string | null;
}

export const ThreadHeader: React.FC<ThreadHeaderProps> = ({ chat, coverage, archiveStart }) => {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  // This chat's typing state, and nothing else. Subscribed to the whole map,
  // the thread was redrawn for every typing indicator in every other chat.
  const isTyping = useAppStore((s) => s.presenceMap[chat.jid]?.state === 'composing');

  return (
    <div className="h-14 border-b border-mc-border bg-mc-surface/80 backdrop-blur px-4 flex items-center justify-between shrink-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-sm text-mc-text truncate">{chat.name}</h2>
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-mc-border/50 text-mc-textMuted">
            {chat.kind}
          </span>
        </div>
        <div className="text-xs font-mono text-mc-textMuted truncate flex items-center gap-2">
          <span>{chat.jid}</span>
          {isTyping && <span className="text-mc-accent animate-pulse">● typing...</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {coverage && coverage.messageCount > 0 && (
          <span
            className="hidden sm:block text-[10px] font-mono text-mc-textMuted"
            title="How far back this machine's local archive reaches for this chat"
          >
            ARCHIVE {archiveStart ?? '?'} · {coverage.messageCount.toLocaleString()} MSG
          </span>
        )}
        <ExportMenu chatJid={chat.jid} chatName={chat.name} />
        <button
          onClick={() => setActiveModal('chat-info')}
          title="Contact details, local alias, and tags"
          aria-label="Chat info"
          className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-accent hover:border-mc-accent/50 hover:bg-mc-surfaceHover transition-colors"
        >
          <Info size={12} />
          <span>INFO</span>
        </button>
      </div>
    </div>
  );
};
