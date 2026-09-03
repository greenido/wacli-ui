import React, { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import {
  downloadFile,
  exportFileName,
  formatExportJson,
  formatTranscript,
} from '../../lib/conversationExport.ts';
import type { ConversationExport } from '../../types.ts';

type ExportFormat = 'transcript' | 'json';

interface ExportMenuProps {
  chatJid: string;
  chatName: string;
}

const NOTICE_TTL_MS = 8000;

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'transcript', label: 'Text transcript', hint: 'Readable, oldest first' },
  { id: 'json', label: 'JSON', hint: 'Every field wacli exported' },
];

/**
 * Exporting is a read: it runs `wacli messages export` and hands the result
 * straight to the browser. Nothing is uploaded, and safe read-only mode has no
 * reason to block it.
 */
export const ExportMenu: React.FC<ExportMenuProps> = ({ chatJid, chatName }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const exportMutation = useMutation({
    mutationFn: async (format: ExportFormat) => {
      const data = await api.exportConversation({ chat: chatJid });
      return { format, data };
    },
    onSuccess: ({ format, data }: { format: ExportFormat; data: ConversationExport }) => {
      const isJson = format === 'json';
      const ok = downloadFile(
        exportFileName(chatName, chatJid, isJson ? 'json' : 'txt'),
        isJson ? 'application/json' : 'text/plain;charset=utf-8',
        isJson ? formatExportJson(data) : formatTranscript(data)
      );
      setError(ok ? null : 'The browser refused the download.');
      setTruncated(data.truncated);
      setIsOpen(false);
    },
    onError: (err: Error) => {
      setError(err.message);
      setIsOpen(false);
    },
  });

  // The notice has said its piece by the time the file is open; it should not
  // still be hanging over the header ten minutes later.
  useEffect(() => {
    if (!error && !truncated) return;
    const timer = setTimeout(() => {
      setError(null);
      setTruncated(false);
    }, NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [error, truncated]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        onClick={() => {
          setError(null);
          setIsOpen((prev) => !prev);
        }}
        disabled={exportMutation.isPending}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="Export this conversation"
        className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-wait"
      >
        {exportMutation.isPending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Download size={12} />
        )}
        <span>EXPORT</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 w-56 bg-mc-surface border border-mc-border rounded shadow-2xl overflow-hidden"
        >
          {FORMATS.map((format) => (
            <button
              key={format.id}
              role="menuitem"
              onClick={() => exportMutation.mutate(format.id)}
              className="w-full text-left px-3 py-2 hover:bg-mc-surfaceHover transition-colors border-b border-mc-border/40 last:border-b-0"
            >
              <div className="text-xs text-mc-text font-mono">{format.label}</div>
              <div className="text-[10px] text-mc-textMuted font-sans">{format.hint}</div>
            </button>
          ))}
        </div>
      )}

      {(error || truncated) && (
        <div
          role="status"
          className={`absolute right-0 top-full mt-1 z-30 w-64 px-2 py-1.5 rounded border text-[10px] font-mono ${
            error
              ? 'bg-mc-surface border-mc-danger/50 text-mc-danger'
              : 'bg-mc-surface border-mc-safe/50 text-mc-safe'
          }`}
        >
          {error ?? 'Export hit the size cap — it holds the most recent messages, not the whole conversation.'}
        </div>
      )}
    </div>
  );
};
