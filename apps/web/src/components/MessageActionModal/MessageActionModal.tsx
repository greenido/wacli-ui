import React, { useEffect, useRef, useState } from 'react';
import { Forward, Lock, Pencil, Search, Trash2, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { useHealth } from '../../hooks/useHealth.ts';
import { useSleepMode } from '../../hooks/useSleepMode.ts';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { messagePreviewText } from '../../lib/messagePreview.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { canDeleteForMe, canEdit, canUnsend, editMinutesLeft } from '../../lib/messageActions.ts';
import { CopyableError } from '../CopyableError/CopyableError.tsx';
import type { UnifiedChat, UnifiedMessage } from '../../types.ts';

type Action = NonNullable<ReturnType<typeof useAppStore.getState>['messageAction']>;

const BUTTON =
  'px-3 py-1.5 rounded text-xs font-mono font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed';
const CANCEL =
  'px-3 py-1.5 rounded text-xs font-mono text-mc-textMuted border border-mc-border hover:text-mc-text hover:bg-mc-surfaceHover transition-colors';
const LIVE = `${BUTTON} bg-mc-live/20 text-mc-live border border-mc-live/60 hover:bg-mc-live/30`;
const DANGER = `${BUTTON} bg-mc-danger/15 text-mc-danger border border-mc-danger/60 hover:bg-mc-danger/25`;

/** One line about a message, for the activity log and the read-back. */
function previewOf(msg: UnifiedMessage): string {
  return messagePreviewText(msg) || msg.filename || '(message)';
}

function errorText(err: unknown): string | null {
  if (!err) return null;
  return err instanceof Error ? err.message : String(err);
}

/** The message as it stands: what the operator is about to change. */
const Original: React.FC<{ msg: UnifiedMessage; label: string }> = ({ msg, label }) => {
  const text = previewOf(msg);
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono uppercase text-mc-textMuted">{label}</div>
      <div
        dir={detectTextDirection(text)}
        className="p-2 rounded border border-mc-border bg-mc-bg text-xs text-mc-text whitespace-pre-wrap break-words max-h-32 overflow-y-auto text-start"
      >
        {text}
      </div>
    </div>
  );
};

const SafeModeNote: React.FC = () => (
  <p className="flex items-start gap-1.5 text-[11px] text-mc-safe font-mono">
    <Lock size={12} className="shrink-0 mt-0.5" />
    <span>Safe mode is on. Unlock live sends to change messages.</span>
  </p>
);

/** Settles what every change leaves stale, then closes. */
function useSettle(close: () => void) {
  const queryClient = useQueryClient();
  return (...chats: string[]) => {
    for (const jid of chats) void queryClient.invalidateQueries({ queryKey: ['messages', jid] });
    void queryClient.invalidateQueries({ queryKey: ['chats'] });
    void queryClient.invalidateQueries({ queryKey: ['activity'] });
    close();
  };
}

const EditBody: React.FC<{ action: Action; readOnly: boolean; close: () => void }> = ({
  action,
  readOnly,
  close,
}) => {
  const original = action.msg.text || action.msg.displayText;
  const [draft, setDraft] = useState(original);
  const settle = useSettle(close);
  // Read once: the window is checked again by wacli, which says so if it passed.
  const [minutesLeft] = useState(() => editMinutesLeft(action.msg));
  const [editable] = useState(() => canEdit(action.msg));

  const mutation = useMutation({
    mutationFn: () =>
      api.editMessage({
        chat: action.chatJid,
        id: action.msg.msgId,
        message: draft,
        chatName: action.chatName,
        confirm: true,
      }),
    onSuccess: () => settle(action.chatJid),
  });

  const unchanged = draft.trim() === original.trim();
  const blocked = readOnly || !editable || unchanged || !draft.trim() || mutation.isPending;
  const save = () => {
    if (!blocked) mutation.mutate();
  };

  return (
    <>
      <div className="p-5 space-y-3">
        <Original msg={action.msg} label="Now reads" />
        <label className="block space-y-1">
          <span className="text-[10px] font-mono uppercase text-mc-textMuted">Change it to</span>
          <textarea
            data-autofocus
            value={draft}
            dir={detectTextDirection(draft)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            rows={4}
            className="w-full p-2 rounded border border-mc-border bg-mc-bg text-xs text-mc-text focus:outline-none focus:border-mc-accent resize-y text-start"
          />
        </label>
        <p className="text-[11px] font-mono text-mc-textMuted">
          {editable
            ? `Everyone in the chat sees the new text, marked edited. ${minutesLeft} min left to edit.`
            : 'WhatsApp only allows edits for 20 minutes after sending, and this one is past that.'}
        </p>
        {readOnly && <SafeModeNote />}
        {mutation.error && <CopyableError message={errorText(mutation.error) ?? ''} />}
      </div>
      <div className="px-4 py-3 border-t border-mc-border flex items-center justify-end gap-2">
        <button onClick={close} className={CANCEL}>
          CANCEL
        </button>
        <button onClick={save} disabled={blocked} className={LIVE} title="Cmd/Ctrl+Enter">
          {mutation.isPending ? 'SAVING...' : 'SAVE EDIT'}
        </button>
      </div>
    </>
  );
};

const DeleteBody: React.FC<{ action: Action; readOnly: boolean; close: () => void }> = ({
  action,
  readOnly,
  close,
}) => {
  const settle = useSettle(close);
  const [forEveryoneAllowed] = useState(() => canUnsend(action.msg));
  const forMeAllowed = canDeleteForMe(action.msg);

  const mutation = useMutation({
    mutationFn: (forEveryone: boolean) =>
      api.deleteMessage({
        chat: action.chatJid,
        id: action.msg.msgId,
        forEveryone,
        chatName: action.chatName,
        preview: previewOf(action.msg),
        confirm: true,
      }),
    onSuccess: () => settle(action.chatJid),
  });

  return (
    <>
      <div className="p-5 space-y-3">
        <Original msg={action.msg} label="Message" />
        <ul className="text-[11px] text-mc-textMuted space-y-1 list-disc pl-4">
          {forEveryoneAllowed && (
            <li>
              <span className="text-mc-text">For everyone</span>: their phones show “This message was
              deleted” in its place.
            </li>
          )}
          {action.msg.fromMe && !forEveryoneAllowed && (
            <li>It is too old to delete for everyone; WhatsApp allows about two and a half days.</li>
          )}
          <li>
            <span className="text-mc-text">For me</span>: it goes from this account’s devices only.
          </li>
          <li>Neither can be undone.</li>
        </ul>
        {readOnly && <SafeModeNote />}
        {mutation.error && <CopyableError message={errorText(mutation.error) ?? ''} />}
      </div>
      <div className="px-4 py-3 border-t border-mc-border flex flex-wrap items-center justify-end gap-2">
        <button data-autofocus onClick={close} className={CANCEL}>
          CANCEL
        </button>
        <button
          onClick={() => mutation.mutate(false)}
          disabled={readOnly || !forMeAllowed || mutation.isPending}
          className={DANGER}
        >
          DELETE FOR ME
        </button>
        {forEveryoneAllowed && (
          <button
            onClick={() => mutation.mutate(true)}
            disabled={readOnly || mutation.isPending}
            className={DANGER}
          >
            DELETE FOR EVERYONE
          </button>
        )}
      </div>
    </>
  );
};

const ForwardBody: React.FC<{ action: Action; readOnly: boolean; close: () => void }> = ({
  action,
  readOnly,
  close,
}) => {
  const settle = useSettle(close);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<UnifiedChat | null>(null);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const debounced = useDebouncedValue(query.trim(), 250);

  const { data: health } = useHealth();
  const { awake } = useSleepMode();
  const { data: chats = [], isLoading, isFetching } = useQuery({
    queryKey: ['forwardTargets', debounced],
    queryFn: () => api.getChats({ query: debounced || undefined, limit: debounced ? 25 : 50 }),
    ...wacliReadQueryOptions(awake && isWacliReadyForReads(health)),
  });

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor]);

  const mutation = useMutation({
    mutationFn: (to: UnifiedChat) =>
      api.forwardMessage({
        chat: action.chatJid,
        id: action.msg.msgId,
        to: to.jid,
        toName: to.name,
        preview: previewOf(action.msg),
        confirm: true,
      }),
    onSuccess: (_data, to) => settle(action.chatJid, to.jid),
  });

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (chats.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => (c + step + chats.length) % chats.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // The list still answers the search before this one, so the row under
      // the cursor is not what was typed for.
      if (query.trim() !== debounced || isFetching) return;
      // The first Enter picks; the forward button is a separate, deliberate step.
      if (chats[cursor]) setTarget(chats[cursor]);
    }
  };

  return (
    <>
      <div className="p-5 space-y-3">
        <Original msg={action.msg} label="Forwarding" />
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-mc-textMuted" />
          <input
            data-autofocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onSearchKey}
            placeholder="Search chats..."
            aria-label="Search chats to forward to"
            className="w-full bg-mc-bg border border-mc-border rounded pl-8 pr-3 py-1.5 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-accent"
          />
        </div>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Chats to forward to"
          className="max-h-48 overflow-y-auto rounded border border-mc-border divide-y divide-mc-border/40"
        >
          {isLoading && <li className="p-2 text-[11px] font-mono text-mc-textMuted">Loading chats...</li>}
          {!isLoading && chats.length === 0 && (
            <li className="p-2 text-[11px] font-mono text-mc-textMuted">No chats found.</li>
          )}
          {chats.map((chat, index) => {
            const chosen = target?.jid === chat.jid;
            return (
              <li
                key={chat.jid}
                data-index={index}
                role="option"
                aria-selected={chosen}
                onClick={() => setTarget(chat)}
                className={`px-2 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2 ${
                  chosen
                    ? 'bg-mc-accent/15 text-mc-accent'
                    : index === cursor
                      ? 'bg-mc-surfaceHover text-mc-text'
                      : 'text-mc-text hover:bg-mc-surfaceHover'
                }`}
              >
                <span className="truncate">{chat.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-mc-textMuted">{chat.kind}</span>
              </li>
            );
          })}
        </ul>
        {/* The read-back: who gets it, spelled out, before anything leaves. */}
        <p className="text-[11px] font-mono text-mc-textMuted break-all">
          {target ? (
            <>
              To: <span className="text-mc-text">{target.name}</span> ({target.jid})
            </>
          ) : (
            'Pick a chat to forward to.'
          )}
        </p>
        {readOnly && <SafeModeNote />}
        {mutation.error && <CopyableError message={errorText(mutation.error) ?? ''} />}
      </div>
      <div className="px-4 py-3 border-t border-mc-border flex items-center justify-end gap-2">
        <button onClick={close} className={CANCEL}>
          CANCEL
        </button>
        <button
          onClick={() => target && mutation.mutate(target)}
          disabled={readOnly || !target || mutation.isPending}
          className={LIVE}
        >
          {mutation.isPending ? 'FORWARDING...' : 'FORWARD'}
        </button>
      </div>
    </>
  );
};

const TITLES = {
  edit: { text: 'EDIT MESSAGE', icon: <Pencil size={15} className="text-mc-accent" /> },
  delete: { text: 'DELETE MESSAGE', icon: <Trash2 size={15} className="text-mc-danger" /> },
  forward: { text: 'FORWARD MESSAGE', icon: <Forward size={15} className="text-mc-accent" /> },
} as const;

/**
 * Edit, delete or forward one message. Each is the read-back step for its
 * change: the message as it stands, what will happen to it, and for a forward
 * the chat it goes to, all on screen before the button that does it.
 */
export const MessageActionModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const action = useAppStore((s) => s.messageAction);
  const openMessageAction = useAppStore((s) => s.openMessageAction);
  const open = activeModal === 'message-action' && action !== null;
  const close = () => openMessageAction(null);
  const dialogRef = useModalDialog<HTMLDivElement>(open, close);
  const { isReadOnly } = useSafeMode();

  if (!open || !action) return null;
  const title = TITLES[action.kind];
  const Body = action.kind === 'edit' ? EditBody : action.kind === 'delete' ? DeleteBody : ForwardBody;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-action-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-md flex flex-col font-sans max-h-full overflow-y-auto"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between gap-3">
          <h2
            id="message-action-title"
            className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-text min-w-0"
          >
            {title.icon}
            <span>{title.text}</span>
          </h2>
          <button onClick={close} aria-label="Close" className="p-1 text-mc-textMuted hover:text-mc-text rounded">
            <X size={16} />
          </button>
        </div>
        <p className="px-5 pt-3 text-[11px] font-mono text-mc-textMuted break-all">
          In: <span className="text-mc-text">{action.chatName}</span> ({action.chatJid})
        </p>
        {/* Keyed so a second message opened straight after starts clean. */}
        <Body key={`${action.kind}:${action.msg.msgId}`} action={action} readOnly={isReadOnly} close={close} />
      </div>
    </div>
  );
};
