import React, { useState } from 'react';
import { X, Tag, Pencil, Loader2, Check, Users, User, AlertTriangle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { normalizeTag, suggestTags, findSimilarTag } from '../../lib/tagSuggest.ts';
import type { UnifiedGroup } from '../../types.ts';

function formatDate(ts: string | null): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex justify-between gap-3 text-[11px]">
    <span className="text-mc-textMuted shrink-0">{label}:</span>
    <span className="text-mc-text text-right truncate">{children}</span>
  </div>
);

export const ChatInfoModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const selectedChat = useAppStore((s) => s.selectedChat);
  const queryClient = useQueryClient();

  const isOpen = activeModal === 'chat-info' && Boolean(selectedChat);
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, () => setActiveModal(null));

  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  // -1 means nothing is picked from the list, so Enter always commits exactly
  // what was typed. A suggestion is opt-in, via the arrow keys or a click.
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [isListOpen, setIsListOpen] = useState(false);

  const jid = selectedChat?.jid ?? '';
  const isGroup = jid.endsWith('@g.us');

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });
  const isReadOnly = Boolean(health?.readOnly);

  const { data: contact, isLoading: contactLoading } = useQuery({
    queryKey: ['contact', jid],
    queryFn: () => api.getContact({ jid }),
    enabled: isOpen && !isGroup,
  });

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => api.getGroups(),
    enabled: isOpen && isGroup,
  });

  const group: UnifiedGroup | undefined = groups?.find((g) => g.jid === jid);

  const { data: tagData } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.getTags(),
    enabled: isOpen,
  });

  // Groups have no contact record, so their labels come from the tag map.
  const tags = isGroup ? (tagData?.byJid[jid] ?? []) : (contact?.tags ?? []);

  // Every tag the operator has ever used, so the box can steer them back to
  // one instead of letting a second spelling of it into the vocabulary.
  const allTags = tagData?.tags ?? [];
  const suggestions = suggestTags(tagDraft, allTags, tags);
  const normalizedDraft = normalizeTag(tagDraft);
  const isDuplicate = tags.includes(normalizedDraft);
  const nearMiss = findSimilarTag(tagDraft, allTags);
  // A near-miss the list is already offering needs no second warning.
  const similarTag = nearMiss && !suggestions.includes(nearMiss) ? nearMiss : null;

  const aliasMutation = useMutation({
    mutationFn: (alias: string) => api.setContactAlias({ jid, alias }),
    onSuccess: () => {
      setAliasDraft(null);
      queryClient.invalidateQueries({ queryKey: ['contact', jid] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });

  const tagMutation = useMutation({
    mutationFn: (params: { tag: string; add: boolean }) =>
      api.setChatTag({ jid, tag: params.tag, add: params.add }),
    onSuccess: () => {
      setTagDraft('');
      setActiveSuggestion(-1);
      setIsListOpen(false);
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['contact', jid] });
    },
  });

  // Every path that commits a tag folds it first, so a chip can never appear in
  // a spelling the store would not keep.
  const submitTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag || tags.includes(tag)) return;
    tagMutation.mutate({ tag, add: true });
  };

  if (!isOpen || !selectedChat) return null;

  const aliasValue = aliasDraft ?? contact?.alias ?? '';
  const isEditingAlias = aliasDraft !== null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-info-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-md flex flex-col max-h-[85vh] font-mono text-xs"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2 id="chat-info-title" className="flex items-center gap-2 font-semibold text-sm text-mc-text min-w-0">
            {isGroup ? <Users size={15} className="text-mc-live shrink-0" /> : <User size={15} className="text-mc-live shrink-0" />}
            <span className="truncate">{selectedChat.name}</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close chat info"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-1.5">
            <Row label="JID">{selectedChat.jid}</Row>
            {isGroup ? (
              <>
                <Row label="Group name">{group?.name || selectedChat.name}</Row>
                <Row label="Owner">{group?.ownerJid || '—'}</Row>
                <Row label="Created">{formatDate(group?.createdAt ?? null)}</Row>
                <Row label="Last updated">{formatDate(group?.updatedAt ?? null)}</Row>
              </>
            ) : (
              <>
                <Row label="Phone">{contact?.phone || selectedChat.jid.split('@')[0]}</Row>
                <Row label="WhatsApp name">{contact?.name || '—'}</Row>
                <Row label="System contact">{contact?.systemName || '—'}</Row>
                <Row label="Last synced">{formatDate(contact?.updatedAt ?? null)}</Row>
              </>
            )}
          </div>

          {isGroup && (
            <p className="text-[10px] text-mc-textMuted font-sans">
              Group metadata comes from the local store. wacli has no command that lists members
              without a live fetch, so participants are not shown here.
            </p>
          )}

          {!isGroup && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold">
                Local alias
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label="Local alias"
                  value={aliasValue}
                  disabled={contactLoading || isReadOnly}
                  placeholder={isReadOnly ? 'Read-only mode' : 'Name this contact locally'}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isEditingAlias) aliasMutation.mutate(aliasValue.trim());
                  }}
                  className="flex-1 bg-mc-bg border border-mc-border rounded px-2 py-1 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live disabled:opacity-50"
                />
                <button
                  onClick={() => aliasMutation.mutate(aliasValue.trim())}
                  disabled={!isEditingAlias || aliasMutation.isPending || isReadOnly}
                  title={
                    isReadOnly
                      ? 'Safe read-only mode is active: an alias is written to the wacli store, so it is disabled.'
                      : 'Save this alias to the wacli store'
                  }
                  className="flex items-center gap-1 px-2 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {aliasMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : aliasMutation.isSuccess && !isEditingAlias ? (
                    <Check size={12} className="text-mc-live" />
                  ) : (
                    <Pencil size={12} />
                  )}
                  <span>SAVE</span>
                </button>
              </div>
              <p className="text-[10px] text-mc-textMuted font-sans">
                Stored by wacli on this machine. It renames the chat here, not on WhatsApp &mdash; the
                other person never sees it. Save an empty box to clear it.
              </p>
              {aliasMutation.isError && (
                <p className="text-[10px] text-mc-danger">{(aliasMutation.error as Error).message}</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold flex items-center gap-1.5">
              <Tag size={12} />
              Tags
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tags.length === 0 && <span className="text-[10px] text-mc-textMuted">No tags yet.</span>}
              {tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => tagMutation.mutate({ tag, add: false })}
                  // The chip reads as its tag; the action it performs has to be
                  // spelled out, or a screen reader announces only the label.
                  aria-label={`Remove tag "${tag}"`}
                  title={`Remove tag "${tag}"`}
                  className="group flex items-center gap-1 px-1.5 py-0.5 rounded bg-mc-live/10 border border-mc-live/40 text-mc-live text-[10px] hover:bg-mc-danger/15 hover:border-mc-danger/50 hover:text-mc-danger transition-colors"
                >
                  <span>{tag}</span>
                  <X size={9} className="opacity-50 group-hover:opacity-100" />
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                {/*
                  The list opens upward: the tag row is the last thing in a
                  scrolling body, which would clip a popup hanging below it.
                */}
                {isListOpen && suggestions.length > 0 && (
                  <ul
                    id="tag-suggestion-list"
                    role="listbox"
                    aria-label="Existing tags"
                    className="absolute bottom-full inset-x-0 mb-1 z-10 bg-mc-surface border border-mc-border rounded shadow-xl overflow-hidden"
                  >
                    {suggestions.map((tag, i) => (
                      <li
                        key={tag}
                        id={`tag-suggestion-${i}`}
                        role="option"
                        aria-selected={i === activeSuggestion}
                        // A plain click would blur the box and unmount this list
                        // before it landed, so the pick happens on press.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          submitTag(tag);
                        }}
                        onMouseEnter={() => setActiveSuggestion(i)}
                        className={`px-2 py-1 text-xs cursor-pointer ${
                          i === activeSuggestion ? 'bg-mc-live/15 text-mc-live' : 'text-mc-text'
                        }`}
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  type="text"
                  aria-label="Add tag"
                  role="combobox"
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={isListOpen && suggestions.length > 0}
                  aria-controls={isListOpen && suggestions.length > 0 ? 'tag-suggestion-list' : undefined}
                  aria-activedescendant={
                    activeSuggestion >= 0 ? `tag-suggestion-${activeSuggestion}` : undefined
                  }
                  value={tagDraft}
                  placeholder="work, family, follow-up..."
                  onChange={(e) => {
                    setTagDraft(e.target.value);
                    setActiveSuggestion(-1);
                    setIsListOpen(true);
                  }}
                  onFocus={() => setIsListOpen(true)}
                  onBlur={() => {
                    setIsListOpen(false);
                    setActiveSuggestion(-1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      // Escape belongs to the dialog, which closes on it, so the
                      // arrows are the only keys this list claims.
                      e.preventDefault();
                      if (suggestions.length === 0) return;
                      setIsListOpen(true);
                      setActiveSuggestion((i) =>
                        e.key === 'ArrowDown'
                          ? (i + 1) % suggestions.length
                          : (i <= 0 ? suggestions.length : i) - 1
                      );
                      return;
                    }
                    if (e.key === 'Enter') {
                      submitTag(activeSuggestion >= 0 ? suggestions[activeSuggestion] : tagDraft);
                    }
                  }}
                  className="w-full bg-mc-bg border border-mc-border rounded px-2 py-1 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live"
                />
              </div>
              <button
                onClick={() => submitTag(tagDraft)}
                disabled={!normalizedDraft || isDuplicate || tagMutation.isPending}
                title={isDuplicate ? `This chat already has "${normalizedDraft}"` : 'Add this tag'}
                className="flex items-center gap-1 px-2 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {tagMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Tag size={12} />}
                <span>ADD</span>
              </button>
            </div>
            {isDuplicate ? (
              <p className="text-[10px] text-mc-textMuted font-sans">
                This chat already has <span className="text-mc-live">{normalizedDraft}</span>.
              </p>
            ) : similarTag ? (
              <p className="flex items-start gap-1 text-[10px] text-mc-safe font-sans">
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                <span>
                  Close to the tag{' '}
                  <button
                    type="button"
                    onClick={() => submitTag(similarTag)}
                    className="underline underline-offset-2 hover:text-mc-live"
                  >
                    {similarTag}
                  </button>{' '}
                  you already use &mdash; add that one instead of a second spelling?
                </span>
              </p>
            ) : normalizedDraft && normalizedDraft !== tagDraft.trim() ? (
              <p className="text-[10px] text-mc-textMuted font-sans">
                Saved as <span className="text-mc-text">{normalizedDraft}</span>.
              </p>
            ) : null}
            <p className="text-[10px] text-mc-textMuted font-sans">
              Mission Control&apos;s own labels, kept on this machine. wacli can write a tag but has no
              command that reads one back, so these never go near WhatsApp &mdash; and they keep working
              in safe read-only mode.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
