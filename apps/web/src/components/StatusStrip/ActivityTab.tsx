import React from 'react';
import { detectTextDirection } from '../../lib/textDirection.ts';
import type { SendLogEntry } from '../../types.ts';

interface ActivityTabProps {
  rows: SendLogEntry[];
  isPending: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sentinelRef: React.Ref<HTMLDivElement>;
  selectedJid: string | undefined;
  onOpen: (log: SendLogEntry) => void;
}

/** ACTIVITY: every send on record, newest first. */
export const ActivityTab: React.FC<ActivityTabProps> = ({
  rows,
  isPending,
  hasNextPage,
  isFetchingNextPage,
  sentinelRef,
  selectedJid,
  onOpen,
}) => (
  <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
    {rows.length === 0 ? (
      <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
        {isPending ? 'Loading activity…' : 'No outbound sends on record.'}
      </div>
    ) : (
      <>
        {rows.map((log) => {
          const isSelected = selectedJid === log.to;
          const isFailedSend = log.status === 'error';
          return (
            <div
              key={log.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(log)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(log);
                }
              }}
              className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-accent/60 hover:bg-mc-surfaceHover/80 ${
                isSelected
                  ? 'border-mc-accent/60 bg-mc-surfaceHover/50 ring-1 ring-mc-accent/30'
                  : isFailedSend
                  ? 'border-mc-danger/50'
                  : 'border-mc-border/70'
              }`}
              title={
                isFailedSend
                  ? 'Not delivered. Click to load this message into the composer so you can retry in the composer.'
                  : 'Click to open the conversation and focus this message'
              }
            >
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-mc-textMuted">
                  {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span
                  className={`font-semibold uppercase ${
                    log.status === 'success'
                      ? 'text-mc-live'
                      : log.status === 'pending'
                      ? 'text-mc-safe'
                      : 'text-mc-danger'
                  }`}
                >
                  {log.status}
                </span>
              </div>
              <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                <span className="truncate">{log.chatName || log.to}</span>
                <span
                  className={`text-[9px] font-mono opacity-80 shrink-0 ${
                    isFailedSend ? 'text-mc-danger' : 'text-mc-live'
                  }`}
                >
                  {isFailedSend ? 'RETRY →' : 'OPEN →'}
                </span>
              </div>
              <div
                dir={detectTextDirection(log.message)}
                className="text-mc-textMuted truncate text-start"
              >
                {log.message}
              </div>
              {log.error && (
                <div className="text-[10px] text-mc-danger truncate">{log.error}</div>
              )}
            </div>
          );
        })}
        {hasNextPage && (
          // The sentinel is the paging control: scrolling to it asks for
          // the next page. It stays visible while that page loads so the
          // list does not jump as rows arrive underneath the scroll.
          <div
            ref={sentinelRef}
            className="py-2 text-center text-[10px] font-mono text-mc-textMuted/70"
          >
            {isFetchingNextPage ? 'loading more…' : 'scroll for more'}
          </div>
        )}
      </>
    )}
  </div>
);
