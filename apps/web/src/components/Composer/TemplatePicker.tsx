import React from 'react';
import { Loader2 } from 'lucide-react';
import { templateOptionId } from '../../lib/templatePicker.ts';
import type { QuickReplyTemplate } from '../../types.ts';

interface TemplatePickerProps {
  id: string;
  matches: QuickReplyTemplate[];
  activeIndex: number;
  /** What was typed after the `/`, for the "nothing matches" line. */
  query: string;
  /** Whether there are any templates at all, before the search narrowed them. */
  hasTemplates: boolean;
  isLoading: boolean;
  isError: boolean;
  onPick: (template: QuickReplyTemplate) => void;
  onHover: (index: number) => void;
  onManage: () => void;
}

/**
 * The quick-reply list that opens above the composer.
 *
 * Focus never leaves the textarea: the composer drives the highlight with the
 * arrow keys and points aria-activedescendant at it, and a click here is kept
 * from taking focus so the caret is still where the operator left it.
 */
export const TemplatePicker: React.FC<TemplatePickerProps> = ({
  id,
  matches,
  activeIndex,
  query,
  hasTemplates,
  isLoading,
  isError,
  onPick,
  onHover,
  onManage,
}) => {
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  let status: React.ReactNode = null;
  if (isLoading) {
    status = (
      <span className="flex items-center gap-2">
        <Loader2 size={11} className="animate-spin" /> Loading templates...
      </span>
    );
  } else if (isError) {
    status = <span className="text-mc-danger">Could not load templates.</span>;
  } else if (!hasTemplates) {
    status = 'No quick replies yet. Save the ones you type often, then insert them with /.';
  } else if (matches.length === 0) {
    status = `No template matches “${query.trim()}”. Enter sends what you typed.`;
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 z-30 bg-mc-surface border border-mc-border rounded shadow-xl font-mono text-[11px] overflow-hidden"
      onMouseDown={keepFocus}
    >
      {status ? (
        <p className="px-3 py-2 text-mc-textMuted font-sans">{status}</p>
      ) : (
        <ul id={id} role="listbox" aria-label="Quick replies" className="max-h-64 overflow-y-auto py-1">
          {matches.map((template, index) => (
            <li
              key={template.id}
              id={templateOptionId(id, index)}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(template)}
              className={`px-3 py-1.5 cursor-pointer ${
                index === activeIndex ? 'bg-mc-live/15 text-mc-text' : 'text-mc-textMuted hover:bg-mc-surfaceHover'
              }`}
            >
              <span className="font-semibold text-mc-text">{template.name}</span>
              <span className="block truncate font-sans text-[11px] opacity-80" dir="auto">
                {template.body}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-mc-border text-[10px] text-mc-textMuted">
        <span className="truncate">↑↓ choose · Enter insert · Esc close</span>
        <button
          type="button"
          onClick={onManage}
          className="shrink-0 text-mc-live hover:underline"
        >
          MANAGE
        </button>
      </div>
    </div>
  );
};
