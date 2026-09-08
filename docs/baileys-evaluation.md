# Evaluation: replacing `wacli` with Baileys

**Status:** Decision proposed — not adopted
**Author:** greenido (with Claude)
**Created:** 2026-09-07
**Question:** Should Mission Control drop its dependency on the `wacli` binary and talk to
WhatsApp directly through [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)?

---

## Recommendation, up front

**No. Stay on `wacli`.** Instead, spend roughly two days removing the one piece of our own
architecture that is doing the damage we would otherwise be migrating to escape.

The case for Baileys rests almost entirely on two claims: that shelling out to a CLI is slow,
and that the store lock forces us to tear down the realtime feed on every send. The first is
false on measurement. The second is true — but it is our bug, not wacli's, and wacli fixed the
underlying problem in v0.7.0 four months ago. See §6.

Migrating would mean reimplementing wacli — a 2,700-star, MIT, actively released Go project — in
TypeScript, and then owning WhatsApp protocol churn ourselves, forever. The reward for that is a
simpler install story and about 1,300 lines of deleted plumbing. That is not a trade worth
three months and a permanent maintenance obligation.

---

## 1. What we actually depend on wacli for

Measured against this checkout (`main` @ `a095a06`), wacli 0.17.2, store at `~/.wacli` holding
9,530 messages / 1,070 chats / 747 contacts / 375 groups.

Every wacli surface the API touches:

| Surface | Command | Used by |
| :--- | :--- | :--- |
| Chat list | `chats list` (+ `--query --archived --pinned --muted --unread`) | `routes/chats.ts` |
| Mark read | `chats mark-read` | `routes/chats.ts` |
| Messages | `messages list` (+ `--before --after --asc --limit`) | `routes/messages.ts` |
| Search | `messages search` (FTS5) | `routes/search.ts` |
| Export | `messages export` | `routes/messages.ts` |
| History | `history coverage`, `history backfill` | `routes/history.ts` |
| Contacts | `contacts show`, `contacts alias set/rm` | `routes/contacts.ts` |
| Groups | `groups list` | `routes/contacts.ts` |
| Media | `media download` | `routes/media.ts` |
| Send | `send text`, `send file`, `send react` | `routes/send.ts`, `wacli/scheduler.ts` |
| Realtime | `sync --follow --events --webhook …` | `wacli/process-manager.ts` |
| Health | `doctor`, `--version` | `routes/health.ts` |

Behind those twelve lines sits everything we do not have to write: multi-device pairing and
session persistence, named accounts, the Signal/libsignal crypto, the SQLite schema, the FTS5
index, retention and size caps (`--max-db-size`, `--max-messages`), media key decryption,
app-state sync for pin/mute/archive, reconnect and keepalive policy, JID and LID resolution, and
a `WACLI_READONLY=1` enforcement layer that lives in a *different process from ours*.

**Code shape today** — this matters for sizing the blast radius:

| | source | tests |
| :--- | ---: | ---: |
| `apps/api/src` | 6,685 | 5,918 |
| `apps/web/src` | 9,135 | 5,633 |
| — of which `apps/api/src/wacli/` | 2,794 | |

The web app is 60% of the codebase and is insulated by the REST contract. A migration is an
API-side project.

---

## 2. What Baileys is

A TypeScript library that speaks the WhatsApp Web multi-device protocol over a WebSocket, in
your own process. MIT licensed. ~11k stars, 3.4k forks, 2.36M npm downloads/week — by a wide
margin the most-used unofficial WhatsApp library.

It gives you: a socket, QR/pairing-code auth, `useMultiFileAuthState`, an `EventEmitter`
(`messages.upsert`, `messages.update`, `message-receipt.update`, `presence.update`, `chats.*`,
`contacts.*`, `messaging-history.set`), `sendMessage` (text, media, reactions, replies,
mentions), `chatModify` (archive/pin/mute/read), `groupMetadata`, and `downloadMediaMessage`.

It explicitly does **not** give you storage. From v7 the socket is fully event-driven and
Baileys keeps no internal state of chats, contacts, or messages — "the event stream is the
single source of truth, which means you are responsible for persisting everything you care
about." The in-memory store is documented as a testing aid, not production storage.

For us that is the whole ballgame. Mission Control *is* a view over a local archive: search,
paging, coverage, export, retention. Baileys hands us a firehose and an empty disk.

---

## 3. The honest case *for* migrating

These are real. I am not going to strawman them.

1. **One process, one connection.** No subprocess per read, no daemon supervision, no HMAC
   webhook, no store lock. A send becomes a function call on a socket that is already open.
2. **Delete the impedance layer.** `commands.ts` (358), `process-manager.ts` (562),
   `store-lock.ts` (34), `failures.ts` (82), `routes/webhook.ts`, and the `Raw*` JSON shapes in
   `types.ts` all exist only to marshal across a process boundary. Call it ~1,300 lines that
   stop existing.
3. **Install story.** Today `npx wacli-mission-control` is a lie of omission: the user must
   separately `brew install wacli`, run `wacli auth`, and keep the binary current. With Baileys
   it is genuinely one npm install and a QR code in our own UI.
4. **Full protocol access.** wacli's JSON is a projection. Baileys hands over the raw protobuf,
   so anything WhatsApp supports is reachable without waiting for a CLI flag.
5. **No version skew.** We currently pin nothing: the app runs against whatever `wacli` is on
   `PATH`. This checkout was written against 0.17.2; 0.18.1 shipped yesterday. A library is in
   `package-lock.json`.

---

## 4. The case *against*

### 4.1 We would be rewriting wacli, in a slower language, alone

Everything in §1 that we get for free becomes ours. Concretely, new code we would have to write
and then maintain:

- SQLite schema + migrations for messages, chats, contacts, groups, receipts, reactions
- The ingest pipeline from `messages.upsert` / `messages.update` / `message-receipt.update`
- An FTS5 index and the query layer behind `Cmd+K`
- Media: key decryption, download, on-disk layout, retention, the expired-media failure path
- History sync handling (`messaging-history.set`), coverage accounting, and backfill
- Reconnect, backoff, keepalive, stale-connection detection
- JID/LID normalization — currently an open question in Baileys' own discussions
- Retention and size caps

That is not glue. Realistically 2,500–4,000 lines of new protocol-adjacent code, plus a
rewritten API test suite, plus the long tail of bugs you only find in production against a
protocol you do not control. **6–12 focused weeks to parity, and the tail never closes.**

### 4.2 The upstream we would be leaning on is less stable than the one we have

| | wacli | Baileys |
| :--- | :--- | :--- |
| License | MIT | MIT |
| Latest | v0.18.1, **2026-09-08** | `7.0.0-rc14`, 2026-07-29 |
| npm `latest` tag | n/a | **a release candidate** |
| Last stable line | — | 6.7.24 (`legacy` tag) |
| Cadence | v0.16 → v0.18.1 in 5 weeks | rc.8 (Nov 2025) → rc14 (Jul 2026); a 5½-month gap in between |
| Open issues | — | 339 |

Baileys' v7 has been in release candidate for ten months, and npm's `latest` points at it. We
would be choosing between pinning a stable line the maintainers have tagged `legacy`, or
shipping a product on an rc. wacli, meanwhile, is releasing weekly with outside contributors.

This is the argument I find hardest to get around: **the reason to depend on someone else's code
is that they maintain it better than you would. On this axis wacli is currently winning.**

### 4.3 Two headline features would regress on day one

- **"Request Older From Phone."** Our `history backfill` maps to Baileys' `fetchMessageHistory`,
  which is reported broken for companion devices — the request is sent, WhatsApp silently drops
  it, and `messaging-history.set` never fires
  ([#2452](https://github.com/WhiskeySockets/Baileys/issues/2452),
  [#1934](https://github.com/WhiskeySockets/Baileys/issues/1934)). Related: `isLatest` never
  flips after the first history event ([#2005](https://github.com/WhiskeySockets/Baileys/issues/2005)).
- **The existing archive.** 9,530 messages and 112 MB of media live in `~/.wacli`. A Baileys
  build starts empty and re-syncs only what the phone volunteers. Either we write a one-shot
  importer from `wacli.db` — more new code — or every existing user loses their history.

### 4.4 Safe mode gets structurally weaker

This is the one I would push back hardest on, because it cuts against the product's whole pitch.

Today read-only mode is enforced **twice**: once by our own `requireMutationPermission`, and
once by `WACLI_READONLY=1` in a separate process that we did not write and cannot accidentally
bypass. A bug in our route layer still cannot send a message.

In-process Baileys collapses that to a single `if` in our own code. For a console whose README
leads with "Read-Only on First Run" and a two-step confirmation modal, trading a process
boundary for a boolean is a genuine downgrade in the property we are actually selling.

### 4.5 We would inherit the session-safety problem

wacli owns connection behaviour we currently get without thinking: `--presence-mode quiet`,
`--send-spacing` pacing for delegated sends, `--stale-threshold` reconnects, and lock semantics
that stop two clients racing the same device identity ("device replaced" disconnects). With
Baileys, every one of those becomes a decision we make and a way we can get the user's personal
WhatsApp account banned. Baileys' own README declines liability and asks users not to violate
WhatsApp's ToS. That risk exists either way — but today someone else is tuning it.

### 4.6 It does not solve the problem we actually have

The known history gap is documented in [`wacrawl-history-tier-PRD.md`](./wacrawl-history-tier-PRD.md):
wacli holds ~9.2k messages, wacrawl's read of WhatsApp Desktop's own databases holds ~37k, going
roughly a year further back. Baileys does not help with that — it syncs from the same phone,
with the same pairing-date floor, using an on-demand backfill that is currently broken (§4.3).
The wacrawl tier is additive and orthogonal, and it remains the right answer.

---

## 5. Two claims that do not survive measurement

The migration case leans on these. Both are weaker than they look.

### 5.1 "Shelling out per read is slow"

Measured on this machine, warm, against the real 9,530-message store:

```
wacli messages list --limit 100 --json     0.10s (cold) → 0.02s
wacli chats list --limit 100 --json        0.043s total
wacli messages search "the" --limit 50     0.046s total
```

**20–46 ms including process spawn, SQLite open, and JSON serialization.** Our own slow-command
warning fires at 1,000 ms. In-process SQL would save perhaps 30 ms on a request the user already
waits on a browser render for. This is not where the latency is, and it is not worth a rewrite.

(Reads are also not lock-contended: wacli runs SQLite in WAL mode, so `messages list` and
`chats list` run happily alongside `sync --follow`. `wacli doctor` confirms `fts_enabled: true`
and reads succeed with the daemon up.)

### 5.2 "The store lock forces us to kill the daemon on every send"

True of our code. **Not true of wacli since v0.7.0.**

`routes/send.ts:59` says every send must run through `executeExclusive` because "the sync daemon
holds the store lock for as long as it is up … so a send fired while it runs loses the race every
time." The cost is spelled out right there: "the daemon is down for the whole send, so nothing
arrives over the webhook until it respawns" — plus `DEFAULT_RESPAWN_DEBOUNCE_MS` (750 ms) and the
~600 ms the daemon needs to reconnect.

But wacli 0.7.0 (2026-05-06) shipped: *"Send: delegate send commands through a running
`sync --follow` process instead of failing on the store lock."* Delegation was extended to
reactions, stickers, polls, edits and forwards through v0.13–v0.15.2, and to presence
indicators. It works over a Unix socket in the store dir — **which is present on this machine
right now**:

```
$ ls -la ~/.wacli/.send.sock
srw-------  1  ...  0 Sep  7 19:24  ~/.wacli/.send.sock
```

Our own code already knows this. `commands.ts:57` documents it while explaining `POST_SEND_WAIT`:
"With the sync daemon up, sends are delegated to it over the store's `.send.sock` and that
connection stays alive regardless." That comment and the one in `send.ts` contradict each other,
and the pessimistic one is the one driving the architecture.

wacli also has a `--lock-wait` global flag for genuinely exclusive writes, added in the same
release. We pass it nowhere.

**So the single worst property of the current design — a realtime feed that goes dark for one to
three seconds on every send, reaction, mark-read and alias edit — is very likely self-inflicted,
and fixable in a couple of days.** That reframes the entire decision.

---

## 6. Options

### A. Stay on wacli, and stop fighting it — **recommended**

1. **Verify delegation, then stop tearing down the daemon.** Add an integration test that fires
   `send text` with the daemon up and asserts it lands without a pause. If it passes, drop
   `executeExclusive` from the three send routes and reconcile the contradictory comments.
   Keep it for `history backfill` and `contacts alias`, or give those `--lock-wait` first.
2. **Pin the wacli version.** Read `wacli --version` at boot, refuse or warn below a known-good
   floor. We already have `checkWacliInstalled()` and `WacliStatusBanner` — this is a
   constant and a comparison. Today the app silently runs against anything on `PATH`.
3. **Bump to 0.18.x** and pick up `groups participants list` and the indexed-lookup sync
   speedups.
4. **Ship the wacrawl history tier** as specified. That is the real user-facing gap.

Cost: days, not months. Removes most of §3.1's benefit without any of §4's cost.

### B. Migrate to Baileys

Cost: 6–12 weeks to parity plus permanent protocol ownership. Loses backfill (§4.3), the
existing archive unless we write an importer, and the process-boundary safe mode (§4.4).
Recommended only under the triggers in §7.

### C. Hybrid — Baileys for the live socket, wacli for the store

Worst of both. Two WhatsApp connections against one device identity is exactly the "device
replaced" failure wacli's lock exists to prevent. **Do not do this.**

### D. WhatsApp Cloud API (official)

Worth naming so it is consciously rejected: it is the only path that is not a ToS grey area, but
it requires a WhatsApp Business account, cannot read a personal account's history at all, gates
outbound messages behind approved templates and 24-hour windows, and charges per conversation.
It is a different product. Not applicable.

---

## 7. What would change this recommendation

Revisit if any of these becomes true:

- **wacli stops shipping.** If the release cadence in §4.2 inverts — no releases for a quarter,
  or the repo is archived — the maintenance argument flips and Baileys becomes the safer bet.
- **Delegation turns out not to work** (§6 step 1 fails). If sends genuinely cannot happen
  without pausing the daemon on current wacli, and upstream will not fix it, the strongest pro
  in §3 is back and the calculus is much closer.
- **We need something wacli will not expose.** Right now the opposite is true — wacli already
  ships `polls`, `channels`, `calls`, `profile` and `presence` that the console does not use.
- **Baileys tags a stable 7.x** and `fetchMessageHistory` is fixed for companion devices. That
  removes §4.2 and §4.3, leaving only the "we'd be rewriting wacli" objection.
- **Distribution becomes the priority.** If Mission Control is meant to be a thing strangers
  `npx` and use in five minutes, the Homebrew-plus-CLI-auth prerequisite is a real funnel
  killer, and §3.3 starts to outweigh §4.1. This is the most plausible trigger of the five —
  see the open questions.

---

## 8. Open questions

1. **What prompted this?** If it is the send/daemon stutter, §6 fixes it this week. If it is the
   install friction, that is the one argument for Baileys I would take seriously — and it should
   be evaluated on its own terms, not as a protocol question.
2. **Who is this for?** Personal tool, or something published for others to install? That
   changes the weight of §3.3 (install story) against §4.5 (owning someone else's ban risk)
   more than any other factor here.
3. **Is the wacrawl history tier still the plan?** If yes, that is a second read source, and
   adding a third protocol stack at the same time is a lot of moving parts at once.
4. **Do we care about keeping the existing 9,530-message archive?** If not, §4.3's second half
   goes away and a migration gets meaningfully cheaper.

---

## Appendix: how to reproduce the measurements

```bash
wacli --version                                     # 0.17.2 here
wacli doctor --json                                 # store counts, fts_enabled, lock_held
ls -la ~/.wacli/.send.sock                          # delegation socket
du -sh ~/.wacli                                     # 112M

time wacli chats list --limit 100 --json > /dev/null
time wacli messages search "the" --limit 50 --json > /dev/null

curl -s https://registry.npmjs.org/baileys | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const d=JSON.parse(s); console.log(d['dist-tags']);});"
curl -s https://api.npmjs.org/downloads/point/last-week/baileys
curl -s https://api.github.com/repos/openclaw/wacli/releases?per_page=6
```

## Sources

- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — repo, README, license
- [`baileys` on npm](https://www.npmjs.com/package/baileys) — `latest` = `7.0.0-rc14`, `legacy` = `6.7.24`
- [Baileys data store docs](https://www.mintlify.com/WhiskeySockets/Baileys/core/data-store) — you must implement your own store
- [Baileys migration guide](https://www.mintlify.com/whiskeysockets/baileys/migration) — v7 breaking changes
- [Baileys #2452](https://github.com/WhiskeySockets/Baileys/issues/2452) — on-demand history sync silently dropped
- [Baileys #1934](https://github.com/WhiskeySockets/Baileys/issues/1934) — `fetchMessageHistory` callback never arrives
- [Baileys #2005](https://github.com/WhiskeySockets/Baileys/issues/2005) — `isLatest` never changes
- [openclaw/wacli](https://github.com/openclaw/wacli) and [CHANGELOG](https://github.com/openclaw/wacli/blob/main/CHANGELOG.md) — v0.7.0 send delegation, `--lock-wait`
- [wacli.sh](https://wacli.sh) — MIT, whatsmeow-based, feature list
