import React from 'react';
import { X, ShieldCheck, ShieldAlert, Database, FileText, CheckCircle2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';

export const SettingsModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const modeMutation = useMutation({
    mutationFn: (newReadOnly: boolean) => api.setMode(newReadOnly),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (activeModal !== 'settings') return null;

  const isReadOnly = settings?.readOnly ?? true;
  const doctor = health?.doctor;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-xl flex flex-col max-h-[85vh] font-sans text-xs">
        {/* Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <div className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-text">
            <span>SETTINGS & DIAGNOSTICS</span>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5 overflow-y-auto font-mono">
          {/* Read-Only Safety Toggle */}
          <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-mc-text flex items-center gap-2">
                {isReadOnly ? <ShieldCheck size={16} className="text-mc-safe" /> : <ShieldAlert size={16} className="text-mc-live" />}
                OPERATOR MODE
              </span>
              <button
                onClick={() => modeMutation.mutate(!isReadOnly)}
                disabled={modeMutation.isPending}
                className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                  isReadOnly
                    ? 'bg-mc-safe/20 text-mc-safe border border-mc-safe/60 hover:bg-mc-safe/30'
                    : 'bg-mc-live/20 text-mc-live border border-mc-live/60 hover:bg-mc-live/30'
                }`}
              >
                {isReadOnly ? 'UNLOCK WRITE (LIVE)' : 'LOCK (SAFE MODE)'}
              </button>
            </div>
            <p className="text-[11px] text-mc-textMuted font-sans">
              {isReadOnly
                ? 'Safe mode prevents all outgoing message sends, replies, and reactions.'
                : 'Live mode active: outbound commands are allowed with modal confirmation.'}
            </p>
          </div>

          {/* Doctor Status */}
          {doctor && (
            <div className="space-y-2">
              <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold">
                wacli doctor diagnostics
              </div>
              <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Session Pairing:</span>
                  <span className={doctor.authenticated ? 'text-mc-live flex items-center gap-1' : 'text-mc-danger'}>
                    {doctor.authenticated ? <CheckCircle2 size={12} /> : null}
                    {doctor.authenticated ? 'Authenticated' : 'Not Paired'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Linked JID:</span>
                  <span className="text-mc-text truncate max-w-[280px]">{doctor.linkedJid ?? 'None'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">FTS5 Search:</span>
                  <span className={doctor.ftsEnabled ? 'text-mc-live' : 'text-mc-danger'}>
                    {doctor.ftsEnabled ? 'Active (Ready)' : 'Disabled'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Store Messages:</span>
                  <span className="text-mc-text">{doctor.store.messages.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Store Chats:</span>
                  <span className="text-mc-text">{doctor.store.chats.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Paths & Logs */}
          <div className="space-y-2">
            <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold">
              Storage & Logging
            </div>
            <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-mc-textMuted flex items-center gap-1 shrink-0">
                  <Database size={12} /> Store Path:
                </span>
                <span className="text-mc-text break-all text-right">{doctor?.storeDir || '~/.wacli'}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-mc-textMuted flex items-center gap-1 shrink-0">
                  <FileText size={12} /> Current Log:
                </span>
                <span className="text-mc-text break-all text-right">{settings?.currentLogFile || 'apps/api/logs/'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
