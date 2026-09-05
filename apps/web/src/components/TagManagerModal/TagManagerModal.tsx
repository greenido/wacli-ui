import React, { useMemo, useState } from 'react';
import { X, Tag, Pencil, Trash2, Check, Loader2, AlertTriangle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { normalizeTag } from '../../lib/tagSuggest.ts';

/**
 * The vocabulary itself, rather than one chat's labels.
 *
 * ChatInfoModal answers "which tags does this chat carry" — it can add one and
 * take one off, but only here. A label the operator has already spread over a
 * dozen conversations could not be corrected or retired without visiting all
 * twelve. This modal is the other axis: one tag, every chat carrying it.
 */
export const TagManagerModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const setTagFilter = useAppStore((s) => s.setTagFilter);
  const queryClient = useQueryClient();

  const isOpen = activeModal === 'tag-manager';

  // At most one row is open at a time: two half-finished renames on screen
  // would leave the operator guessing which Save belongs to which name.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeRow = () => {
    setEditing(null);
    setDraft('');
    setMergeInto(null);
    setConfirmDelete(null);
    setError(null);
  };

  // Escape steps back one level rather than always leaving. The hook takes it
  // on document in the capture phase, so a handler on the input would never
  // see it — the decision has to live here, where the open row is known.
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, () => {
    if (editing !== null || confirmDelete !== null) {
      closeRow();
      return;
    }
    setActiveModal(null);
  });

  const { data: tagData, isLoading } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.getTags(),
    enabled: isOpen,
  });

  const allTags = tagData?.tags ?? [];
  const byJid = useMemo(() => tagData?.byJid ?? {}, [tagData]);

  // The blast radius of every row's two buttons, so neither is a leap.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tags of Object.values(byJid)) {
      for (const tag of tags) out[tag] = (out[tag] ?? 0) + 1;
    }
    return out;
  }, [byJid]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tags'] });
    // Every contact carries its own copy of the list, and a rename touched an
    // unknown number of them, so the whole prefix goes rather than one jid.
    void queryClient.invalidateQueries({ queryKey: ['contact'] });
  };

  const renameMutation = useMutation({
    mutationFn: (params: { from: string; to: string }) => api.renameTag(params),
    onSuccess: (_data, params) => {
      // A rail filtered on the old name would go blank the moment it stopped
      // existing, so the filter follows the rename instead of stranding it.
      if (tagFilter === params.from) setTagFilter(params.to);
      closeRow();
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (params: { tag: string }) => api.deleteTag(params),
    onSuccess: (_data, params) => {
      if (tagFilter === params.tag) setTagFilter(null);
      closeRow();
      invalidate();
    },
  });

  const isBusy = renameMutation.isPending || deleteMutation.isPending;

  const startRename = (tag: string) => {
    closeRow();
    setEditing(tag);
    setDraft(tag);
  };

  const commitRename = () => {
    if (!editing) return;

    const to = normalizeTag(draft);
    if (!to) {
      setError('A tag needs at least one character that is not whitespace.');
      return;
    }
    // Renaming a tag to itself is a cancel that took a detour.
    if (to === editing) {
      closeRow();
      return;
    }
    // Merging is lossy in one direction — the old name stops existing — so it
    // is confirmed before it happens rather than explained afterwards.
    if (mergeInto !== to && allTags.includes(to)) {
      setMergeInto(to);
      setError(null);
      return;
    }

    renameMutation.mutate({ from: editing, to });
  };

  if (!isOpen) return null;

  const mutationError = renameMutation.isError
    ? (renameMutation.error as Error).message
    : deleteMutation.isError
      ? (deleteMutation.error as Error).message
      : null;

  // How many chats end up carrying the target name: the two sets, unioned, so
  // a chat already holding both is counted once.
  const mergedCount = (from: string, to: string) =>
    Object.values(byJid).filter((tags) => tags.includes(from) || tags.includes(to)).length;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-manager-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-md flex flex-col max-h-[85vh] font-mono text-xs"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2
            id="tag-manager-title"
            className="flex items-center gap-2 font-semibold text-sm text-mc-text min-w-0"
          >
            <Tag size={15} className="text-mc-live shrink-0" />
            <span className="truncate">Manage Tags</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close tag manager"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {isLoading && (
            <p className="flex items-center gap-2 text-[11px] text-mc-textMuted">
              <Loader2 size={12} className="animate-spin" />
              Loading tags...
            </p>
          )}

          {!isLoading && allTags.length === 0 && (
            <p className="text-[11px] text-mc-textMuted font-sans">
              No tags yet. Open a chat&apos;s info panel to label it, and the label shows up here.
            </p>
          )}

          {allTags.length > 0 && (
            <ul className="divide-y divide-mc-border/60 border border-mc-border rounded bg-mc-bg">
              {allTags.map((tag) => {
                const count = counts[tag] ?? 0;
                const chats = `${count} ${count === 1 ? 'chat' : 'chats'}`;

                if (editing === tag) {
                  return (
                    <li key={tag} className="p-2.5 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          data-autofocus
                          autoComplete="off"
                          aria-label={`New name for tag "${tag}"`}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            // A changed name is a different question, so an
                            // answered merge prompt stops applying to it.
                            setMergeInto(null);
                            setError(null);
                          }}
                          // Escape is not handled here: the dialog hook claims
                          // it on document first, and steps this row back.
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitRename();
                            }
                          }}
                          className="flex-1 min-w-0 bg-mc-surface border border-mc-border rounded px-2 py-1 text-[11px] text-mc-text focus:outline-none focus:border-mc-live"
                        />
                        <button
                          onClick={commitRename}
                          disabled={isBusy}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-mc-live/15 border border-mc-live/40 text-mc-live text-[10px] hover:bg-mc-live/25 disabled:opacity-50"
                        >
                          {renameMutation.isPending ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <Check size={10} />
                          )}
                          <span>{mergeInto ? 'MERGE' : 'SAVE'}</span>
                        </button>
                        <button
                          onClick={closeRow}
                          disabled={isBusy}
                          className="px-2 py-1 rounded border border-mc-border text-mc-textMuted text-[10px] hover:text-mc-text disabled:opacity-50"
                        >
                          CANCEL
                        </button>
                      </div>

                      {mergeInto && (
                        <p className="flex items-start gap-1 text-[10px] text-mc-safe font-sans">
                          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                          <span>
                            <span className="font-semibold">{mergeInto}</span> already exists.
                            Saving merges the two into one tag on{' '}
                            {mergedCount(tag, mergeInto)} chats, and{' '}
                            <span className="font-semibold">{tag}</span> stops existing.
                          </span>
                        </p>
                      )}

                      {error && <p className="text-[10px] text-mc-danger font-sans">{error}</p>}
                    </li>
                  );
                }

                if (confirmDelete === tag) {
                  return (
                    <li key={tag} className="p-2.5 flex items-center gap-2 flex-wrap">
                      <span className="flex-1 min-w-0 text-[11px] text-mc-text font-sans">
                        Remove <span className="font-semibold font-mono">{tag}</span> from {chats}?
                      </span>
                      <button
                        onClick={() => deleteMutation.mutate({ tag })}
                        disabled={isBusy}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-mc-danger/15 border border-mc-danger/40 text-mc-danger text-[10px] hover:bg-mc-danger/25 disabled:opacity-50"
                      >
                        {deleteMutation.isPending ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Trash2 size={10} />
                        )}
                        <span>DELETE</span>
                      </button>
                      <button
                        onClick={closeRow}
                        disabled={isBusy}
                        className="px-2 py-1 rounded border border-mc-border text-mc-textMuted text-[10px] hover:text-mc-text disabled:opacity-50"
                      >
                        CANCEL
                      </button>
                    </li>
                  );
                }

                return (
                  <li key={tag} className="p-2.5 flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-[11px] text-mc-text">{tag}</span>
                    <span className="text-[10px] text-mc-textMuted shrink-0">{chats}</span>
                    <button
                      onClick={() => startRename(tag)}
                      aria-label={`Rename tag "${tag}"`}
                      title={`Rename tag "${tag}"`}
                      className="p-1 rounded text-mc-textMuted hover:text-mc-live hover:bg-mc-surfaceHover shrink-0"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => {
                        closeRow();
                        setConfirmDelete(tag);
                      }}
                      aria-label={`Delete tag "${tag}"`}
                      title={`Delete tag "${tag}"`}
                      className="p-1 rounded text-mc-textMuted hover:text-mc-danger hover:bg-mc-surfaceHover shrink-0"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {mutationError && <p className="text-[10px] text-mc-danger font-sans">{mutationError}</p>}

          <p className="text-[10px] text-mc-textMuted font-sans">
            Renaming or deleting here changes every chat carrying the tag. These are Mission
            Control&apos;s own labels, kept on this machine &mdash; nothing here reaches WhatsApp, and
            it all keeps working in safe read-only mode.
          </p>
        </div>
      </div>
    </div>
  );
};
