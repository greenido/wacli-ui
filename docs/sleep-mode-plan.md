# Implementation Plan: Sleep Mode

> Status: in progress, as a stack of six PRs starting with #22. Written 2026-09-15 from a requirements interview; every behavior below was confirmed by the operator.

## Overview

Sleep mode is a switch that makes Mission Control do one thing, send scheduled messages on time, and nothing else until you come back. While asleep, the `wacli sync` daemon is stopped, the browser stops every kind of refresh, and the console stays on screen, frozen, under a banner. Only the LATER queue updates, and only when the server pushes a change. You wake it with the Wake button, or by doing anything that needs fresh wacli data or sends something.

Scheduled sends need none of what sleep turns off. The queue is dispatched by a 3-second in-memory timer on the server ([scheduler.ts](../apps/api/src/wacli/scheduler.ts)), which works with no browser open. So most of this feature is turning things off safely, and making sure nothing turns them back on by accident.

**Baseline**, counted from the configured poll intervals, for one open tab with a chat selected:

| Source | Interval | Requests/min | wacli processes/min |
|---|---|---|---|
| Health (`wacli doctor`; `--version` cached 60s) | 20s | 3 | 3–4 |
| Chat rail (`chats list` + 400-message preview scan) | 30s | 2 | 4 |
| Open thread (`messages list`) | 30s | 2 | 2 |
| LATER ×2, ACTIVITY, mode (the app's own DB) | 10–15s | 18 | 0 |
| **Total** | | **~25** | **9–10** |

On top of that: a refetch burst on every window focus, and the always-on `wacli sync --follow`, a live WhatsApp connection that writes every message, receipt and typing indicator to the store.

**Target while asleep:** zero requests from the tab, and no wacli process except the one each scheduled send runs.

## Confirmed intent

- **Outcome:** a Sleep switch that makes Mission Control do nothing except send scheduled messages on time, until you come back.
- **Who:** the operator, leaving the console running (overnight or while away) only so "Send later" messages go out.
- **Why:** an idle tab starts about 9 `wacli` processes a minute and keeps a live WhatsApp connection open, for nothing.
- **Success:** a tab stays open and asleep for an hour. The API log shows no `wacli` calls except the scheduled sends; each goes out on time, and the daemon stays stopped afterwards.
- **Constraint:** nothing automatic ends sleep; only the operator does.
- **Out of scope:** auto-sleep when idle, wake-up timers, retries for failed sends, and keeping the computer itself awake.

## Behavior

**While asleep**

- The sync daemon is stopped. The scheduler keeps running and sends exactly as it does today (every send already pauses the daemon and dials WhatsApp itself).
- The console stays on screen with its last data, under a banner: `Sleeping since 22:14 · 2 scheduled, next 06:30 · [Wake]`. If safe mode is on and messages are pending, the banner warns in red that they will fail when due.
- Only the LATER queue and the banner's count update: on a server push, read from the app's own DB. A scheduled message that goes out also shows up in the open thread and the rail through that push, without a fetch.
- The switch is app-wide and persistent. Every tab sleeps together, and a restarted Mission Control comes back asleep without starting the daemon.
- It is turned on by a moon button in the status strip header, with no confirmation.

**What wakes it, and what doesn't**

| Wakes it | Doesn't wake it |
|---|---|
| The Wake button (banner or status strip) | Scrolling what's already loaded |
| Opening another chat: rail click, J/K, ⌘↓/↑, a LATER/ACTIVITY row, a search result | The LATER row buttons: Cancel, Resend, Discard |
| The rail filter tabs (1–5) or the filter box | Queueing a new Send later (⌘↵) |
| ⌘K search, New chat, Chat info | Bookmarks, tags, the Tag manager |
| Load older (O), Export (E), Request older from phone | Help, Settings, the safe-mode switch |
| Send, reply, react | Media that wasn't downloaded before sleep: it stays a placeholder instead of downloading |
| Restart daemon | A WebSocket reconnect, an API restart, a scheduled send |
| Reloading the page or opening a new tab | |

Every wake is logged with its reason (`[process] Sleep mode off reason="open chat"`), so an unexpected wake can be traced.

## Architecture decisions

1. **The server owns the state.** `sleeping` and `sleepingSince` are two more keys in the existing `settings` key/value table, managed by `ModeManager` ([mode.ts](../apps/api/src/wacli/mode.ts)). Adding them is an insert, not a migration. The daemon lives on the server, so the switch is app-wide by construction, and persisting it is what makes a restart come back asleep.

2. **The daemon's desired state becomes explicit.** Today `executeExclusive` respawns the daemon after every exclusive command, even one stopped on purpose ([process-manager.ts](../apps/api/src/wacli/process-manager.ts), the `finally` block). A scratch script reproduced it: call `stop()`, run one send, and the daemon is back. A `wantRunning` flag, set only by `start()` and `stop()`, will decide whether anything respawns. This fix is what lets a scheduled send run while asleep and leave the daemon down. It also repairs `--no-sync`, which today starts syncing after the first send. The scheduler itself needs no change.

3. **Wake reuses the respawn debounce.** Waking calls a new `startSoon()`, which marks the daemon wanted and spawns it through the existing 750 ms debounce. When a send is what triggered the wake, the send cancels that pending spawn, runs, and the daemon respawns once afterwards. Otherwise the wake would spawn a daemon only for the send to kill it straight away.

4. **The client goes quiet by disabling queries, not by suppressing events.** Two switches, both checked against the installed `@tanstack/query-core` 5.102.8:
   - Every query that reaches wacli is `enabled` only when the app is *known* to be awake. A disabled query keeps its data (that is the frozen console), schedules no interval timer, and is skipped by `invalidateQueries` and by focus and reconnect refetches.
   - The own-DB polls (LATER, ACTIVITY, mode) stop through one global call, `focusManager.setFocused(false)`, while asleep. Interval ticks only fetch when focused, and focus refetches only fire when focus comes back. Waking calls `setFocused(undefined)`, which also fires the refetch that brings the console back.

5. **One health query.** Eight components each declare their own `useQuery(['health'])`. Three of them (Settings, New chat, Chat info) are mounted all the time and register the query before their early `return null`, so a single ungated copy keeps `['health']`, and with it `wacli doctor`, alive. A `useHealth()` hook replaces all eight.

6. **Wakes are explicit, never inferred from fetches.** The alternative, "a fetch arrived, so someone must want data", fails unsafe: any background refetch that slips through would end sleep, which is the one thing the operator asked never to happen. Instead:
   - *Reads:* the client wakes at a handful of intent points, all in one hook (`useWakeOnIntent`), so they can be audited in one file.
   - *Writes:* the server wakes before any wacli write, since writes only ever come from the operator.

7. **A server-side gate is the backstop.** While asleep, a route that would spawn wacli either refuses (reads get `409 { code: 'ASLEEP' }` and no process starts) or wakes the app first (writes). Everything else passes through. The table is explicit, and a test fails if a new `/api` route isn't classified. This keeps "nothing automatic ends sleep" true for an old tab, a script, or a poll someone adds next year and forgets to gate.

8. **Push, not poll.** A new `sleep.changed` WebSocket event keeps every tab in step, and the existing `scheduled.update` keeps LATER current. A tab re-reads `GET /api/sleep` (own DB) when its socket reconnects, but a reconnect never wakes the app. Only a fresh page load does.

## Dependency graph

```
T1  keep a stopped daemon stopped
 └─ T2  server sleep state · API · sleep.changed · boot asleep (+ startSoon)
     ├─ T3  client sleep state (hook, api, WebSocket)
     │   └─ T4  moon toggle · banner · truthful status      ← first end-to-end slice
     │       └─ T5  one gated health query
     │           └─ T6  silence the rest (focus switch + query gates)
     │               └─ T8  wake on intent  ◄── also needs T7
     └─ T7  server gate (reads refused · writes wake)       ← parallel with T3–T6, merge after T6
T9  docs (after T8)
```

## Task list

### Phase 1: Server

#### Task 1: Keep a stopped daemon stopped

**Description:** Give `WacliProcessManager` an explicit desired state. `start()` sets `wantRunning` and `stop()` clears it. `executeExclusive` respawns afterwards only if the flag is set; otherwise it announces `stopped` instead of leaving the state at `paused`. (As built, the backoff-restart and respawn timers needed no extra check: `stop()` already clears both, and nothing schedules either for a daemon that isn't wanted.)

**Acceptance criteria:**
- [ ] After `stop()`, an exclusive command runs and the daemon stays down, in state `stopped`.
- [ ] A manager that was never started (`--no-sync`) never spawns, however many sends run.
- [ ] A running manager still respawns exactly once after a burst of exclusive commands.

**Verification:**
- [ ] `npm run test -w @wacli/api -- process-manager`
- [ ] The existing respawn tests build managers that were never started and still expect a respawn, so they encode the bug. Change their `makeManager` fixture to call `start()` and then `spawn.mockClear()`, and keep every assertion.
- [ ] Manual: start with `--no-sync`, send one message, and check that `pgrep -fl "wacli sync"` prints nothing.

**Dependencies:** None
**Files likely touched:** `apps/api/src/wacli/process-manager.ts`, `apps/api/src/__tests__/process-manager.test.ts`
**Estimated scope:** S

#### Task 2: Server sleep state, API and event

**Description:** Persist `sleeping` and `sleepingSince` through `ModeManager`. Add a small controller in `wacli/sleep.ts` with `sleep(reason)`, `wake(reason)` and `state()`. Each action persists first, then broadcasts `sleep.changed`, then either stops the daemon (sleep) or calls `startSoon()` (wake, skipped under `WACLI_DISABLE_SYNC=1`). Add two routes:
- `GET /api/sleep` returns `{ sleeping, since }`.
- `POST /api/sleep` takes `{ sleeping: boolean, reason?: string }`. It returns 400 for a non-boolean, trims `reason` to 64 characters and only logs it, requires the `X-Mission-Control-Request: 1` header the UI already sends for local writes, and is idempotent.

At boot, `startServer` does not start the daemon while asleep, and logs that it started asleep. `POST /api/settings` must stay unable to set either key; it maps its fields explicitly today, so keep it that way. Add `startSoon()` to the process manager: it sets `wantRunning` and spawns through the existing respawn debounce, and wake uses it. (It moved here from T1, where nothing would have called it yet.)

**Acceptance criteria:**
- [ ] Sleep stops the daemon, persists the state, and broadcasts it; repeating the call is a 200 no-op.
- [ ] A restart while asleep does not start the daemon, and `GET /api/sleep` keeps the original `since`.
- [ ] Wake spawns the daemon once, after the debounce. Under `--no-sync` it only flips the flag.
- [ ] A scheduled message that comes due while asleep is sent, and the daemon is still stopped afterwards.
- [ ] Every sleep and wake is logged with its reason.

**Verification:**
- [ ] `npm run test -w @wacli/api -- sleep scheduler`. The scheduler case uses a real process manager with `spawnSyncProcess` and `execWacli` mocked.
- [ ] `npm run typecheck`

**Dependencies:** T1
**Files likely touched:** `apps/api/src/wacli/mode.ts`, `apps/api/src/wacli/sleep.ts` (new), `apps/api/src/routes/sleep.ts` (new), `apps/api/src/index.ts`, `apps/api/src/types.ts`, `apps/api/src/wacli/process-manager.ts` (`startSoon`), `apps/api/src/__tests__/sleep.test.ts` (new)
**Estimated scope:** M

### Checkpoint 1: the server works end to end

- [ ] `npm run test -w @wacli/api`, `npm run typecheck` and `npm run lint` pass.
- [ ] Against a real wacli:
  - Put the app to sleep (command below); `pgrep -fl "wacli sync"` is empty.
  - Schedule a message to yourself two minutes out. It goes out on time, LATER shows SENT, and `pgrep` is still empty.
  - Restart the API: it is still asleep, with no daemon.
  - Wake it: the daemon returns.
- [ ] Expected at this point: a browser tab left open still polls health (`wacli doctor` every 20s). Phase 3 closes that.

```bash
curl -s -X POST http://127.0.0.1:3002/api/sleep -H 'Content-Type: application/json' -H 'X-Mission-Control-Request: 1' -d '{"sleeping":true,"reason":"checkpoint"}'
```

### Phase 2: Sleep from the UI (the first end-to-end slice)

#### Task 3: Client sleep state

**Description:**
- `api.getSleep()` and `api.setSleep()`; `SleepState` and `sleep.changed` in the web types.
- `useSleepMode()` returns `{ known, sleeping, awake, since, setSleeping, isSettingSleep, sleepError }` over a `['sleep']` query with no interval and `staleTime: Infinity`. `awake` stays false until the first answer, so wacli queries wait a few milliseconds at boot instead of racing a sleeping server. `setSleeping` is fire and forget: a refusal lands in `sleepError`, for the control that asked to show, rather than in an unhandled rejection.
- In `useWebSocket`, `sleep.changed` calls `setQueryData(['sleep'])`. On connect and reconnect, also invalidate `['sleep']`, so a tab that was disconnected catches up.
- (Two pieces moved out while building this. `ensureAwake` went to T8, its first caller. Invalidating `['scheduled']` on reconnect went to T6: until then the queue still polls, so there is nothing for it to catch up on.)

**Acceptance criteria:**
- [ ] A `sleep.changed` push updates every consumer without a fetch.
- [ ] `awake` is false before the first response and while asleep.
- [ ] A reconnect refetches `['sleep']` and never calls `setSleep`.

**Verification:**
- [ ] `npm run test -w @wacli/web -- useSleepMode useWebSocket`

**Dependencies:** T2
**Files likely touched:** `apps/web/src/api/client.ts`, `apps/web/src/types.ts`, `apps/web/src/hooks/useSleepMode.ts` (new, with test), `apps/web/src/hooks/useWebSocket.ts` (and its test)
**Estimated scope:** S

#### Task 4: Moon toggle, banner and truthful status

**Description:**
- **Toggle:** a moon button in the status strip header, beside Help and Settings. While asleep it becomes a Wake control.
- **Banner:** a new `SleepBanner`, rendered under `ReadOnlyBanner`. It shows the since time, the pending count, the next due time and a Wake button, plus the red safe-mode warning when it applies.
- **Queue data:** the count and next time come from the LATER query. A second observer of that key has to be the same infinite query, so extract the status strip's `useInfiniteQuery(['scheduled'])` into `useScheduledQueue()`.
- **Truthful status:** while asleep, nothing that shows frozen health may claim a running daemon.
  - The DAEMON row reads SLEEPING and hides PID, heartbeat and lock.
  - `WacliStatusBanner` stays hidden.
  - Settings reads "sleeping", says only scheduled messages go out, and swaps Restart Daemon for Wake. A restart would bring the daemon back under a sleeping flag, and nothing stops that on the server until T7. (Its line saying the diagnostics are from before sleep moved to T5, the first point at which they are.)

**Acceptance criteria:**
- [ ] The moon button puts the app to sleep: the daemon stops and the banner appears in every open tab.
- [ ] Wake removes the banner and brings the daemon back.
- [ ] The safe-mode warning appears only when safe mode is on and at least one message is pending.
- [ ] Nothing on screen claims a running daemon while asleep.

**Verification:**
- [ ] `npm run test -w @wacli/web -- SleepBanner StatusStrip`
- [ ] Manual check in `npm run dev`.

**Dependencies:** T3
**Files likely touched:** `apps/web/src/components/SleepBanner/SleepBanner.tsx` (new, with test), `apps/web/src/components/StatusStrip/StatusStrip.tsx` (and its test), `apps/web/src/hooks/useScheduledQueue.ts` (new), `apps/web/src/App.tsx`, `apps/web/src/components/WacliStatusBanner/WacliStatusBanner.tsx`, `apps/web/src/components/SettingsModal/SettingsModal.tsx`
**Estimated scope:** M (six source files, most with only a few lines changed)

### Checkpoint 2: sleep and wake from the UI

- [ ] Tests, typecheck and lint pass.
- [ ] The moon button stops the daemon. The rail and thread stay on screen, because the existing read gate already freezes them when the daemon is stopped. A scheduled message goes out and flips to SENT. Wake restores everything.
- [ ] Known gap until Phase 3: the tab still polls health and the own-DB lists.
- [ ] Review with the human before continuing.

### Phase 3: Truly quiet

#### Task 5: One gated health query

**Description:** Add `useHealth()` with key `['health']`, `refetchInterval: POLL_HEALTH_MS` and `enabled: awake`. Use it in place of the eight inline observers: ChatList, ThreadView, StatusStrip, WacliStatusBanner, SettingsModal, ChatInfoModal, NewChatModal and SearchBar. Behavior while awake does not change, because React Query already polled this key at the shortest interval any observer asked for. From here on, health shown while asleep is the last reading before sleep, so Settings says so in one line. (That line moved here from T4.)

**Acceptance criteria:**
- [ ] No `['health']` fetch happens while asleep from any trigger: interval, invalidation, focus, or a component mounting.
- [ ] While awake, each tab runs one 20s health poll, as before.
- [ ] Outside tests, `['health']` appears only in `useHealth.ts`.

**Verification:**
- [ ] `npm run test -w @wacli/web`
- [ ] `grep -rn "queryKey: \['health'\]" apps/web/src --include='*.tsx' --include='*.ts' | grep -v test` finds only the hook.

**Dependencies:** T3 (it only needs `awake`), but schedule it after Checkpoint 2
**Files likely touched:** `apps/web/src/hooks/useHealth.ts` (new, with test) and the eight components listed above
**Estimated scope:** M. It touches nine files, but it is one mechanical change, and splitting it would leave `['health']` live through whichever half isn't done. Keep it as one commit with nothing else in it.

#### Task 6: Silence everything else while asleep

**Description:**
- Add one app-level effect, `useSleepEffects()` in `useSleepMode.ts`, mounted once in App. It sets `focusManager.setFocused(sleeping ? false : undefined)`.
- On connect and reconnect, `useWebSocket` also invalidates `['scheduled']`. Asleep, LATER lives on pushes alone, so a push missed while the socket was down would otherwise stay missed. (Moved here from T3.)
- Gate the remaining wacli queries on `awake`:
  - chats (ChatList)
  - messages and coverage (ThreadView)
  - search (SearchBar)
  - new-chat search (NewChatModal)
  - contact and groups (ChatInfoModal). These are gated only on `isOpen` today, so they would race a wake.

**Acceptance criteria:**
- [ ] A test renders the console asleep with fake timers and advances 10 minutes: the mocked `api` receives zero read calls.
- [ ] In that state, a `scheduled.update` push causes exactly one `getScheduled`, and a `message.new` for the sent message patches the cache without a fetch.
- [ ] After a wake, every poll resumes at its normal interval.

**Verification:**
- [ ] `npm run test -w @wacli/web`
- [ ] Manual: on an asleep tab, the DevTools Network panel stays empty for 10 minutes, and the API's `[http]` log shows nothing from that tab.

**Dependencies:** T5
**Files likely touched:** `apps/web/src/hooks/useSleepMode.ts`, `apps/web/src/App.tsx`, `apps/web/src/components/ChatList/ChatList.tsx`, `apps/web/src/components/ThreadView/ThreadView.tsx`, `apps/web/src/components/SearchBar/SearchBar.tsx`, `apps/web/src/components/NewChatModal/NewChatModal.tsx`, `apps/web/src/components/ChatInfoModal/ChatInfoModal.tsx`, plus a new "asleep console is silent" test
**Estimated scope:** M (seven files, one or two lines in each of the five components)

#### Task 7: Server-side sleep gate

**Description:** Add one middleware in `wacli/sleep.ts`, mounted in `createApp` before the routers, driven by an explicit table:

| Class | Routes | While asleep |
|---|---|---|
| REFUSE | `GET /api/health`, `/chats`, `/messages`, `/messages/export`, `/history/coverage`, `/contacts/show`, `/groups`, `/search` | `409 { success: false, code: 'ASLEEP' }`, no wacli process |
| WAKE | `POST /api/send/text`, `/send/file`, `/send/react`, `/chats/mark-read`, `/contacts/alias`, `/history/backfill`, `/media/download`, `/daemon/start`, `/daemon/restart` | `wake("<METHOD path>")`, then continue |
| ALLOW | mode, settings, sleep, tags, bookmark, activity, the scheduled routes (list, schedule, schedule-file, cancel, resend, discard), `/daemon/stop`, the internal webhook | pass through and never wake. These use only the app's own DB, except resend, which is the scheduler's own send. |

`GET /api/media/content` is decided inside the route instead of the table. It serves a file already on disk; while asleep it skips the `wacli media download` fallback and answers ASLEEP, because scrolling a frozen thread must never download or wake. On the client, extend the retry rule in `wacliReadQueryOptions` so that `ASLEEP` is never retried.

**Acceptance criteria:**
- [ ] While asleep, every REFUSE route answers 409 `ASLEEP`, and the mocked `execWacli` is never called.
- [ ] While asleep, every WAKE route wakes the app before its wacli call.
- [ ] A test walks the registered Express routes and fails if an `/api` route is in none of the three classes, or in more than one.
- [ ] Resending a failed scheduled message while asleep sends it and leaves the app asleep.

**Verification:**
- [ ] `npm run test -w @wacli/api -- sleep`
- [ ] While asleep, `curl -si http://127.0.0.1:3002/api/chats` returns `409` with `"code":"ASLEEP"`.

**Dependencies:** T2. It can be built in parallel with T3–T6, but merge it after T6. Before then, an asleep tab still polls health and would see 409s.
**Files likely touched:** `apps/api/src/wacli/sleep.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/media.ts`, `apps/web/src/lib/queryOptions.ts`, `apps/api/src/__tests__/sleep-gate.test.ts` (new)
**Estimated scope:** M

#### Task 8: Wake on intent

**Description:** One hook, `useWakeOnIntent()`, mounted in App, holds every client-side wake trigger:
- **Store changes while asleep:** the selected chat changes; `chatFilter` or `searchQuery` changes; `activeModal` becomes `new-chat` or `chat-info`.
- **Page load:** if the first `['sleep']` answer in this page's lifetime says asleep, wake with `reason: "page load"`. A WebSocket reconnect is not a page load.
- **Imperative fetches:** three fetches bypass `enabled` and so must `await ensureAwake()` first: ⌘K opening search (`toggleSearch` in App), Load older (ThreadView), and Export (ExportMenu).
- `ensureAwake(queryClient, reason)` wakes the app only if the cache says it is asleep, and merges concurrent calls into one request. (Moved here from T3.)

Sends, replies, reactions and mark-read need nothing here, because the server wakes the app for them (T7).

**Acceptance criteria:**
- [ ] Each trigger in the Behavior table wakes the app exactly once, and each non-trigger leaves it asleep.
- [ ] `sleep.changed` or a reconnect while asleep never wakes it; a fresh mount while asleep wakes it once.
- [ ] Opening a chat while asleep ends with that chat's messages loaded.

**Verification:**
- [ ] `npm run test -w @wacli/web -- useWakeOnIntent`
- [ ] Manual: walk both columns of the Behavior table, reading the wake reasons in the API log.

**Dependencies:** T6, T7
**Files likely touched:** `apps/web/src/hooks/useWakeOnIntent.ts` (new, with test), `apps/web/src/App.tsx`, `apps/web/src/components/ThreadView/ThreadView.tsx`, `apps/web/src/components/ThreadView/ExportMenu.tsx`
**Estimated scope:** M

### Checkpoint 3: feature complete

- [ ] `npm run verify` passes.
- [ ] Leave a tab asleep for 10 minutes:
  - no rows appear in the Network panel;
  - the API log has no `[http]` lines apart from `GET /api/send/scheduled` right after a send;
  - `pgrep -fl wacli` is empty except during the send.
- [ ] Every row of the Behavior table checked by hand.
- [ ] Review with the human.

### Phase 4: Docs

#### Task 9: Document sleep mode

**Description:**
- **README, Core Features:** a Sleep mode entry covering what stops, what still happens, what wakes it, that it survives a restart, and that it does not keep the computer awake.
- **README, REST table:** `GET`/`POST /api/sleep` and the `409 ASLEEP` answer. While editing the table, note that it lists `POST /api/send/media`, but the route is `/api/send/file`.
- **README, WebSocket event list:** add `sleep.changed`.
- **Help:** a "Sleep mode" topic next to "Safe mode and live sends".
- **Release note:** `--no-sync` now stays sync-less after a send (T1).

**Acceptance criteria:**
- [ ] README and Help describe the same wake rules as the Behavior table.

**Verification:**
- [ ] `npm run test -w @wacli/web -- HelpModal`
- [ ] Read-through against the Behavior table.

**Dependencies:** T8
**Files likely touched:** `README.md`, `apps/web/src/components/HelpModal/HelpModal.tsx`
**Estimated scope:** S

### Checkpoint 4: ship

- [ ] `npm run verify` and `npm run build` pass.
- [ ] Soak test: leave the app asleep for at least an hour (overnight is better, with the computer kept awake), with two tabs open and two messages scheduled to yourself. Both go out on time, and a `LOG=1` run log shows no wacli process other than the two sends.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The computer itself sleeps (lid closed, idle sleep). Node is suspended and due messages go out late, when it wakes. | High, for "on time" | Out of scope by decision; README and Help say so. Follow-up idea: hold `caffeinate -i -w <pid>` on macOS while messages are pending. |
| Long sleeps. Incoming messages reach the store only when the daemon reconnects, and WhatsApp eventually unlinks devices that stay offline. | Medium | Sleep is meant for hours to days, not weeks, and the docs say so. Waking runs the normal catch-up sync. |
| A future background fetch (a new poll or WebSocket handler) bypasses or ends sleep. | Medium | The server gate refuses wacli reads while asleep, whatever the client does. The route-classification test forces every new route into a class. All client wake triggers live in one hook. |
| `focusManager` stays forced to unfocused after a wake, and polling never resumes. | Medium | The effect is keyed only on `sleeping`, and T6 tests that polls resume after a wake. |
| The browser reloads the page by itself (session restore, a dev-server hot reload) and wakes the app. | Low | Accepted in the interview: in practice this happens with someone at the machine. |
| The existing respawn tests encode the bug, and editing them could hide a regression. | Medium | Change only the fixture, keep every assertion, and add explicit "stopped stays stopped" and "never started never spawns" tests. |
| `--no-sync` behavior changes: sends no longer start the daemon. | Low | That was always the documented intent; add a release note. |
| Tabs still running the pre-upgrade build keep polling. | Low | The gate answers them `409` without running wacli or waking the app; a reload picks up the new build. |
| A read that triggered a wake races the daemon's startup and hits `STORE_LOCKED`. | Low | Wake spawns through the debounce, so the read usually finishes first; the existing lock retries absorb the rest. |

## Open questions (non-blocking)

- **Keyboard shortcut for Sleep:** not planned. Adding one to `apps/web/src/lib/shortcuts.ts` is a single entry if wanted.
- **Keeping the computer awake while messages are pending:** a separate feature (see Risks).
