import React, { useEffect, useMemo, useRef } from 'react';
import { groupReactions, type ThreadReaction } from '../../lib/reactionFold.ts';

interface ReactionSummaryProps {
  reactions: ThreadReaction[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /**
   * Which edge of the bubble the list hangs from: the one at the side of the
   * pane, so it opens across the bubble rather than out of the pane.
   */
  align: 'left' | 'right';
}

/**
 * A message's reactions, counted by emoji, and who left each one on click.
 * Hovering used to be the only way to learn who reacted, one emoji at a time.
 */
export const ReactionSummary: React.FC<ReactionSummaryProps> = ({ reactions, open, onToggle, onClose, align }) => {
  const groups = useMemo(() => groupReactions(reactions), [reactions]);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      // The badge toggles on its own; closing here too would reopen it.
      if (!badgeRef.current?.contains(target) && !listRef.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const names = (group: { reactors: ThreadReaction[] }) =>
    group.reactors.map((rx) => (rx.fromMe ? 'You' : rx.sender)).join(', ');

  // Both are placed against the bubble, not each other.
  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`Reactions: ${groups.map((g) => `${g.emoji} ${names(g)}`).join('; ')}`}
        className="absolute -bottom-2 right-2 flex items-center gap-1 bg-mc-surface border border-mc-border rounded-full px-1.5 text-[11px] shadow-sm hover:border-mc-accent/50 transition-colors"
      >
        {groups.map((g) => (
          <span key={g.emoji} className="flex items-center gap-0.5">
            <span>{g.emoji}</span>
            {g.reactors.length > 1 && (
              <span className="font-mono text-[10px] text-mc-textMuted">{g.reactors.length}</span>
            )}
          </span>
        ))}
      </button>

      {open && (
        <div
          ref={listRef}
          role="dialog"
          aria-label="Who reacted"
          className={`absolute top-full mt-3 ${align === 'right' ? 'right-0' : 'left-0'} z-50 w-56 max-h-64 overflow-y-auto bg-mc-surface border border-mc-border rounded-lg shadow-2xl p-1.5 font-sans`}
        >
          <div className="px-1.5 pb-1 mb-1 border-b border-mc-border/60 text-[10px] font-mono uppercase tracking-wider text-mc-textMuted">
            {reactions.length} {reactions.length === 1 ? 'reaction' : 'reactions'}
          </div>
          <ul className="space-y-0.5">
            {groups.flatMap((g) =>
              g.reactors.map((rx, i) => (
                <li
                  key={`${g.emoji}-${i}`}
                  className="flex items-center gap-2 px-1.5 py-0.5 rounded text-xs text-mc-text"
                >
                  <span className="text-sm w-5 text-center">{g.emoji}</span>
                  <span className="truncate">{rx.fromMe ? 'You' : rx.sender}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </>
  );
};
