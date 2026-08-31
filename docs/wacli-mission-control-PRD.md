# PRD: wacli Mission Control
## 1. Overview

wacli (https://wacli.sh) is a script-friendly WhatsApp CLI built on `whatsmeow`. It pairs as a
linked WhatsApp Web device, mirrors messages into a local SQLite store with FTS5 search, and
exposes `send`, `media`, `contacts`, `chats`, and `groups` commands. Its own docs explicitly list
**"a daemon, MCP server, or web UI"** as out of scope for the CLI itself.

**wacli Mission Control** is that web UI: a local, single-user browser console that wraps wacli to
let you monitor your WhatsApp inbox and send/reply to messages without touching a terminal, with
a clear runway toward automation later.

This sibling project follows the monorepo pattern of `wacrawl-ui` (Express API + React/Vite
web app, localhost-only, CORS-restricted), but wraps a **live, write-capable** tool instead of a
read-only archive.

## 2. Goals

1. Send and reply to WhatsApp messages from a browser tab safely.
2. Monitor incoming messages and chat activity in near-real-time.
3. Preserve wacli's existing safety posture (`--read-only` / `WACLI_READONLY=1`) as a first-class,
   always-visible UI control and default backend posture.
4. Lay groundwork (event schema, process management, audit log) that automation rules can build on
   in a later phase, without over-building it now.

## 3. Non-Goals (for this PRD / MVP)

- No cloud hosting, multi-user auth, or remote access. Localhost only (see §5).
- No automation/auto-reply engine (P1/P2 — see §7.4).
- No multi-account switching (P2 — see §7.5).
- No re-implementation of WhatsApp Web itself — all protocol handling stays inside wacli.
- Not trying to replace WhatsApp Desktop; this is a lightweight operator console, not a full social client.

## 4. Users & Context

- Single local user, running on their own machine.
- wacli is assumed to already be installed and paired (`wacli auth` run once via terminal).
- Access is `http://127.0.0.1:<port>` only. No public network exposure by default.

## 5. Assumptions & Dependencies

- wacli binary is on `$PATH` and its store is reachable (default `~/.local/state/wacli` on Linux,
  `~/.wacli` elsewhere; overridable via `--store` / `WACLI_STORE_DIR`).
- Node.js 20+, matching `wacrawl-ui`.
- wacli manages its own per-store lock; when `sync --follow` holds the lock, wacli **delegates**
  supported send commands (`send text`, `send file`, `send sticker`, `send voice`, `send react`, `messages edit`)
  to the running sync process automatically. Commands requiring exclusive store lock access
  (such as `chats archive/pin/mute/mark-read` or `auth`) are managed via supervised pause/resume.
- WhatsApp Web is an unofficial protocol (via `whatsmeow`). The UI surfaces connection/session errors.

## 6. System Architecture

### 6.1 Tech stack

Matches `wacrawl-ui` conventions:

- **Backend:** Node.js + TypeScript, Express 5, `ws` for WebSocket
- **Frontend:** React 19 + Vite 7, TypeScript, TanStack Query, Zustand
- **Realtime transport:** Webhook listener (`POST /internal/wacli/webhook` with HMAC signature) + `wacli sync --events` stderr parser re-broadcasted over WebSocket (`ws`)
- **Styling:** Tailwind CSS v3, built against the token system in §6.4

### 6.2 High-level data flow

```
┌────────────┐        HTTP (REST, JSON)        ┌────────────┐   child_process   ┌──────┐
│  Browser   │ ──────────────────────────────► │  Express   │ ────────────────► │ wacli │  (one-shot,
│  (React)   │ ◄────────────────────────────── │  API       │ ◄──────────────── │ --json│   e.g. chats,
└────────────┘                                 └────────────┘                   └──────┘   messages, send)
      ▲                                         ▲          ▲
      │                                         │          │
      │        WebSocket (live unified events)  │          │ stderr NDJSON (lifecycle)
      │ ◄───────────────────────────────────────┤          │
      │                                         │   ┌──────────────┐
      │                                         └───│  wacli sync  │  (long-running,
      │                                 HTTP POST   │  --follow    │   --webhook,
      │                             (HMAC-SHA256)   │  --events)   │   --events)
      │                                             └──────────────┘
```

- **One-shot commands** (chats list, messages search/list, doctor) run as short-lived
  `child_process.execFile` calls with `--json`. By default, read-only environment `WACLI_READONLY=1` is injected into child executions unless an explicit confirmed write action is taken.
- **One long-running supervised process** (`wacli sync --follow --events --webhook ... --webhook-allow-private --webhook-events message,receipt,chat_presence`) is spawned and supervised by the API server (auto-restart with exponential backoff on crash, clean halt on `logged_out`).
- **Live updates** are ingested from two streams:
  1. Internal webhook endpoint receiving live message, delivery/read receipt, and chat presence payloads.
  2. Stderr NDJSON stream receiving connection lifecycle events (`connected`, `stale`, `logged_out`, sync progress).
- Both streams are normalized into a single WebSocket event format broadcasted to connected browser clients.

### 6.3 Repo structure

```
wacli-ui/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── wacli/
│   │   │   │   ├── process-manager.ts   # supervises `sync --follow` with pause/resume
│   │   │   │   ├── commands.ts          # one-shot --json command wrapper (WACLI_READONLY=1 by default)
│   │   │   │   ├── normalize.ts         # converts snake/Pascal/webhook casing to camelCase domain models
│   │   │   │   ├── types.ts             # unified domain types
│   │   │   │   └── mode.ts              # sticky read-only / live mode state
│   │   │   ├── routes/
│   │   │   │   ├── chats.ts
│   │   │   │   ├── messages.ts
│   │   │   │   ├── search.ts
│   │   │   │   ├── send.ts
│   │   │   │   ├── settings.ts
│   │   │   │   ├── health.ts
│   │   │   │   └── webhook.ts           # internal HMAC-verified webhook handler
│   │   │   ├── ws/
│   │   │   │   └── event-bridge.ts      # WebSocket server & client broadcaster
│   │   │   ├── logger.ts                # plain-text run logger
│   │   │   └── index.ts                 # Express bootstrap & loopback server
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/
│       ├── src/
│       │   ├── api/
│       │   │   └── client.ts            # REST client with typed error handling
│       │   ├── components/
│       │   │   ├── ChatList/            # left rail with unread counts, search & filter
│       │   │   ├── ThreadView/          # center conversation pane with reaction folding
│       │   │   ├── Composer/            # bottom composer with reply-to and media attach
│       │   │   ├── SendConfirmModal/    # mandatory confirmation modal before sending
│       │   │   ├── ReadOnlyBanner/      # persistent amber banner when in safe mode
│       │   │   ├── StatusStrip/         # right-hand persistent status strip
│       │   │   └── SettingsModal/       # mode toggle, store info, health check
│       │   ├── hooks/
│       │   │   ├── useWebSocket.ts
│       │   │   ├── useChats.ts
│       │   │   └── useMessages.ts
│       │   ├── store/
│       │   │   └── appStore.ts          # UI state (selected chat, draft, presence)
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   └── index.css
│       ├── package.json
│       ├── tailwind.config.ts
│       └── vite.config.ts
├── docs/
│   └── wacli-mission-control-PRD.md
├── .github/workflows/build.yml
├── eslint.config.mjs
├── tsconfig.base.json
├── package.json                         # workspace root
└── README.md
```

### 6.4 Visual Design Direction

**Color** (base neutrals + functional signal colors):
- Background: `#12151B` (deep slate)
- Surface/panel: `#1B1F27`
- Border/hairline: `#2A2F3A`
- Text primary: `#E7E9EE`
- Text secondary: `#8A93A3`
- Signal — live/sendable: `#4FD1A5` (cool mint-teal)
- Signal — read-only/safe mode: `#E8B96A` (warm amber)
- Signal — error/disconnected: `#E8637A` (soft coral)

Signal colors appear **only** on connection/mode indicators, the read-only banner, and send-state
feedback.

**Type:**
- IBM Plex Mono — chrome: timestamps, mode badges, chat counts, JIDs/phone numbers
- IBM Plex Sans — prose: message content, settings copy, empty states

**Layout:** three-pane operator console:
```
┌───────────┬─────────────────────────────┬───────────┐
│ Chat list │        Thread view          │  Status   │
│  (rail)   │   (dominant, center)        │  strip    │
│           │                             │ (mode,    │
│           │  ─────────────────────────  │ connection│
│           │      composer (fixed)       │  send log)│
└───────────┴─────────────────────────────┴───────────┘
```

## 7. Functional Requirements

### 7.1 Foundation

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-FD-1 | Supervise `wacli sync --follow --events --webhook`; backoff on crash, terminal on `logged_out` | P0 | Planned M0 |
| FR-FD-2 | Wrap one-shot wacli commands with `--json` and typed normalization | P0 | Planned M0 |
| FR-FD-3 | Global read-only mode toggle (`WACLI_READONLY=1` on write commands), defaults ON | P0 | Planned M0 |
| FR-FD-4 | Settings: store path, pairing status, mode toggle | P0 | Planned M0 |
| FR-FD-5 | Health check backed by `wacli doctor --json` + process status + heartbeat age | P0 | Planned M0 |
| FR-FD-6 | In-browser QR pairing flow (`wacli auth`) via supervised pause/resume | P1 | Planned M4 |

### 7.2 Send & Reply

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-SR-1 | Compose and send text message to resolved recipient JID | P0 | Planned M2 |
| FR-SR-2 | Recipient picker (search by name/number, backed by `chats list --query`) resolving to canonical JID | P0 | Planned M2 |
| FR-SR-3 | Confirmation modal showing recipient name + JID + full message before send | P0 | Planned M2 |
| FR-SR-4 | Reply-to / quote a specific message (`--reply-to`) on send | P0 | Planned M2 |
| FR-SR-5 | Send file/media attachment (`send file`) with multipart upload (100 MiB cap) | P0 | Planned M2 |
| FR-SR-7 | Emoji reactions on messages (`send react`) & fold incoming reaction rows | P0/P1 | Planned M1/M2 |
| FR-SR-10 | Send activity log — UI-originated sends recorded in run log | P0 | Planned M0/M2 |
| FR-SR-11 | Delivery & read receipt indicators via webhook receipt events | P0 | Planned M3 |

### 7.3 Real-time Inbox / Monitoring

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-IM-1 | Live incoming message feed via webhook -> WebSocket bridge | P0 | Planned M3 |
| FR-IM-2 | Chat list with unread counts & status badges (`chats list`) | P0 | Planned M1 |
| FR-IM-3 | Conversation thread view with keyset pagination (`--before`) | P0 | Planned M1 |
| FR-IM-4 | Full-text search across messages (FTS5 via `messages search`) | P0 | Planned M1 |
| FR-IM-5 | Chat state actions: archive / pin / mute / mark-read via supervised pause/resume | P1 | Planned M4 |
| FR-IM-8 | Browser/desktop notifications on incoming messages | P1 | Planned M4 |
| FR-IM-10 | Live typing presence indicators via webhook `chat_presence` | P0 | Planned M3 |

### 7.4 Automation Rules (P1/P2)

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-AU-1 | Keyword trigger auto-reply | P1 | Deferred M5 |
| FR-AU-2 | Rate-limit/throttle guard | P1 | Deferred M5 |
| FR-AU-3 | Automation audit log | P1 | Deferred M5 |
| FR-AU-4 | Rule builder UI | P1 | Deferred M5 |

## 8. API Specification

All endpoints run under `http://127.0.0.1:3002/api` (except internal webhook at `/internal/wacli/webhook`). Mutating POST requests require `X-Mission-Control-Request: 1` header.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `wacli doctor --json` status, process status, heartbeat timestamp |
| GET | `/api/mode` | Current mode `{ readOnly: boolean }` |
| POST | `/api/mode` | Set mode `{ readOnly: boolean }` |
| GET | `/api/chats` | Query params: `query`, `limit`, `archived`, `pinned`, `muted`, `unread` |
| GET | `/api/messages` | Query params: `chat` (JID), `limit`, `before` (timestamp), `after` |
| GET | `/api/search` | Query params: `q`, `chat`, `limit`, `after`, `before`, `type` |
| POST | `/api/send/text` | Body: `{ to: string, message: string, replyTo?: string, confirm: true }` |
| POST | `/api/send/file` | Multipart: `file`, `to`, `caption?`, `replyTo?`, `confirm: "true"` |
| POST | `/api/send/react` | Body: `{ to: string, id: string, reaction: string, sender?: string, confirm: true }` |
| GET | `/api/settings` | Store path, account, mode, log files |
| POST | `/internal/wacli/webhook` | Receives live events from `wacli sync --webhook` verified with HMAC |

## 9. WebSocket Event Schema

Broadcasted over `ws://127.0.0.1:3002/ws`:

```ts
export type MissionControlEvent =
  | { type: "message.new"; data: UnifiedMessage; ts: string }
  | { type: "message.receipt"; data: { chatJid: string; messageIds: string[]; status: "delivered" | "read" | "played"; sender: string; isFromMe: boolean }; ts: string }
  | { type: "chat.presence"; data: { chatJid: string; senderJid: string; state: "composing" | "paused"; media: "audio" | "" }; ts: string }
  | { type: "chat.update"; data: UnifiedChat; ts: string }
  | { type: "sync.progress"; data: { phase: string; detail?: string }; ts: string }
  | { type: "connection.status"; data: { state: "connected" | "disconnected" | "reconnecting" | "paused" | "logged_out" | "failed"; reason?: string }; ts: string };
```

## 10. Safety & Guardrails

1. **Read-only by Default**: When launched, read-only mode is active until explicitly unlocked by the user in the UI.
2. **Double-Guard on Mutation**: Sending requires both UI confirmation modal and backend `confirm: true` + `X-Mission-Control-Request: 1` header.
3. **Canonical Recipient Resolution**: Sends are dispatched only to fully qualified JIDs (e.g. `15551234567@s.whatsapp.net` or `...@g.us`), never ambiguous names.
4. **Isolated Process Space**: Sync process runs with dedicated arguments and loopback-only webhook forwarding.
5. **Plain-Text Audit Log**: Every outbound send, process state change, and webhook event is written to `apps/api/logs/run-<timestamp>.log`.
