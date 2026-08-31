import React, { useState, useEffect, useRef } from 'react';
import { X, Smile, ThumbsUp, Heart, Sparkles, Search } from 'lucide-react';

interface EmojiReactionDrawerProps {
  onSelectEmoji: (emoji: string) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '🎉', '💯'];

const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    name: 'Smileys',
    icon: Smile,
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋',
      '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐',
      '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌',
      '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧',
      '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐',
    ],
  },
  {
    id: 'gestures',
    name: 'Gestures',
    icon: ThumbsUp,
    emojis: [
      '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲',
      '🤝', '🙏', '✍️', '💪', '👈', '👉', '👆', '👇', '☝️', '✌️',
      '🤞', '🖖', '🤘', '🤙', '🖐️', '✋', '👌', '🤌', '🤏', '🫡',
    ],
  },
  {
    id: 'hearts',
    name: 'Hearts',
    icon: Heart,
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '💌',
    ],
  },
  {
    id: 'celebration',
    name: 'Celebration',
    icon: Sparkles,
    emojis: [
      '🎉', '🎊', '🎈', '🎂', '🎁', '🎇', '🎆', '✨', '🌟', '⭐',
      '💫', '🔥', '💥', '💯', '🏆', '🥇', '🥈', '🥉', '🎯', '🚀',
    ],
  },
];

export const EmojiReactionDrawer: React.FC<EmojiReactionDrawerProps> = ({
  onSelectEmoji,
  onClose,
  align = 'left',
}) => {
  const [activeTab, setActiveTab] = useState<string>('smileys');
  const [search, setSearch] = useState<string>('');
  const [openDownward, setOpenDownward] = useState<boolean>(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape key
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Check vertical viewport bounds to avoid clipping at top
  useEffect(() => {
    if (drawerRef.current) {
      const rect = drawerRef.current.getBoundingClientRect();
      if (rect.top < 60) {
        setOpenDownward(true);
      }
    }
  }, []);

  const currentCategory = EMOJI_CATEGORIES.find((c) => c.id === activeTab) || EMOJI_CATEGORIES[0];

  const displayedEmojis = search.trim()
    ? EMOJI_CATEGORIES.flatMap((c) => c.emojis).filter((emoji) => emoji.includes(search.trim()))
    : currentCategory.emojis;

  const positionClasses = [
    openDownward ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
    align === 'right' ? 'right-0' : 'left-0',
  ].join(' ');

  return (
    <div
      ref={drawerRef}
      className={`absolute ${positionClasses} z-50 bg-mc-surface border border-mc-border rounded-lg shadow-2xl p-2.5 w-72 flex flex-col gap-2 font-sans select-none animate-in fade-in duration-100`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Quick Emojis Header */}
      <div className="flex items-center justify-between pb-1.5 border-b border-mc-border/60">
        <div className="flex gap-1 overflow-x-auto no-scrollbar py-0.5">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onSelectEmoji(emoji)}
              className="text-base hover:scale-125 transition-transform p-0.5 focus:outline-none"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-mc-textMuted hover:text-mc-text ml-1 shrink-0 rounded hover:bg-mc-surfaceHover transition-colors focus:outline-none"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search size={12} className="absolute left-2 top-2 text-mc-textMuted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter emojis..."
          className="w-full bg-mc-bg border border-mc-border rounded pl-6 pr-6 py-1 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-1.5 top-1.5 text-mc-textMuted hover:text-mc-text"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Category Tabs (shown when not searching) */}
      {!search.trim() && (
        <div className="flex items-center justify-between px-0.5 text-xs text-mc-textMuted">
          {EMOJI_CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeTab === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setActiveTab(cat.id);
                  setSearch('');
                }}
                className={`p-1 rounded flex items-center gap-1 transition-colors ${
                  isActive
                    ? 'bg-mc-surfaceHover text-mc-live font-semibold'
                    : 'hover:text-mc-text hover:bg-mc-surfaceHover/50'
                }`}
                title={cat.name}
              >
                <Icon size={13} />
                <span className="text-[10px]">{cat.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Emoji Grid */}
      <div className="grid grid-cols-6 gap-1.5 max-h-36 overflow-y-auto p-1 bg-mc-bg/50 rounded border border-mc-border/40">
        {displayedEmojis.length === 0 ? (
          <div className="col-span-6 text-center py-4 text-xs text-mc-textMuted font-mono">
            No emoji found
          </div>
        ) : (
          displayedEmojis.map((emoji, index) => (
            <button
              key={`${emoji}-${index}`}
              type="button"
              onClick={() => onSelectEmoji(emoji)}
              className="h-8 flex items-center justify-center text-lg hover:bg-mc-surfaceHover rounded hover:scale-110 transition-transform active:scale-95 focus:outline-none"
            >
              {emoji}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
