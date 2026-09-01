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
- **Your Choice Sticks**: Safe mode is a first-run default, not a recurring nag. Once you unlock live sends, that choice persists across restarts and is never silently re-imposed — and nothing but you can change it. Scheduled dispatches respect the lock rather than lifting it: a due message is held while safe mode is on and goes out once you unlock.
- **Two-Step Mutation Guardrails**: Every send, media dispatch, or reaction prompt passes through a `SendConfirmModal` confirmation step with target JID, payload preview, and explicit confirmation.
- **Sandboxed Media Access**: The media endpoint only streams files inside the wacli store, and never renders SVG inline.

### ⚡ Real-Time Ingestion & Process Supervision
- **Supervised `wacli sync --follow` Daemon**: The Node.js API manages the sync process lifecycle with automatic exponential backoff restarts and heartbeat liveness checks.
- **Zero-Polling Realtime Bridge**: Webhook events (`message`, `receipt`, `chat_presence`) are verified via HMAC-SHA256 and pushed instantly to the UI over WebSockets.
- **Lock Management**: Seamlessly coordinates store lock delegation between the running sync supervisor and one-shot write operations.

### 💬 Three-Pane Operator Console
- **Left Rail (Chat List)**:
  - Real-time unread counts, contact names, and phone numbers.
  - Live typing presence indicators (`typing...`).
  - Quick filters: `All`, `Unread`, `Pinned`, `Muted`, and `Archived`.
  - Filter search by contact name or JID.
- **Center Pane (Thread View & Composer)**:
  - Full conversation history with chronological sorting and auto-scroll.
  - Group sender attribution and system notices.
  - Delivery receipts (`sent`, `delivered`, `read`/`played`).
  - Starred message tracking and text copy to clipboard.
  - Interactive hover actions: quick reply, copy text, star/unstar, and emoji reactions.
  - **Expanded Emoji Reaction Drawer**: Categorized emoji picker (Smileys, Gestures, Hearts, Celebration), real-time search filter, quick reactions row, smart top/bottom viewport positioning, and boundary-aware alignment so popovers are never obscured by sidebars.
  - **Media Viewer**: Inline image rendering, waveform audio player, video playback, and document download.
  - **Fixed Composer**: Multi-line auto-expanding input, reply pill attachment, file upload preview, sticker toggle, and voice message simulation.
- **Right Rail (Status Strip & Audit Log)**:
  - WebSocket connection indicator and sync daemon PID / status.
  - Active store lock status and battery / network health telemetry.
  - Live outgoing send audit log tracking all dispatched actions with status badges.

### 🔍 Global Full-Text Search (`Cmd+K` / `Ctrl+K`)
- Instant cross-chat message search powered by SQLite FTS5.
- Displays matching message snippets, timestamp, sender, and target chat with one-click navigation.

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

| Shortcut | Action |
| :--- | :--- |
| <kbd>Cmd</kbd> + <kbd>K</kbd> / <kbd>Ctrl</kbd> + <kbd>K</kbd> | Open / close global message search |
| <kbd>Enter</kbd> | Send message from composer (when not multi-line) |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | Insert newline in composer |
| <kbd>Esc</kbd> | Close active modal, search palette, or emoji reaction drawer |

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
| `WACLI_LOG_WEBHOOK_PAYLOADS` | `0` | Set to `1` to log full inbound webhook payloads. Off by default so message bodies and contact details stay out of log files |
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
| `GET` | `/api/chats` | List chats with unread counts, filters (`unread`, `pinned`, `archived`) |
| `GET` | `/api/messages` | Fetch messages for a chat (`?chat=<jid>&limit=100`) |
| `POST`| `/api/messages/star` | Star or unstar a message (`{ chat, id, starred }`) |
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
