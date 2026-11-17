import React, { useState } from 'react';
import { X, MessageSquareText, Pencil, Trash2, Check, Loader2, Plus } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { templateQuery } from '../../lib/templatePicker.ts';
import type { QuickReplyTemplate } from '../../types.ts';

/** Mirrors the API's limits, so the form says no before the server has to. */
const NAME_MAX = 60;

/**
 * Where quick replies are written, edited and retired.
 *
 * "New" starts from whatever is in the open chat's composer, so the reply the
 * operator just typed for the third time can become a template without being
 * typed a fourth.
 */
export const TemplateManagerModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const chatJid = useAppStore((s) => s.selectedChat?.jid ?? '');
  const composerDraft = useAppStore((s) => s.composerDrafts[chatJid] ?? '');
  const queryClient = useQueryClient();

  const isOpen = activeModal === 'templates';

  // One form at a time: 'new', the id being edited, or none.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeForm = () => {
    setEditing(null);
    setName('');
    setBody('');
    setConfirmDelete(null);
    setError(null);
  };

  const close = () => {
    closeForm();
    setActiveModal(null);
  };

  // Escape steps back out of an open form before it leaves the dialog.
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, () => {
    if (editing !== null || confirmDelete !== null) {
      closeForm();
      return;
    }
    close();
  });

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.getTemplates(),
    enabled: isOpen,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] });

  const saveMutation = useMutation({
    mutationFn: (input: { id: string | null; name: string; body: string }) =>
      input.id
        ? api.updateTemplate(input.id, { name: input.name, body: input.body })
        : api.createTemplate({ name: input.name, body: input.body }),
    onSuccess: () => {
      closeForm();
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => {
      closeForm();
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const isBusy = saveMutation.isPending || deleteMutation.isPending;

  if (!isOpen) return null;

  const startNew = () => {
    closeForm();
    setEditing('new');
    // A `/` search in the composer is a question, not a reply worth keeping.
    setBody(templateQuery(composerDraft) === null ? composerDraft : '');
  };

  const startEdit = (template: QuickReplyTemplate) => {
    closeForm();
    setEditing(template.id);
    setName(template.name);
    setBody(template.body);
  };

  const save = () => {
    if (!name.trim()) {
      setError('Give the template a name to find it by.');
      return;
    }
    if (!body.trim()) {
      setError('A template needs some text to insert.');
      return;
    }
    saveMutation.mutate({ id: editing === 'new' ? null : editing, name: name.trim(), body });
  };

  const form = (
    <div className="p-2.5 space-y-2">
      {/* autoFocus as well as data-autofocus: the dialog hook places focus
          only when the dialog opens, and the button that opened this form
          has just unmounted, which drops focus to the page. */}
      <input
        type="text"
        data-autofocus
        autoFocus
        autoComplete="off"
        aria-label="Template name"
        placeholder="Name, e.g. Running late"
        maxLength={NAME_MAX}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
        className="w-full bg-mc-surface border border-mc-border rounded px-2 py-1 text-[11px] text-mc-text focus:outline-none focus:border-mc-live"
      />
      <textarea
        aria-label="Template text"
        placeholder="The text to insert"
        rows={4}
        dir="auto"
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
        className="w-full bg-mc-surface border border-mc-border rounded px-2 py-1 text-[11px] text-mc-text font-sans focus:outline-none focus:border-mc-live resize-y"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={isBusy}
          className="flex items-center gap-1 px-2 py-1 rounded bg-mc-live/15 border border-mc-live/40 text-mc-live text-[10px] hover:bg-mc-live/25 disabled:opacity-50"
        >
          {saveMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
          <span>SAVE</span>
        </button>
        <button
          type="button"
          onClick={closeForm}
          disabled={isBusy}
          className="px-2 py-1 rounded border border-mc-border text-mc-textMuted text-[10px] hover:text-mc-text disabled:opacity-50"
        >
          CANCEL
        </button>
      </div>
      {error && <p className="text-[10px] text-mc-danger font-sans">{error}</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-manager-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-md flex flex-col max-h-[85vh] font-mono text-xs"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2
            id="template-manager-title"
            className="flex items-center gap-2 font-semibold text-sm text-mc-text min-w-0"
          >
            <MessageSquareText size={15} className="text-mc-live shrink-0" />
            <span className="truncate">Quick Replies</span>
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close quick replies"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {editing === 'new' ? (
            <div className="border border-mc-live/40 rounded bg-mc-bg">{form}</div>
          ) : (
            <button
              type="button"
              onClick={startNew}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-mc-border text-mc-text text-[11px] hover:border-mc-live hover:text-mc-live"
            >
              <Plus size={12} />
              <span>NEW TEMPLATE</span>
            </button>
          )}

          {isLoading && (
            <p className="flex items-center gap-2 text-[11px] text-mc-textMuted">
              <Loader2 size={12} className="animate-spin" />
              Loading templates...
            </p>
          )}

          {!isLoading && templates.length === 0 && editing !== 'new' && (
            <p className="text-[11px] text-mc-textMuted font-sans">
              No quick replies yet. Save the replies you type often, then type / at the start of a
              message to insert one.
            </p>
          )}

          {templates.length > 0 && (
            <ul className="divide-y divide-mc-border/60 border border-mc-border rounded bg-mc-bg">
              {templates.map((template) => {
                if (editing === template.id) {
                  return <li key={template.id}>{form}</li>;
                }

                if (confirmDelete === template.id) {
                  return (
                    <li key={template.id} className="p-2.5 flex items-center gap-2 flex-wrap">
                      <span className="flex-1 min-w-0 text-[11px] text-mc-text font-sans">
                        Delete <span className="font-semibold font-mono">{template.name}</span>?
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(template.id)}
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
                        type="button"
                        onClick={closeForm}
                        disabled={isBusy}
                        className="px-2 py-1 rounded border border-mc-border text-mc-textMuted text-[10px] hover:text-mc-text disabled:opacity-50"
                      >
                        CANCEL
                      </button>
                      {error && <p className="w-full text-[10px] text-mc-danger font-sans">{error}</p>}
                    </li>
                  );
                }

                return (
                  <li key={template.id} className="p-2.5 flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-[11px] text-mc-text font-semibold">{template.name}</p>
                      <p className="text-[11px] text-mc-textMuted font-sans line-clamp-2 whitespace-pre-wrap" dir="auto">
                        {template.body}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(template)}
                      aria-label={`Edit template "${template.name}"`}
                      title={`Edit template "${template.name}"`}
                      className="p-1 rounded text-mc-textMuted hover:text-mc-live hover:bg-mc-surfaceHover shrink-0"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeForm();
                        setConfirmDelete(template.id);
                      }}
                      aria-label={`Delete template "${template.name}"`}
                      title={`Delete template "${template.name}"`}
                      className="p-1 rounded text-mc-textMuted hover:text-mc-danger hover:bg-mc-surfaceHover shrink-0"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-[10px] text-mc-textMuted font-sans">
            Quick replies are kept by Mission Control on this machine. Inserting one only fills the
            composer: the message still goes through the usual confirm step before it is sent.
          </p>
        </div>
      </div>
    </div>
  );
};
