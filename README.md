# wacli Mission Control

A local, single-user operator console for [wacli](https://wacli.sh). Monitor incoming WhatsApp messages, search message history with FTS5, and send or reply to messages with safety guardrails from a clean browser UI.

## Features

- **Safe-by-default**: Starts with global read-only mode active. Mutating operations require explicit unlock and two-step confirmation.
- **Real-time Inbox**: Live incoming messages, delivery receipts, and typing indicators via `wacli sync --webhook` + WebSocket bridge.
- **Search**: Fast full-text search powered by wacli's SQLite FTS5 index.
- **Three-Pane Operator Console**: Dense, legible dark-mode UI designed around system state visibility (IBM Plex Mono + IBM Plex Sans).
- **Process Supervision**: Manages the `wacli sync --follow` daemon automatically with backoff restart and heartbeat liveness checks.

## Architecture

- **Backend (`apps/api`)**: Node.js, Express 5, `ws`, child process supervisor, HMAC-verified webhook listener.
- **Frontend (`apps/web`)**: React 19, Vite 7, TypeScript, Tailwind CSS v3, TanStack Query, Zustand.

## Getting Started

### Prerequisites

- Node.js 20+
- `wacli` installed and paired (`wacli auth`)

### Development

```bash
# Install dependencies
npm install

# Start both API (:3002) and Vite (:5174) concurrently
npm run dev
```

Open `http://127.0.0.1:5174` in your browser.
