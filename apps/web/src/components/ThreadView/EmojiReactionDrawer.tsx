import React, { useState } from 'react';
import { X, Smile, ThumbsUp, Heart, Sparkles } from 'lucide-react';

interface EmojiReactionDrawerProps {
  onSelectEmoji: (emoji: string) => void;
  onClose: () => void;
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
}) => {
  const [activeTab, setActiveTab] = useState<string>('smileys');
  const [search, setSearch] = useState<string>('');

  const currentCategory = EMOJI_CATEGORIES.find((c) => c.id === activeTab) || EMOJI_CATEGORIES[0];

  const displayedEmojis = search.trim()
    ? EMOJI_CATEGORIES.flatMap((c) => c.emojis).filter((emoji) => emoji.includes(search.trim()))
    : currentCategory.emojis;

  return (
    <div
      className="absolute bottom-full mb-1 right-0 z-30 bg-mc-surface border border-mc-border rounded-lg shadow-2xl p-2.5 w-72 flex flex-col gap-2 font-sans select-none"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Quick Emojis Header */}
      <div className="flex items-center justify-between pb-1.5 border-b border-mc-border/60">
        <div className="flex gap-1 overflow-x-auto no-scrollbar py-0.5">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => onSelectEmoji(emoji)}
              className="text-base hover:scale-125 transition-transform p-0.5"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="p-1 text-mc-textMuted hover:text-mc-text ml-1 shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Category Tabs */}
      <div className="flex items-center justify-between px-1 text-xs text-mc-textMuted">
        {EMOJI_CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeTab === cat.id && !search;
          return (
            <button
              key={cat.id}
              onClick={() => {
                setActiveTab(cat.id);
                setSearch('');
              }}
              className={`p-1.5 rounded flex items-center gap-1 transition-colors ${
                isActive
                  ? 'bg-mc-surfaceHover text-mc-live font-semibold'
                  : 'hover:text-mc-text hover:bg-mc-surfaceHover/50'
              }`}
              title={cat.name}
            >
              <Icon size={14} />
              <span className="text-[10px]">{cat.name}</span>
            </button>
          );
        })}
      </div>

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
              onClick={() => onSelectEmoji(emoji)}
              className="h-8 flex items-center justify-center text-lg hover:bg-mc-surfaceHover rounded hover:scale-110 transition-transform active:scale-95"
            >
              {emoji}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
