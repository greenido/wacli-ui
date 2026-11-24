import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, BellOff, Bell, CircleDot, Lock, MailOpen, Pin, PinOff } from 'lucide-react';
import { isChatMuted, MUTE_OPTIONS, toggleArchive, togglePin, type ChatStateChange } from '../../lib/chatState.ts';
import type { UnifiedChat } from '../../types.ts';

/** Marking read goes through the receipt path, not `chats state`. */
export type ChatMenuPick = ChatStateChange | { action: 'mark-read' };

interface ChatActionsMenuProps {
  chat: UnifiedChat;
  /** Where the menu hangs from: the row's trigger, or the rail when off-screen. */
  anchor: DOMRect;
  readOnly: boolean;
  /** Opened by the M key: start on the mute lengths. */
  focusMute?: boolean;
  onPick: (pick: ChatMenuPick) => void;
  onClose: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  pick: ChatMenuPick;
  mute?: boolean;
}

const MENU_WIDTH = 208;
const GAP = 4;

function menuItems(chat: UnifiedChat): MenuItem[] {
  const items: MenuItem[] = [
    {
      key: 'pin',
      label: chat.pinned ? 'Unpin chat' : 'Pin chat',
      hint: 'P',
      icon: chat.pinned ? <PinOff size={12} /> : <Pin size={12} />,
      pick: togglePin(chat),
    },
  ];

  if (isChatMuted(chat)) {
    items.push({ key: 'unmute', label: 'Unmute', hint: 'M', icon: <Bell size={12} />, pick: { action: 'unmute' } });
  } else {
    MUTE_OPTIONS.forEach((option, index) => {
      items.push({
        key: `mute-${option.duration}`,
        label: option.hours > 0 ? `Mute for ${option.label}` : 'Mute always',
        hint: index === 0 ? 'M' : undefined,
        icon: <BellOff size={12} />,
        pick: { action: 'mute', duration: option.duration },
        mute: true,
      });
    });
  }

  items.push({
    key: 'archive',
    label: chat.archived ? 'Unarchive chat' : 'Archive chat',
    hint: 'A',
    icon: chat.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />,
    pick: toggleArchive(chat),
  });

  const unread = chat.unread || chat.unreadCount > 0;
  items.push({
    key: 'read',
    label: unread ? 'Mark as read' : 'Mark as unread',
    hint: 'U',
    icon: unread ? <MailOpen size={12} /> : <CircleDot size={12} />,
    pick: unread ? { action: 'mark-read' } : { action: 'mark-unread' },
  });

  return items;
}

/**
 * The rail's per-chat menu. Fixed to the viewport rather than the row, so the
 * last chat in a scrolled rail does not open a menu the rail then clips.
 *
 * Arrow keys walk it, Enter picks, Escape or a click elsewhere closes it, and
 * scrolling closes it too, since a fixed menu would otherwise float away from
 * the row it belongs to.
 */
export const ChatActionsMenu: React.FC<ChatActionsMenuProps> = ({
  chat,
  anchor,
  readOnly,
  focusMute = false,
  onPick,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const items = useMemo(() => menuItems(chat), [chat]);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: anchor.bottom + GAP,
    left: Math.max(GAP, anchor.right - MENU_WIDTH),
  });

  // Below the anchor when it fits, above it when it does not.
  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 0;
    const below = anchor.bottom + GAP;
    const top = below + height > window.innerHeight - GAP ? Math.max(GAP, anchor.top - height - GAP) : below;
    const left = Math.min(Math.max(GAP, anchor.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - GAP);
    setPosition({ top, left });
  }, [anchor]);

  useEffect(() => {
    const start = readOnly ? -1 : focusMute ? items.findIndex((item) => item.mute || item.key === 'unmute') : 0;
    const target = start >= 0 ? itemRefs.current[start] : menuRef.current;
    target?.focus();
  }, [readOnly, focusMute, items]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const enabled = readOnly ? [] : itemRefs.current.filter((el): el is HTMLButtonElement => Boolean(el));
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);

    switch (e.key) {
      case 'Escape':
      case 'Tab':
        // Claimed here, so the global layer does not act on it too.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        if (enabled.length === 0) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        enabled[(current + step + enabled.length) % enabled.length].focus();
        return;
      }
      case 'Home':
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        (e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1])?.focus();
        return;
      default:
        // Every other key belongs to the menu while it is open: `j` switching
        // chats underneath it would leave it pointing at the wrong one.
        if (e.key.length === 1) {
          e.preventDefault();
          e.stopPropagation();
        }
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${chat.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', top: position.top, left: position.left, width: MENU_WIDTH }}
      className="z-50 py-1 rounded border border-mc-border bg-mc-surface shadow-lg text-xs font-mono focus:outline-none"
    >
      {readOnly && (
        <div className="px-3 py-1.5 mb-1 border-b border-mc-border text-[10px] text-mc-safe flex items-start gap-1.5 font-sans">
          <Lock size={11} className="shrink-0 mt-0.5" />
          <span>Safe mode is on. Unlock live sends to change chats.</span>
        </div>
      )}
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          role="menuitem"
          disabled={readOnly}
          onClick={() => {
            onPick(item.pick);
            onClose();
          }}
          className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-mc-text hover:bg-mc-surfaceHover focus:bg-mc-surfaceHover focus:outline-none disabled:text-mc-textMuted/60 disabled:hover:bg-transparent"
        >
          <span className="shrink-0 text-mc-textMuted">{item.icon}</span>
          <span className="flex-1 truncate">{item.label}</span>
          {item.hint && (
            <kbd className="shrink-0 px-1 rounded border border-mc-border text-[10px] text-mc-textMuted">
              {item.hint}
            </kbd>
          )}
        </button>
      ))}
    </div>
  );
};
