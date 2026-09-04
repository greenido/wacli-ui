import React, { useState } from 'react';
import { X, LifeBuoy, Keyboard, BookOpen } from 'lucide-react';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { SHORTCUT_SECTIONS, resolveChord } from '../../lib/shortcuts.ts';

/** One key, drawn as a key. */
const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-block min-w-[1.4rem] text-center px-1.5 py-0.5 rounded border border-mc-border bg-mc-bg text-mc-text font-mono text-[10px] leading-none shadow-[0_1px_0_#2A2F3A]">
    {children}
  </kbd>
);

/** One chord: keys pressed together. */
const Chord: React.FC<{ keys: string[] }> = ({ keys }) => (
  <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
    {keys.map((key, i) => (
      <React.Fragment key={key + i}>
        {i > 0 && <span className="text-mc-textMuted/60 text-[10px]">+</span>}
        <Key>{key}</Key>
      </React.Fragment>
    ))}
  </span>
);

const Topic: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-1.5">
    <h3 className="font-mono text-[11px] tracking-wider uppercase text-mc-live font-semibold">
      {title}
    </h3>
    <div className="text-[12px] leading-relaxed text-mc-textMuted space-y-2">{children}</div>
  </section>
);

const Term: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className="font-mono text-[11px] text-mc-text bg-mc-bg border border-mc-border rounded px-1 py-0.5">
    {children}
  </code>
);

const GuideTab: React.FC = () => (
  <div className="space-y-5">
    <Topic title="What this is">
      <p>
        Mission Control is a local operator console for the{' '}
        <Term>wacli</Term> WhatsApp CLI. The browser talks to an Express API on
        this machine, which runs <Term>wacli</Term> against your own SQLite
        store. No account, no server, nothing uploaded — close the tab and it all
        stops.
      </p>
    </Topic>

    <Topic title="The three panes">
      <p>
        <span className="text-mc-text font-semibold">Left — chats.</span> Every
        conversation with unread counts, last-message previews and live{' '}
        <span className="italic">typing…</span> presence. The quick filters
        (All, Unread, Pinned, Muted, Archived) combine with your own tag row
        below them.
      </p>
      <p>
        <span className="text-mc-text font-semibold">Centre — the thread.</span>{' '}
        History oldest-to-newest with delivery ticks, inline media, and a hover
        menu on each bubble for reply, copy, bookmark and emoji reactions.
      </p>
      <p>
        <span className="text-mc-text font-semibold">Right — system status.</span>{' '}
        Sync daemon health and PID, the WebSocket link, store lock state, the
        audit log of everything you have sent, and the queue of scheduled
        messages.
      </p>
      <p>Drag either splitter to resize a rail; double-click one to reset it.</p>
    </Topic>

    <Topic title="Safe mode and live sends">
      <p>
        A fresh install starts locked: sends, replies, reactions and backfills
        are all refused until you unlock live sending. That choice then sticks
        across restarts — nothing re-imposes it behind your back.
      </p>
      <p>
        Every outgoing message passes a confirmation step showing the target JID,
        the payload and the quoted message when you are replying. A scheduled
        message that comes due while safe mode is on{' '}
        <span className="text-mc-safe">fails loudly</span> rather than going out:
        unlock, then reschedule it.
      </p>
    </Topic>

    <Topic title="Sending a message">
      <p>
        Pick a chat and type. <Key>Enter</Key> opens the confirmation;{' '}
        <Key>Shift</Key>+<Key>Enter</Key> adds a line instead. The paperclip
        attaches a file, and <span className="text-mc-text">LATER</span>{' '}
        schedules the message rather than sending it now — pending ones appear in
        a banner above the thread and in the Later tab on the right.
      </p>
      <p>
        Your draft, attachment and reply target belong to the conversation you
        started them in, so switching chats can never carry a half-written
        message into the wrong thread.
      </p>
    </Topic>

    <Topic title="Finding things">
      <p>
        The box at the top of the rail filters chats by name or JID.{' '}
        <Chord keys={resolveChord(['$mod', 'K'])} /> is different: it searches
        the full text of every message through SQLite&apos;s FTS5 index, and
        clicking a hit jumps straight to that message in its thread.
      </p>
    </Topic>

    <Topic title="When a thread runs out of history">
      <p>
        <span className="text-mc-text">LOAD OLDER MESSAGES</span> pages further
        back through what this machine already holds, and the header says how far
        back that reaches. Once local paging is exhausted,{' '}
        <span className="text-mc-text">REQUEST OLDER FROM PHONE</span> asks your
        primary device for more. That writes the local store, so safe read-only
        mode refuses it — and your phone answers on its own schedule.
      </p>
    </Topic>

    <Topic title="What is local and what is not">
      <p>
        <span className="text-mc-text font-semibold">Bookmarks and tags</span>{' '}
        are Mission Control&apos;s own and never leave this machine —{' '}
        <Term>wacli</Term> cannot set a WhatsApp star, and exposes no way to read
        a tag back. A <span className="text-mc-text font-semibold">star</span> on
        a message is the real thing, read from WhatsApp. An{' '}
        <span className="text-mc-text font-semibold">alias</span> is written to
        the wacli store, which is why safe mode refuses to change one.
      </p>
    </Topic>

    <Topic title="Notifications and exports">
      <p>
        Desktop notifications are off until you switch them on in Settings and
        the browser grants permission. They are raised locally from the
        WebSocket bridge — no push service is involved. Your own messages,
        reactions, muted chats and the conversation already on screen stay
        silent.
      </p>
      <p>
        <span className="text-mc-text">EXPORT</span> hands you the conversation
        as a readable transcript or as the full JSON <Term>wacli</Term> produced.
        The file itself says so in its header if the size cap truncated it.
      </p>
    </Topic>

    <Topic title="When something looks wrong">
      <p>
        Read the right rail first: daemon state and PID, the WebSocket dot, and
        the store lock. Settings holds{' '}
        <span className="text-mc-text">RESTART DAEMON</span> along with the store
        and log paths.
      </p>
      <p>
        If no chats ever load, the console will say which of the two causes it
        is: <Term>wacli</Term> is not installed (
        <Term>brew install stevemcquaid/wacli/wacli</Term>), or the account is
        not paired yet (<Term>wacli auth</Term>, then scan the QR code).
      </p>
    </Topic>
  </div>
);

const ShortcutsTab: React.FC = () => (
  <div className="space-y-5">
    {SHORTCUT_SECTIONS.map((section) => (
      <section key={section.title} className="space-y-2">
        <div className="space-y-1">
          <h3 className="font-mono text-[11px] tracking-wider uppercase text-mc-live font-semibold">
            {section.title}
          </h3>
          <p className="text-[11px] leading-relaxed text-mc-textMuted">{section.blurb}</p>
        </div>
        <ul className="rounded border border-mc-border divide-y divide-mc-border/50 overflow-hidden">
          {section.rows.map((row) => (
            <li
              key={row.action}
              className="flex items-baseline justify-between gap-4 px-3 py-2 bg-mc-bg/40"
            >
              <span className="flex flex-wrap items-center gap-1.5 shrink-0">
                {row.chords.map((chord, i) => (
                  <React.Fragment key={chord.join('+') + i}>
                    {i > 0 && <span className="text-mc-textMuted/50 text-[10px]">or</span>}
                    <Chord keys={resolveChord(chord)} />
                  </React.Fragment>
                ))}
              </span>
              <span className="text-[12px] text-mc-textMuted text-right">{row.action}</span>
            </li>
          ))}
        </ul>
      </section>
    ))}
  </div>
);

export const HelpModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const [tab, setTab] = useState<'guide' | 'keys'>('guide');

  const dialogRef = useModalDialog<HTMLDivElement>(activeModal === 'help', () =>
    setActiveModal(null)
  );

  if (activeModal !== 'help') return null;

  const tabs = [
    { id: 'guide' as const, label: 'USING MISSION CONTROL', icon: BookOpen },
    { id: 'keys' as const, label: 'KEYBOARD', icon: Keyboard },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh] font-sans"
      >
        {/* Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2
            id="help-title"
            className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-text"
          >
            <LifeBuoy size={16} className="text-mc-live" />
            <span>HELP</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close help"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-mc-border shrink-0" role="tablist">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 font-mono text-[11px] tracking-wider transition-colors border-b-2 ${
                tab === id
                  ? 'text-mc-live border-mc-live bg-mc-live/5'
                  : 'text-mc-textMuted border-transparent hover:text-mc-text hover:bg-mc-surfaceHover'
              }`}
            >
              <Icon size={13} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto">
          {tab === 'guide' ? <GuideTab /> : <ShortcutsTab />}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-mc-border text-[11px] font-mono text-mc-textMuted flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <Key>?</Key>
            <span>reopens this from anywhere outside a text box.</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <Key>Esc</Key>
            <span>closes.</span>
          </span>
        </div>
      </div>
    </div>
  );
};
