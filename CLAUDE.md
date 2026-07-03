# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TeamClaude is a transparent HTTP proxy that sits between Claude Code and the Anthropic API, managing multiple Claude (Max/Pro/API-key) accounts and rotating between them when one nears its session (5h) or weekly (7d) quota. Published as `@karpeleslab/teamclaude`.

## Commands

There is **no build step**. Development is run directly against source.

```bash
node src/index.js <command>        # run any CLI command locally (server is the default)
node src/index.js stop             # stop the running server (restart = stop + start)
npm start                          # = node src/index.js (starts the proxy server)
npm test                           # = node --test  (tests live in test/)
npx eslint src/                    # lint (flat config in eslint.config.js; no lint npm script)

# Use a throwaway config instead of ~/.config/teamclaude.json:
TEAMCLAUDE_CONFIG=./config.json node src/index.js server
```

`config.json` is gitignored; `config.example.json` is the template. To exercise the proxy end-to-end, start `server` in one terminal and `node src/index.js run` (or `eval $(node src/index.js env)` then `claude`) in another.

## Hard constraints (do not break these)

- **Zero runtime dependencies.** This is an advertised feature — use only Node.js built-in modules. Do not add anything to `dependencies`.
- **ES modules, Node 18+.** `"type": "module"`, top-level `await` is used in `src/index.js`.
- **ESLint globals are explicitly enumerated** in `eslint.config.js`. If you use a new global (a timer, a Web API like `crypto`/`TextEncoder`), add it to the `globals` map or `no-undef` will error.

## Architecture

Single CLI binary (`src/index.js`) dispatches subcommands; `server` boots the proxy. Six files, each a clear layer:

- **`src/index.js`** — CLI dispatcher + all non-server commands (`stop`, `restart`, `import`, `login`, `env`, `status`, `accounts`, `remove`, `api`). Owns the **config-sync wiring** between the running server, the TUI, and external CLI invocations (see below), and the **server-lifecycle helpers** (`findRunningServer`/`stopRunningServer` — discover a running proxy via the state file `getServerStatePath()`, falling back to a port probe + `lsof`, then SIGTERM→SIGKILL it; `server` writes the state file on listen and removes it on exit).
- **`src/server.js`** — the HTTP proxy and the request-forwarding loop (`forwardRequest`), including account acquisition (concurrency slot), retry, rate-limit handling, SSE streaming, and optional request logging.
- **`src/account-manager.js`** — `AccountManager` class: in-memory account state, use-or-lose selection, **per-account concurrency cap + overflow queue** (`acquireAccount`/`releaseAccount`), quota tracking from response headers, and token-refresh coalescing. The single source of truth for *live* credentials while the server runs.
- **`src/oauth.js`** — OAuth PKCE login, token refresh, profile fetch, and credential import from Claude Code. No proxy state here — pure functions.
- **`src/config.js`** — load/save of `~/.config/teamclaude.json` (override via `TEAMCLAUDE_CONFIG`, or `$XDG_CONFIG_HOME`). Written `0o600`.
- **`src/tui.js`** — full-screen terminal dashboard (alternate screen buffer). Only used when both stdin and stdout are TTYs; otherwise the server logs plainly.

### Request flow (`forwardRequest` in server.js)

1. localhost clients skip proxy-API-key auth (`isLocal` check); remote clients must send the matching `x-api-key`.
2. `GET /teamclaude/status` returns `AccountManager.getStatus()` (credential-free).
3. **`POST /v1/oauth/token` is relayed untouched** (`relayRaw`) — the client manages its own token lifecycle independently of the proxy's. Never intercept or rewrite it; doing so causes token-rotation conflicts.
4. Body is fully buffered (needed to replay on 429 retry). Hop-by-hop headers, `x-api-key`, and `accept-encoding` are stripped before forwarding (Node `fetch` auto-decompresses, so `content-encoding`/`content-length` are also dropped on the way back).
5. Account acquired via `acquireAccount()` (reserves one of the account's concurrency slots — see Concurrency below); OAuth token refreshed if expiring within 5 min. The slot is released in the request's `finally`; a failover (429/5xx/error) releases the current slot via `releaseHeld()` before recursing onto another account, while a 401 same-account refresh-retry keeps the slot (`ctx.heldIndex`).
6. **429 handling classifies the 429 (`isExhausted`, checked after `updateQuota` folds in the response headers) before acting** — never sleep on `retry-after` holding the client connection:
   - **Account-quota exhaustion** (`anthropic-ratelimit-unified-status: rejected`, or measured utilization ≥ threshold): throttle the account for `retry-after` (clamped to `[1s, 5m]`) and immediately re-dispatch to another available account. When *every* account is throttled, `getActiveAccount` returns `null` and the client gets a `429` to back off itself. This keeps cold-start warm-up fast (an exhausted account is skipped in one round-trip, not a 60s stall).
   - **Non-exhaustion 429** (an account request-rate / concurrency limit — token quota left but hit too fast — or a transient/global limit): fail the request *over* to another available account (per-request exclusion via `ctx.tried429`; `getActiveAccount(exclude)` then picks a different account without disturbing the sticky primary). This spreads the concurrent overflow that use-or-lose otherwise pins onto one account, instead of failing. The account is **not throttled** — throttling on a request-global 429 would poison the fleet for unrelated requests. Only once *every* available account has been tried for this request is the 429 passed through to the client. No account state is mutated either way.

   When the active account crosses `switchThreshold`, the *next* request switches to the highest-priority account (see Account selection below).
7. **Transient network errors** (`ECONNRESET`/`ETIMEDOUT`/`fetch failed`) → `res.destroy()` so the client retries; they are not retried internally.
8. All accounts unavailable → `429` with a `retry-after` computed from the soonest reset.

### Quota tracking (account-manager.js)

Two header families drive rotation, normalized into one model:
- **Unified** (`anthropic-ratelimit-unified-5h/7d-utilization` + `-reset`) — Claude Max/Pro. Utilization is already `0–1`.
- **Standard** (`anthropic-ratelimit-tokens/requests-*`) — API-key accounts; utilization is derived as `1 - remaining/limit`.

**Model-scoped weekly windows** (`anthropic-ratelimit-unified-7d_<label>-*`, currently `7d_oi` — the separate weekly limit for the top model tier, shown as "Fable" in Claude's usage UI) are parsed generically into `quota.modelWeekly` and surfaced in the TUI (third `Fbl` bar on wide terminals) and `teamclaude status`. They are **display-only — never fed into `_isNearQuota`/availability**, because an account over its Fable weekly limit still serves every other model; excluding it would wrongly block Sonnet/Haiku traffic. These headers only appear on responses to requests *for that model tier*, so the value updates only when such traffic flows through the account.

`switchThreshold` (default `0.98`) is the cutoff above which an account is treated as full and skipped. Expired quota windows (including model-scoped ones) are lazily cleared inside `_isNearQuota`.

### Account selection (`getActiveAccount` in account-manager.js)

**Cold-start warm-up first**: quota is only populated after a request flows through an account (`updateQuota`), so `_nextWarmup` round-robins across the still-**unmeasured** available accounts (`_isWarmupTarget`) and `getActiveAccount` routes to them before any priority decision. Warm-up keys on `_isMeasured` (has the account ever returned rate-limit headers?), **not** on "has it made a request" — a response with no rate-limit headers (a `HEAD /`, a 404, an auth failure) must not permanently mark an account measured, or it gets trapped as unmeasured forever (sorted last by use-or-lose, bounced by the rebalance below), never used and never refreshed. `maxWarmupTries` provides the loop-safety: a genuinely dead account (always header-less / 401) is abandoned after a few attempts. An expired-token account resolves on its first warm-up routing — `ensureTokenFresh` refreshes it into a measurable state or marks it `error`. Only once no unmeasured account remains does priority selection run.

Selection is then **use-or-lose**, not round-robin: among accounts under the threshold, `_selectBest` picks the one whose **weekly (7d) quota resets soonest** (`_weeklyResetTime`) — the weekly window is the scarce resource, so an account whose week is about to renew (and whose unspent quota would be wasted) is drained first — tie-broken by **soonest session reset** (`_sessionResetTime`), then **lowest session utilization** (`_sessionUtilization`). Accounts with no weekly data (API-key, or an expired/unmeasured 7d window) rank at `Infinity` and tie, so the session tiebreak reproduces the pre-weekly ordering for them. The session/utilization helpers fall back from unified (Max) to standard (API-key) metrics.

**Manual controls layered on top (don't change the use-or-lose core when unused):**
- **Disable / enable** (`setEnabled`, config `enabled: false`): a disabled account is excluded from rotation by a single gate in `_isAvailable` (which every selection path — warm-up, `_selectBest`, `_cappedSet`, `anyUsable/anyCapped`, the sticky-current check — already funnels through; `_recoverSoonest` skips disabled accounts itself). In-flight requests on a just-disabled account **drain** (the flag doesn't touch `inflight`); re-enabling calls `_drainWaiters()` so its freed capacity is handed to any queued waiter immediately. Surfaced as `status` "disabled" in the TUI (the default view has a **`↑/↓`** selection cursor; **`e`** toggles the selected account directly) and `[disabled]` in `teamclaude status`; CLI `teamclaude disable|enable <name>`.
- **Explicit priority / order** (`setPriority`, config `priority: <int>`): `_selectBest` sorts by `_priority` **first** (lower number = preferred), then the existing reset/util use-or-lose as tiebreakers. Unset is `null` → `_priority` returns `Infinity`, so **when no account sets a priority every account ties there and the sort falls through to the original use-or-lose unchanged**. In the TUI this is surfaced as an **order**, not a number: the default view has a **`↑/↓`** selection cursor (the action keys — `s` switch, `e` enable/disable, `o` order — act directly on the selected account; only the destructive `d` keeps a confirmation step), and **`o`** grabs the selected account into a move mode where **`↑/↓` reorder** it and **`a` un-ranks it back to `auto`** in one keypress (`_keyNormal` / `_moveOrder` / `_setAutoOrder` in tui.js). Ranked accounts get contiguous priorities `0,1,2,…` and render as `#1 #2 …` (most-preferred first, shown above the rest); moving an unranked account up ranks it at the bottom of the ranked group, moving the last ranked account down un-ranks it back to use-or-lose — so you pin a few accounts and the rest stay on the auto rotation (weekly reset soonest first). The TUI list is sorted by this order (`_displayList`: ranked first, then unranked in array order). A move renumbers to contiguous values, normalizing any legacy/duplicate priority numbers. CLI `teamclaude priority <name> <n|auto|clear>` still accepts raw numbers.
- **Prompt re-pick on change** (`_reprioritize`, called by both setters): a preference change re-picks the active account *directly* and at once — but only when it actually matters, i.e. the current account is no longer usable, or another account is **strictly preferred** by the full order (`_strictlyPrefer`: priority → soonest reset → least used). A no-op (or a change that doesn't dethrone the current) leaves the sticky primary untouched, so it can't churn cache locality, and it does **not** poke `lastEvalAt` (which would wake the periodic tie round-robin). This makes a change take effect immediately even with the re-eval timer off (`reevalIntervalMs <= 0`), and lets clearing a priority restore use-or-lose routing.
- **Interaction with connection affinity (intended):** `_reprioritize` moves the *global* sticky primary, but a live keep-alive connection with an established `_affinity` home keeps routing to that home (cache locality) — exactly as it already does for the periodic `reevalIntervalMs` re-prioritization. So an explicit **priority** change routes **new** connections by the new order immediately, while existing keep-alive connections follow it once their socket closes (or their account caps). **Disable** is different: it's a hard exclusion, and the affinity path requires an *available* home (`_isAvailable`), so a disabled account drops its keep-alive connections on their next acquire too. Set `config.sessionAffinity: false` to route every request purely by priority/use-or-lose with no connection pinning.
- Both fields persist in `config.accounts[]` (survive token-refresh writes and `saveConfig`), and `syncAccountsFromDisk` applies disk changes to the live `AccountManager` on reload (TUI **R** / restart) so a CLI `disable`/`priority` while the server runs takes effect without an edit race.

To balance this against Anthropic's per-account prompt cache (separate per org → switching mid-stream causes cache-miss cost), the active account is **sticky**: priority is only re-evaluated once per `reevalIntervalMs` (default 5 min, `config.reevalIntervalMs`), plus immediately whenever the current account becomes unavailable (over threshold / throttled / error). `lastEvalAt = 0` forces a priority pick on the first request. When all accounts are over threshold, `_recoverSoonest` returns the soonest-to-reset (and `getActiveAccount` returns `null` until then, yielding a `429`).

### Active warm-up (server.js) — populate the whole fleet after a restart

The cold-start warm-up above is **passive**: it only measures an account when a *client* request happens to route there, so on a fresh (re)start the dashboard shows most accounts as "—" until traffic organically reaches each one — Anthropic has **no "get my quota" endpoint**, so quota is only ever learned from real `/v1/messages` rate-limit response headers. **Active warm-up** (`createProxyServer`, gated by `config.activeWarmup` — default on) closes that gap by proactively probing the unmeasured accounts:

- **Capture-and-replay template.** The first genuine `POST /v1/messages` that passes through is snapshotted into `probeTemplate = { model, version, beta, system }` (path-exact, so `/v1/messages/count_tokens` isn't mistaken for inference). Replaying a *known-accepted* shape — the exact model, `anthropic-version`/`anthropic-beta`, and the Claude-Code `system` prompt an OAuth request requires — means a probe can't fail with a guessed-wrong 4xx, and never needs hardcoded model/beta strings that drift.
- **Minimal probe.** `warmupAccount` refreshes the account's token (`ensureTokenFresh`), sends a `max_tokens: 1` `/v1/messages` with that account's own auth header (`Bearer` for OAuth, `x-api-key` otherwise), folds the response's `anthropic-ratelimit-*` headers into `updateQuota`, and cancels the body. It's **best-effort**: any failure just leaves the account unmeasured exactly as before — client traffic is never affected. Probes run **outside** the concurrency-cap accounting on purpose: they only ever target `warmupCandidates()` (available **and** unmeasured), which by definition are *not* the sticky account real traffic concentrates on, so a probe can't collide with a client request on the same account's cap.
- **When it runs.** Once the instant the template is first captured — `setImmediate(warmupUnmeasured)` fans out to every unmeasured account in parallel, so the whole fleet is populated within seconds of the **first** post-restart request (not whenever traffic trickles to each account). Then periodically every `config.warmupIntervalMs` (default 5 min; `0` = startup-only) — which also re-populates an account whose quota window just **reset** (its utilization is cleared, so it reads "—" again). `warmupInFlight` prevents overlapping fan-outs; a per-account `_warming` flag prevents duplicate concurrent probes. The interval is `unref`'d (never blocks process exit) and cleared on `server.close()`.
- **Limitation:** on a *totally* cold proxy with **zero** traffic there's no template yet, so nothing is probed until the first real request flows — by design, since that first request is what tells us the known-good header shape. `config.activeWarmup: false` disables capture, the startup fan-out, and the periodic timer entirely.

### Concurrency (per-account cap + overflow queue)

`getActiveAccount` alone funnels every concurrent terminal onto the one sticky account, which then hits Anthropic's per-account rate/concurrency limit (429) while other accounts sit idle. `acquireAccount()`/`releaseAccount()` layer **proactive load spreading** on top **without changing `getActiveAccount`** (so its warm-up / use-or-lose / recover behavior — and the tests that pin it — are untouched):

- Each account has `inflight` (in-flight count) and `maxConcurrent` (cap; `config.maxConcurrentPerAccount` default 3, per-account `maxConcurrent` override). `_tryAcquire` folds **capped** accounts into the exclude set and reuses `getActiveAccount(exclude)` to pick the best account *with a free slot* — filling A to its cap, then B, then C, by use-or-lose priority. JS is single-threaded so select→`inflight++` is race-free.
- When every available account is at its cap, `acquireAccount` **queues** the request (FIFO `_waiters`) up to `config.overflowQueueTimeoutMs` (default 15s); a `releaseAccount` drains waiters. Timeout → `null` → the client gets a `429`. If instead *no account is available at all* (quota-exhausted, not merely capped) it returns `null` immediately (no pointless wait). A queued request is **cancelled if the client disconnects** (an `AbortController` tied to `res` 'close' → `acquireAccount`'s `signal`) so it can't acquire a slot later and burn upstream quota for a response nobody is waiting for.
- **Memory bounds (localhost auth is skipped, so any local process could flood):** `server.js` enforces a global admission cap covering **every body-buffering path** (the proxied path *and* the `/v1/oauth/token` relay) — `inFlightProxied` may not exceed `accountManager.totalCapacity()` (sum of per-account caps + `overflowQueueMaxDepth`, default 256) — and **rejects with `429` before buffering** the body. Per-request body size is capped by `config.maxRequestBytes` (default 32 MiB → `413`, enforced on the proxied path and inside `relayRaw`). Together they bound total buffered memory at roughly `totalCapacity × maxRequestBytes`.
- `forwardRequest` reserves a slot per attempt and releases it on completion (request `finally`) or before a failover recursion (`releaseHeld()`); a 401 same-account refresh-retry keeps the slot. Status/TUI expose `inflight`/`maxConcurrent`.
- **Connection affinity (prompt-cache locality):** `acquireAccount(..., affinityKey)` takes the client **socket** (`req.socket`) as a soft key. The first acquire on a connection remembers its account in a `WeakMap` (`_affinity`, value is the account *object* + an `accounts[i] === a` identity guard against a `removeAccount` re-index; GC'd when the socket closes); subsequent acquires on the same connection **prefer that account**. It's *soft* — honored only if that account is still available, has a free slot, and isn't `exclude`d, else it falls through to normal `_tryAcquire`. So HTTP/1.1 keep-alive (a session's **sequential** turns reuse one socket) keeps a terminal on one account (cache warm), while a **concurrent** burst — which necessarily opens separate sockets — still spreads by the cap logic. It never exceeds a cap or revives an exhausted account, so the 429 guarantees and use-or-lose for *new* connections are unchanged. It also **defers to cold-start warm-up** (skipped while any account is still a warm-up target) so it can't pin all of one connection's traffic to a single account and starve the others of quota data; only object/function keys are honored (a primitive key is ignored, never a `WeakMap` throw). Crucially this also blunts the periodic `reevalIntervalMs` re-prioritization: when the global sticky primary moves, live connections keep their own account (no mass cache-bust); only new connections follow the new primary. **Caveat:** the key is the TCP socket, so "session" = connection. The normal case (one Claude Code process per terminal → its own connection) maps 1:1, but an intermediary that multiplexes *unrelated* logical sessions onto one keep-alive socket (e.g. a pooling agent with `maxSockets: 1`) would make them share an affinity and defer use-or-lose rotation until that account caps/exhausts — set `config.sessionAffinity: false` for such a front-end. Disabling routes purely by use-or-lose every request.

### Concurrency semantics & limits (what the cap is and isn't)

- The cap is on **concurrent in-flight requests per account, not "terminals."** A terminal is usually idle (waiting on the user / model), so it holds a slot only mid-request. `maxConcurrent: 3` means "≤3 requests upstream *at once* on this account," which is the right unit for burst rate-limiting — not a hard binding of 3 terminals to an account.
- **Spreading only kicks in on overflow.** While concurrent in-flight ≤ cap, traffic concentrates on the sticky primary (good for cache); other accounts stay idle until the primary is capped, then fill by use-or-lose. To spread *eagerly* across accounts, lower `maxConcurrentPerAccount` (e.g. `1`) at the cost of intra-account cache sharing.
- **The cap stops *burst / request-rate* 429s, not *quota-exhaustion* 429s.** A single large request can still exhaust an account's 5h/7d token quota with one slot in use; that path is handled separately (`isExhausted` → throttle the account + switch, in `forwardRequest`). Two complementary mechanisms — the cap is not a blanket 429 cure.
- **Caps are per-process.** Running two proxy instances against the same accounts does not share `inflight`, so combined concurrency can exceed the per-account intent. Single-proxy is the design assumption.

### Server lifecycle (status / stop / restart)

The running `server` writes a **state file** next to the config (`getServerStatePath()` → `<config>.server.json`: `{ pid, port, startedAt }`) on listen and removes it on exit (a SIGKILL leaves a stale file that the next command detects as dead and cleans up). `findRunningServer` probes candidate ports — the **state file's recorded port first** (it may differ from the current config port after an edit, and probing only the config port would miss → orphan the live server), then the config port — and accepts a port only if it answers a TeamClaude-shaped `/teamclaude/status` (a foreign process is *not* mistaken for ours → falls through to the EADDRINUSE message). The owning pid is resolved authoritatively via `lsof` (never a possibly-recycled state-file pid); the state-file pid is only a fallback when `lsof` is unavailable. The state file is cleared only when no candidate answers **and** its recorded pid is dead. `stop`/`restart` use this to SIGTERM→(wait)→SIGKILL the server, and `server` refuses to start a duplicate on an occupied port with a pointer to `stop`/`restart` instead of a raw bind error.

## The thing that's actually hard: config ⇄ memory synchronization

Most of the commit history is token-rotation/sync bug fixes. There are **three concurrent writers** to the config file:
1. The running server persisting refreshed OAuth tokens (`onTokenRefresh` callback in `index.js`).
2. The TUI's `saveConfig` (after import/add/remove).
3. External `teamclaude import`/`login` run while the server is up (picked up via TUI **R** / `syncAccountsFromDisk`).

Rules every config write must follow (see `atomicConfigUpdate`, `findConfigAccount`, `syncAccountsFromDisk`):
- **Always re-read disk before writing.** `atomicConfigUpdate(updater)` does this; never blind-`saveConfig` from a long-lived in-memory copy, or you clobber accounts added by another process.
- **Match accounts by `accountUuid` first, then by `name`.** Indexes shift; this matching is the dedup/sync key used everywhere.
- **Never overwrite fresher tokens with staler ones.** `syncAccountsFromDisk` compares `expiresAt` (`diskIsStaler`) before applying disk credentials over in-memory ones.
- Treat `AccountManager.accounts[i].credential/refreshToken/expiresAt` as the authoritative *live* tokens; the `config.accounts` array can lag.

Related gotcha: **`expiresAt` may arrive in seconds or milliseconds.** OAuth endpoints return seconds; Claude Code credentials use milliseconds. Always pass through `normalizeExpiresAt` (oauth.js) — assuming one unit was a recurring bug.

## Other intentional behaviors

- **`run` deliberately sets only `ANTHROPIC_BASE_URL`, not `ANTHROPIC_API_KEY`** — this keeps Claude Code in subscription mode (full model access) while routing through the proxy, which accepts the client's own OAuth token from localhost.
- **Account dedup** happens in `accounts` command and on every upsert: by `accountUuid`, keeping the most recently added.
- Token refresh is **coalesced** via `account._refreshPromise` so concurrent requests trigger one refresh.
- Streaming responses must check `res.destroyed` to stop pulling from upstream when the client disconnects, and handle backpressure by racing `drain` against `close`.
- Log lines are prefixed `[TeamClaude]`; the TUI strips that prefix when mirroring `console.log`/`console.error` into its activity pane. Credentials are masked (sliced) in `--log-to` request dumps.
