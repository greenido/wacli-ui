# wacli Mission Control

A high-density, local-first operator console for [wacli](https://wacli.sh). Monitor incoming WhatsApp messages in real time, search historical messages with SQLite FTS5, preview media, schedule outgoing messages, and send or reply with safety guardrails from a clean dark-mode browser interface.

---

## Overview

[wacli](https://wacli.sh) is a scriptable, lightweight WhatsApp CLI built on `whatsmeow` that pairs as a linked WhatsApp Web device. It stores message history in a local SQLite database with FTS5 full-text indexing.

**wacli Mission Control** is the operator interface for `wacli`: a local, single-user browser console designed for speed, visibility, and safety. It combines a supervised background daemon, an HMAC-verified webhook ingestion pipeline, a real-time WebSocket event bridge, and a responsive 3-pane React UI.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            wacli Mission Control                             │
├───────────────────┬──────────────────────────────────────┬───────────────────┤
│    CHATS RAIL     │            THREAD VIEW               │   STATUS STRIP    │
│                   │                                      │                   │
│ • Unread Badges   │ • Delivery Ticks (Sent/Read)         │ • Daemon Health   │
│ • Presence Typing │ • Media Previews & Inline Audio      │ • Sync Progress   │
│ • Filter Tabs     │ • Reactions & Emoji Drawer Popover   │ • Process Uptime  │
│ • Pin / Mute /    │ • Reply Threading & Message Actions  │ • Real-time Send  │
│   Archive status  │ • Fixed Composer & "Send Later"      │   Audit Stream    │
└───────────────────┴──────────────────────────────────────┴───────────────────┘
```

---

## Core Features

### 🛡️ Safe-by-Default Architecture
- **Read-Only on First Run**: A fresh install starts locked — outgoing actions (sends, replies, emoji reactions, scheduled jobs) are all blocked until you explicitly unlock live sends.
- **Your Choice Sticks**: Safe mode is a first-run default, not a recurring nag. Once you unlock live sends, that choice persists across restarts and is never silently re-imposed — and nothing but you can change it. Scheduled dispatches respect the lock rather than lifting it: a message that comes due while safe mode is on **fails loudly** — marked failed with the reason, logged as an error, and shown in red in the scheduled list — rather than going out behind your back or sitting silently. Unlock live sends and reschedule it.
- **Two-Step Mutation Guardrails**: Every send, media dispatch, or reaction prompt passes through a `SendConfirmModal` confirmation step with target JID, payload preview, the quoted message when replying, and explicit confirmation.
- **Drafts Stay With Their Conversation**: The composer draft, attachment, and reply target are scoped to the chat they were started in, so switching chats can never carry a message — or a reply aimed at one thread — into another.
- **Bookmarks Are Local, And Say So**: wacli can read a WhatsApp star but has no command to set one, so Mission Control's bookmark is presented as its own local flag rather than pretending to reach your phone.
- **Tags Are Local, And Say So**: wacli can *write* a tag (`contacts tags add`) but exposes nothing that reads one back — no `tags list`, and no tag field on `contacts show`. Writing there would be a dead drop, so tags live in Mission Control's own file alongside bookmarks, are labelled that way in the UI, and keep working in safe read-only mode. An **alias** is the opposite: wacli stores and returns it, so it is written to the wacli store and safe mode refuses it.
- **Sandboxed Media Access**: The media endpoint only streams files inside the wacli store, and never renders SVG inline.
- **Exports Stay Local**: A conversation export runs `wacli messages export` and hands the file straight to your browser. Nothing is uploaded, and the file says in its own header when the size cap truncated it.
- **Notifications Stay Local**: Desktop notifications are raised in your own browser from the WebSocket bridge — no push service, no third party, nothing leaves the machine. They are off until you switch them on in Settings and the browser grants permission.

### ⚡ Real-Time Ingestion & Process Supervision
- **Supervised `wacli sync --follow` Daemon**: The Node.js API manages the sync process lifecycle with automatic exponential backoff restarts and heartbeat liveness checks.
- **Push-First Realtime Bridge**: Webhook events (`message`, `receipt`, `chat_presence`) are verified via HMAC-SHA256 and pushed instantly to the UI over WebSockets. Arriving messages are folded straight into the cached chat rail and thread, so the common case costs no request at all; polling stays on a slow timer as the safety net for whatever the socket misses.
- **Lock Management**: Seamlessly coordinates store lock delegation between the running sync supervisor and one-shot write operations.

### 💬 Three-Pane Operator Console
- **Left Rail (Chat List)**:
  - Real-time unread counts, contact names, and a preview of the last message (`You:` prefixed when it is yours, media described rather than left blank).
  - Live typing presence indicators (`typing...`).
  - Waiting count in the browser tab title, so a backgrounded console still says whether anything needs you.
  - Opt-in desktop notifications for incoming messages. Your own messages, reactions, muted chats, and the conversation already on screen stay silent; clicking one focuses the window and opens that chat.
  - Quick filters: `All`, `Unread`, `Pinned`, `Muted`, and `Archived`.
  - Filter search by contact name or JID, debounced so a word typed into the box costs one query rather than one per letter.
  - **Tag filter row**: narrow the rail to chats carrying one of your own labels. Combines with the quick filters rather than replacing them.
  - **Manage Tags**: rename or retire a label across every chat at once, from the button at the end of the tag row. Each row states how many chats it reaches, renaming onto an existing name asks before merging the two, and a delete is confirmed with its blast radius. A rail filtered on a tag that gets renamed follows it; one filtered on a tag that gets deleted clears instead of going blank.
- **Center Pane (Thread View & Composer)**:
  - Chronological history with auto-scroll, and a **Load Older Messages** control that pages further back through the local archive.
  - **Archive coverage** in the header (how far back this machine actually holds), so a thread that stops has an explanation rather than just an end.
  - **Request Older From Phone**: when local paging runs out, `wacli history backfill` asks your primary device for more. It writes the local store, so safe read-only mode refuses it.
  - **Export conversation** as a readable text transcript or as the full JSON wacli produced.
  - **Chat info panel**: contact metadata for a DM (phone, WhatsApp name, imported system contact, last sync) or group metadata for a group, plus alias and tag editing.
  - Group sender attribution and system notices.
  - Delivery receipts (`sent`, `delivered`, `read`/`played`).
  - WhatsApp stars shown as synced by wacli, plus local bookmarks and text copy to clipboard.
  - Interactive hover actions: quick reply, copy text, bookmark, and emoji reactions.
  - **Expanded Emoji Reaction Drawer**: Categorized emoji picker (Smileys, Gestures, Hearts, Celebration), real-time search filter, quick reactions row, smart top/bottom viewport positioning, and boundary-aware alignment so popovers are never obscured by sidebars.
  - **Media Viewer**: Inline image rendering, waveform audio player, video playback, and document download.
  - **Fixed Composer**: Multi-line auto-expanding input, reply pill attachment, file upload preview, sticker toggle, and voice message simulation.
- **Right Rail (Status Strip & Audit Log)**:
  - WebSocket connection indicator and sync daemon PID / status.
  - Active store lock status and battery / network health telemetry.
  - Live outgoing send audit log tracking all dispatched actions with status badges.

### 🔤 Right-to-Left Messages
- Hebrew and Arabic message bodies are laid out right-to-left, decided per message rather than per chat — so a thread that mixes scripts renders each line the way it was written, with punctuation at the end it belongs to.
- Applies everywhere a message body reaches the screen: thread bubbles, the rail preview, search results, the reply pill, the send-confirmation read-back, the Later queue, and the activity log. The console's own chrome — labels, timestamps, buttons — stays left-to-right.
- The composer flips as you type, so a Hebrew draft looks the way it will read once sent.

### 🔍 Global Full-Text Search (`Cmd+K` / `Ctrl+K`)
- Instant cross-chat message search powered by SQLite FTS5.
- Displays matching message snippets, timestamp, sender, and target chat with one-click navigation.

### ❓ Built-in Help (`?`)
- A **Help** panel reachable from the lifebuoy in the status strip header, or by pressing <kbd>?</kbd> anywhere outside a text box.
- **Using Mission Control**: what the console is, what each pane does, how safe mode and the confirmation step work, where history stops and how to reach past it, which flags are local and which reach WhatsApp, and what to check when something looks wrong.
- **Keyboard**: the whole shortcut table, rendered from the same catalogue the key handler dispatches from (`apps/web/src/lib/shortcuts.ts`), so a binding cannot drift away from its documentation.

### ⏱️ Send Later / Scheduled Messages
- Built-in in-memory scheduler for delayed messaging and replies.
- Dedicated chat banner displaying pending scheduled messages with one-click cancellation.

---

## Architecture & Data Flow

```
┌────────────────┐          HTTP (REST, JSON)          ┌────────────────┐   child_process.execFile   ┌──────────┐
│                │ ──────────────────────────────────► │  Express 5 API │ ─────────────────────────► │  wacli   │ (one-shot queries,
│   Browser UI   │ ◄────────────────────────────────── │  (Port :3002)  │ ◄───────────────────────── │  --json  │  WACLI_READONLY=1)
│  (React 19 +   │                                     └────────────────┘                            └──────────┘
│    Vite 7)     │                                       ▲            ▲
│                │        WebSocket (ws events)          │            │ stderr NDJSON (lifecycle)
│                │ ◄─────────────────────────────────────┤            │
└────────────────┘                                       │     ┌──────────────┐
                                             HTTP POST   │     │  wacli sync  │ (supervised daemon,
                                         (HMAC-SHA256)   └─────│  --follow    │  --webhook,
                                                               │  --events)   │  --events)
                                                               └──────────────┘
```

- **Backend (`apps/api`)**: Node.js 20+, Express 5, `ws`, child process supervisor, HMAC webhook listener, and SQLite FTS5 query runner.
- **Frontend (`apps/web`)**: React 19, TypeScript, Vite 7, Tailwind CSS v3, TanStack Query v5, Zustand, Lucide Icons, and date-fns.

---

## Quick Start

### Run with `npx` (No installation needed)

```bash
npx wacli-mission-control
```

### Global Install with `npm`

```bash
# Install globally
npm install -g wacli-mission-control

# Start Mission Control (opens http://127.0.0.1:3002)
wacli-mission-control

# Launch with options
wacli-mission-control --port 8080 --open
```

---

## Getting Started (From Source)

### Prerequisites

1. **Node.js**: `v20.0.0` or newer.
2. **wacli CLI**: Installed on your system and authenticated with your WhatsApp account.
   ```bash
   # Verify wacli installation
   wacli --version

   # Authenticate (scan QR code via WhatsApp on your phone)
   wacli auth
   ```

### Local Development Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/greenido/wacli-ui.git
cd wacli-ui
npm install
```

### Running in Development

Start both the API backend and Vite frontend concurrently:

```bash
npm run dev
```

The services will start at:
- **Web UI**: [http://127.0.0.1:5174](http://127.0.0.1:5174)
- **API Server**: [http://127.0.0.1:3002](http://127.0.0.1:3002)

### Building for Production

```bash
# Build both packages
npm run build

# Preview production build of the web app
npm run preview
```

---

## Keyboard Shortcuts

Press <kbd>?</kbd> in the app for this table in context. The console can be driven end to end without the mouse.

### Works anywhere

These carry a modifier, so they fire even mid-sentence in the composer. <kbd>Cmd</kbd> on macOS, <kbd>Ctrl</kbd> elsewhere.

| Shortcut | Action |
| :--- | :--- |
| <kbd>Cmd</kbd> + <kbd>K</kbd> | Open / close global message search |
| <kbd>Cmd</kbd> + <kbd>↓</kbd> / <kbd>Cmd</kbd> + <kbd>↑</kbd> | Next / previous chat in the rail |
| <kbd>Cmd</kbd> + <kbd>U</kbd> | Attach a file to this message |
| <kbd>Enter</kbd> | Send — opens the confirmation step |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | New line in the composer |
| <kbd>Cmd</kbd> + <kbd>Enter</kbd> | Send later — schedule this message |
| <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd> | Switch between SAFE (read-only) and LIVE sending — asks first |
| <kbd>Esc</kbd> | Close a dialog, clear the reply pill, or step out of the composer |

### Single keys — when you are not typing

The composer takes focus whenever you open a chat. <kbd>Esc</kbd> steps out of it and these come alive; <kbd>C</kbd> drops back in.

| Shortcut | Action |
| :--- | :--- |
| <kbd>?</kbd> | Open the help panel |
| <kbd>J</kbd> / <kbd>↓</kbd> | Next chat |
| <kbd>K</kbd> / <kbd>↑</kbd> | Previous chat |
| <kbd>1</kbd> … <kbd>5</kbd> | Rail filter: All · Unread · Pinned · Muted · Archived |
| <kbd>/</kbd> | Jump to the chat filter box |
| <kbd>C</kbd> | Back into the composer |
| <kbd>N</kbd> | Start a new chat |
| <kbd>,</kbd> | Settings & diagnostics |
| <kbd>R</kbd> | Reply to the newest incoming message |
| <kbd>I</kbd> | Chat info — contact, alias, and tags |
| <kbd>E</kbd> | Export this conversation |
| <kbd>O</kbd> | Load older messages |
| <kbd>G</kbd> | Jump to the newest message |

Unlocking live sends is the one guardrail a stray chord could drop, so <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd> opens a confirmation rather than flipping the switch.

---

## Configuration & Environment Variables

Create an optional `.env` file in `apps/api/.env` or specify environment variables when launching:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3002` | HTTP port for the Express API server |
| `HOST` | `127.0.0.1` | Loopback binding address |
| `WACLI_STORE_DIR` | Auto (`~/.wacli` or `~/.local/state/wacli`) | Path to the wacli SQLite data store |
| `WACLI_BIN` | `wacli` | Path or command name for the `wacli` binary |
| `WACLI_DISABLE_SYNC` | `0` | Set to `1` to run API without spawning `wacli sync --follow` |
| `WACLI_WEBHOOK_SECRET`| Auto-generated per session | HMAC secret used for internal webhook validation |
| `WACLI_SETTINGS_FILE` | `~/.wacli-mission-control/settings.json` | Where operator mode and store settings persist |
| `WACLI_SCHEDULED_FILE`| `~/.wacli-mission-control/scheduled.json` | Where scheduled messages persist |
| `WACLI_BOOKMARKS_FILE`| `~/.wacli-mission-control/bookmarks.json` | Where local message bookmarks persist |
| `WACLI_TAGS_FILE`| `~/.wacli-mission-control/tags.json` | Where local chat tags persist |
| `WACLI_LOG_WEBHOOK_PAYLOADS` | `0` | Set to `1` to log full inbound webhook payloads. Off by default so message bodies and contact details stay out of log files |
| `LOG` | `0` | Set to `1` to write `apps/api/logs/run-<timestamp>.log`. Off by default — events still mirror to the terminal |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` or `ERROR`. `DEBUG` adds per-command timings, subprocess failures and wacli's own stderr |
| `NO_COLOR` | unset | Set to any value to disable ANSI colour in terminal log output |
| `VITE_API_URL` | `http://127.0.0.1:3002` | API base URL configured in `apps/web` |

---

## REST API Reference

All REST endpoints require requests originating from `localhost` / `127.0.0.1`.

### Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Service health, daemon state, uptime, and lock status |
| `GET` | `/api/settings` | Current read-only mode state and session metadata |
| `POST`| `/api/mode` | Update read-only / write mode (`{ readOnly: boolean }`) |
| `GET` | `/api/chats` | List chats with unread counts, last-message previews, filters (`unread`, `pinned`, `archived`) |
| `GET` | `/api/messages` | Fetch messages for a chat (`?chat=<jid>&limit=100`); raise `limit` to page further back |
| `POST`| `/api/messages/bookmark` | Add or remove a local bookmark (`{ chat, id, bookmarked }`) |
| `GET` | `/api/messages/export` | Export a conversation (`?chat=<jid>&limit=1000`); answers `truncated` when the cap was hit |
| `GET` | `/api/history/coverage` | How far back the local archive reaches (`?chat=<jid>`, or every chat when omitted) |
| `GET` | `/api/contacts/show` | One contact's local metadata and tags (`?jid=<jid>`) |
| `POST`| `/api/contacts/alias` | Set or clear wacli's local alias (`{ jid, alias }`); refused in read-only mode |
| `GET` | `/api/groups` | Local group metadata (`?query=`) |
| `GET` | `/api/tags` | Every local tag in use, and which chats carry them |
| `POST`| `/api/tags` | Add or remove a local tag (`{ jid, tag, add }`); allowed in read-only mode |
| `POST`| `/api/tags/rename` | Rename a local tag on every chat carrying it (`{ from, to }`); merges when `to` already exists |
| `POST`| `/api/tags/delete` | Drop a local tag from every chat carrying it (`{ tag }`) |
| `POST`| `/api/history/backfill` | Ask the primary device for older messages (`{ chat, count? }`); refused in read-only mode |
| `GET` | `/api/search` | Search message history with FTS5 (`?q=<query>&limit=50`) |
| `POST`| `/api/send/text` | Send a text message or reply (`{ to, message, replyTo?, confirm: true }`) |
| `POST`| `/api/send/media` | Upload and dispatch media (`multipart/form-data`) |
| `POST`| `/api/send/react` | Send an emoji reaction (`{ to, id, reaction, sender?, confirm: true }`) |
| `POST`| `/api/send/schedule` | Schedule a future message (`{ to, message, scheduledAt, confirm: true }`) |
| `GET` | `/api/send/scheduled` | List pending scheduled messages |
| `DELETE`| `/api/send/scheduled/:id` | Cancel a pending scheduled message |
| `GET` | `/api/media/:chat/:id` | Retrieve or proxy media content for inline rendering |
| `POST`| `/internal/wacli/webhook`| Internal HMAC-verified webhook endpoint for `wacli sync` |

### WebSocket Event Stream

Connect to `ws://127.0.0.1:3002/ws` to receive live unified event frames:

```json
{
  "type": "message.created",
  "data": {
    "msgId": "3EB0...",
    "chatJid": "1234567890@s.whatsapp.net",
    "senderJid": "1234567890@s.whatsapp.net",
    "fromMe": false,
    "text": "Hello world!",
    "ts": "2026-08-31T17:00:00.000Z"
  },
  "ts": "2026-08-31T17:00:00.050Z"
}
```

Supported event types: `message.created`, `receipt.updated`, `presence.updated`, `sync.progress`, `connection.status`, `audit.event`, `error`.

---

## Security & Privacy

- **Strict Local Loopback**: Both API and Web servers bind exclusively to `127.0.0.1`. Requests with foreign `Host` headers are rejected with `403 Forbidden`.
- **CORS Restricted**: Browser cross-origin requests are limited strictly to loopback origins.
- **HMAC Webhook Signatures**: Webhook payloads dispatched by the supervised sync process are cryptographically signed with `HMAC-SHA256`.
- **Zero Cloud Relay**: Message data is never transmitted to external servers. All operations execute directly against your local `wacli` installation.
- **Run Logs Expire**: When `LOG=1`, each run writes `apps/api/logs/run-<timestamp>.log`. On startup the API deletes run logs older than **3 days**, so diagnostic output — which carries chat JIDs, and message bodies if `WACLI_LOG_WEBHOOK_PAYLOADS=1` — does not accumulate on disk indefinitely. Only files matching that name are removed; anything else in the directory is left alone. Without `LOG=1`, nothing is written to disk.

---

## Reading the Logs

Events always mirror to the terminal. Disk files are opt-in: start with `LOG=1` to also write `apps/api/logs/run-<timestamp>.log`. Each line is one event, in a fixed shape:

```
[2026-09-04T20:20:25.976Z] [INFO] [http] GET /chats status=200 durationMs=155 query="limit=100&archived=false"
[2026-09-04T20:20:23.203Z] [WARN] [process] Sync daemon exited reason="exited with code 1" code=1 signal=null
```

The message is constant for a given event and the details live in trailing `key=value` fields, which is what makes the file worth grepping:

```bash
grep 'durationMs=[0-9]\{4,\}' apps/api/logs/run-*.log
```

- **Categories** — `http` (one line per API call), `api`, `process` (the sync daemon), `ws`, `webhook`, `send`, `media`, `automation`.
- **Levels** — `WARN` and above go to stderr, the rest to stdout. `ERROR` is a real failure; a routine outcome like media that expired on WhatsApp's servers is `DEBUG`, not an incident.
- **Timings** — anything the operator waits on carries `durationMs`. A `wacli` command over 1s or a request over 1.5s is promoted to `WARN` on its own, so "it feels slow" becomes a line you can find.
- **`LOG_LEVEL=DEBUG`** — adds per-command timings, the wacli invocation behind each failure, and wacli's own stderr. Start here when a read returns something you did not expect.
- **Repeats collapse** — a warning that fires once per attachment in a thread is logged once and then tallied (`... (repeated 24x more)`) rather than copied down the page. Only `WARN` and `ERROR` collapse; routine lines keep every occurrence, because their fields differ.

Secrets are kept out: the daemon's spawn line prints `--webhook-secret <redacted>`, and message bodies stay out of the file unless `WACLI_LOG_WEBHOOK_PAYLOADS=1`.

---

## Quality & Verification

Run the full linting, type-checking, and test suite:

```bash
# Run tests across both the API and web workspaces
npm test

# Run only one workspace's tests
npm run test -w @wacli/api
npm run test -w @wacli/web

# Run TypeScript compilation checks
npm run typecheck

# Run ESLint validation
npm run lint

# Run all checks at once
npm run verify
```

---
## How to Release a New Version

To trigger a release and publish to npm:

``` 
# 1. Bump version and tag (e.g., v0.1.0)
git tag v0.1.0

# 2. Push tag to GitHub
git push origin v0.1.0
```

Once published, users can run:

```bash
# Direct run without installing
npx wacli-mission-control

# Or install globally
npm install -g wacli-mission-control
wacli-mission-control --open
```

---
## License

MIT © [wacli Mission Control Contributors](LICENSE)
