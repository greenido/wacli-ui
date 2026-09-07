# Code review findings — September 2026

A full read of the API and web app, covering what the test suite does not: cross-cutting
behaviour, shutdown paths, security boundaries, and the places where the console's own
safety controls disagree with each other.

Baseline at the time of review was healthy — `npm run verify` passed clean, 520 tests
green, no `any`, no `innerHTML`, no `TODO` in source. Everything below is a gap the
suite did not cover.

Items marked **verified** were reproduced by running the code, not just read.

Numbering is the original review's, kept stable so commits and PRs can cite it. Items 3
and 4 were reviewed and accepted as intended behaviour; they are recorded at the bottom
rather than renumbered away.

---

## P0 — fix first

### 1. Any web page can read the live message feed over `/ws` — **verified**

`apps/api/src/ws/event-bridge.ts` — `WebSocketServer` is constructed with no origin
check. WebSocket upgrades are not subject to the same-origin policy, so the CORS
configuration that protects `/api` does not extend to `/ws`.

Reproduced against a running server:

```
WS upgrade with Origin: https://evil.example  ->  ACCEPTED
data pushed to the cross-origin listener: {"type":"connection.status",...}
REST GET /api/mode, same Origin  ->  HTTP 500, no Access-Control-Allow-Origin
```

The REST side behaves correctly; the socket does not. Any page open in the operator's
browser while Mission Control is running can connect and silently receive every incoming
message body, sender JID, and receipt.

Fix: reject non-loopback origins at the upgrade, reusing `isLoopbackOrigin`.

### 2. Shutdown hangs whenever a browser tab is open — **verified**

`apps/api/src/index.ts` — `gracefulShutdown` calls `server.close()` but never
`eventBridge.close()` or `scheduler.stop()`. `server.close()` waits for upgraded
WebSocket sockets that nothing closes, so its callback — and the `process.exit(0)`
inside it — never runs.

Reproduced: server still running 8s after `SIGINT`, requiring a second Ctrl+C. Because a
tab is normally open, this is the ordinary shutdown path rather than an edge case.

Fix: close the bridge's sockets and stop the scheduler before `server.close()`.

---

## P1 — should fix

### 5. The safe-mode UI fails open

The expression

```js
modeData?.readOnly ?? (localStorage.getItem('wacli_safe_mode') !== null ? … : false)
```

is duplicated across five components (`Composer`, `ReadOnlyBanner`, `SettingsModal`,
`StatusStrip`, `SendConfirmModal`). With no cached value and health not yet loaded it
renders **unlocked**, while the server's first-run default (`FIRST_RUN_READ_ONLY`) is
locked. All five also write `localStorage` inside `mutationFn`, before the API call, so
a failed unlock leaves the UI claiming live-send while the server is still read-only.

Fix: one `useSafeMode()` hook that defaults to locked while the answer is unknown and
only records a mode the server has confirmed.

### 6. No React error boundary

`apps/web/src/main.tsx` — one render throw on unexpected message data blanks the whole
console, with no recovery short of a reload.

### 7. `--host` and `HOST` are documented but do nothing

`bin/cli.js` parses `--host` and uses it only for the printed banner and the URL it opens
in the browser. `HOST` in `apps/api/src/index.ts` is a hardcoded constant, and nothing
reads `process.env.HOST` — though `README.md` documents it as configuration. So
`--host 0.0.0.0` prints a URL the server is not listening on.

Resolution: remove the flag rather than wire it up. Binding off-loopback would make the
Host-header check reject every request, so the flag has no correct behaviour to
implement.

### 8. `storeDir` and `account` are mutually exclusive by accident

`apps/api/src/wacli/commands.ts` and `apps/api/src/wacli/process-manager.ts` both do:

```js
if (storeDir) { … } else if (account) { … }
```

These are independent wacli flags. Configuring a store directory silently drops the
account, so a multi-account setup runs against the wrong one with no diagnostic.

### 9. A search term starting with `-` is parsed as a flag

`apps/api/src/routes/search.ts` passes `q` as a bare positional with no `--` separator,
so wacli's flag parser consumes anything that looks like an option. Not shell injection
(`execFile` takes an argv array), but a query such as `--store=/tmp/x` is flag injection
into the console's own command.

---

## P2 — worth doing

### 10. The thread yanks the reader to the bottom

`ThreadView.tsx` scrolls to the newest message on every arrival with no check for whether
the operator is already near the bottom. Reading back through history is interrupted by
any incoming message.

### 11. A network call runs inside a cache updater

`useWebSocket.ts` calls `markChatAsRead` from inside a `setQueriesData` updater. Updaters
must be pure: React runs them under StrictMode twice, and once per matching query key, so
the read receipt can fire more than once per message.

### 12. Unhandled `error` on media read streams

`apps/api/src/routes/media.ts` — `pipe()` does not forward errors, and an unhandled
`error` on a `ReadStream` is an uncaught exception. A file removed mid-stream takes the
process down.

### 13. Path traversal in the scheduled-attachment path

`apps/api/src/routes/send.ts` joins the client-supplied `file.originalname` into
`persistentPath` without `path.basename()`. The same block also leaks its multer temp
file when the body throws — the `/send/file` sibling has a `finally` for this and
`/send/schedule-file` does not.

### 14. Cancel and discard report success when nothing matched

`/scheduled/:id` and `/scheduled/:id/discard` answer `success: true` *and* an error
string when the id was not found or was in the wrong state, so the UI shows a
no-op as a success.

### 15. WebSocket reconnect has no backoff

`useWebSocket.ts` retries on a flat 2s timer indefinitely. With the API down, the console
reconnects every two seconds for as long as the tab is open.

### 16. `scheduled.json` is never pruned

Sent and cancelled entries accumulate for the life of the install. The file is read on
every poll.

### 17. Loading older history stops the thread poll entirely

`MAX_POLLED_PAGES = 1` — a deliberate, documented trade (the socket carries live
messages, and refetching every retained page is expensive). But once the socket is also
down, a thread that has paged back goes stale with nothing on screen saying so.

---

## P3 — polish

| # | Where | Note |
|---|---|---|
| 18 | `process-manager.ts` | `handleProcessExit` runs twice on a spawn failure (`error` then `close`), inflating the reconnect backoff |
| 19 | `scheduler.ts` | `getList()` sorts only when unfiltered; per-chat lists come back in insertion order |
| 20 | `routes/messages.ts` | `hasMore: messages.length >= Number(limit \|\| 50)` costs one wasted round trip per thread |
| 21 | `index.ts` | A rejected CORS origin returns 500 — an `Error` into the global handler — rather than 403 |
| 22 | `App.tsx` / `ResizeHandle` | Clamps disagree: 180–650 / 160–500 validated on load, 200–600 / 180–500 enforced by the handle |
| 23 | `wacli/mode.ts` | Uses `console.warn` where everything else uses `logger` |
| 24 | several routes | Query params cast `as string` without validation; `?limit=abc` yields 500 rather than 400 |
| 25 | `logger.ts` | Default log directory is `../logs` relative to the installed package — inside `node_modules` for a global install, for files the comments note can carry chat JIDs |

---

## Reviewed and accepted — no change

### 3. `POST /api/settings` is not behind the mutation guard

The endpoint has neither the `X-Mission-Control-Request` header check nor the read-only
check that every sibling mutation route carries, and `storeDir` is the containment root
`resolveMediaPath` validates against — so widening it turns `/api/media/content` into an
arbitrary file read (reproduced during review).

Not remotely reachable: the JSON content type forces a CORS preflight that the loopback
origin check rejects, and a simple cross-origin form POST cannot produce a body
`express.json()` will parse. Accepted as local-only exposure on a loopback console.

### 4. Confirming a send disarms safe mode permanently

`SendConfirmModal` calls `api.setMode(false)` on the immediate-send path, so the first
confirmed send turns off global read-only mode and leaves it off. Accepted as intended:
confirming a send is taken as the operator's decision to go live.

---

## Provenance

Reviewed against `a4d6a22`. PII sweep clean — tracked fixtures use placeholders
(`120363111111111111@g.us`, `alice@s.whatsapp.net`), and the wacrawl PRD is untracked.
