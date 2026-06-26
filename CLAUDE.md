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

`switchThreshold` (default `0.98`) is the cutoff above which an account is treated as full and skipped. Expired quota windows are lazily cleared inside `_isNearQuota`.

### Account selection (`getActiveAccount` in account-manager.js)

**Cold-start warm-up first**: quota is only populated after a request flows through an account (`updateQuota`), so `_nextWarmup` round-robins across the still-**unmeasured** available accounts (`_isWarmupTarget`) and `getActiveAccount` routes to them before any priority decision. Warm-up keys on `_isMeasured` (has the account ever returned rate-limit headers?), **not** on "has it made a request" — a response with no rate-limit headers (a `HEAD /`, a 404, an auth failure) must not permanently mark an account measured, or it gets trapped as unmeasured forever (sorted last by use-or-lose, bounced by the rebalance below), never used and never refreshed. `maxWarmupTries` provides the loop-safety: a genuinely dead account (always header-less / 401) is abandoned after a few attempts. An expired-token account resolves on its first warm-up routing — `ensureTokenFresh` refreshes it into a measurable state or marks it `error`. Only once no unmeasured account remains does priority selection run.

Selection is then **use-or-lose**, not round-robin: among accounts under the threshold, `_selectBest` picks the one whose **session resets soonest** (`_sessionResetTime`), tie-broken by **lowest session utilization** (`_sessionUtilization`) — so quota that would otherwise reset unused is spent first. Both helpers fall back from unified (Max) to standard (API-key) metrics.

To balance this against Anthropic's per-account prompt cache (separate per org → switching mid-stream causes cache-miss cost), the active account is **sticky**: priority is only re-evaluated once per `reevalIntervalMs` (default 5 min, `config.reevalIntervalMs`), plus immediately whenever the current account becomes unavailable (over threshold / throttled / error). `lastEvalAt = 0` forces a priority pick on the first request. When all accounts are over threshold, `_recoverSoonest` returns the soonest-to-reset (and `getActiveAccount` returns `null` until then, yielding a `429`).

### Concurrency (per-account cap + overflow queue)

`getActiveAccount` alone funnels every concurrent terminal onto the one sticky account, which then hits Anthropic's per-account rate/concurrency limit (429) while other accounts sit idle. `acquireAccount()`/`releaseAccount()` layer **proactive load spreading** on top **without changing `getActiveAccount`** (so its warm-up / use-or-lose / recover behavior — and the tests that pin it — are untouched):

- Each account has `inflight` (in-flight count) and `maxConcurrent` (cap; `config.maxConcurrentPerAccount` default 3, per-account `maxConcurrent` override). `_tryAcquire` folds **capped** accounts into the exclude set and reuses `getActiveAccount(exclude)` to pick the best account *with a free slot* — filling A to its cap, then B, then C, by use-or-lose priority. JS is single-threaded so select→`inflight++` is race-free.
- When every available account is at its cap, `acquireAccount` **queues** the request (FIFO `_waiters`) up to `config.overflowQueueTimeoutMs` (default 15s); a `releaseAccount` drains waiters. Timeout → `null` → the client gets a `429`. If instead *no account is available at all* (quota-exhausted, not merely capped) it returns `null` immediately (no pointless wait). A queued request is **cancelled if the client disconnects** (an `AbortController` tied to `res` 'close' → `acquireAccount`'s `signal`) so it can't acquire a slot later and burn upstream quota for a response nobody is waiting for.
- **Memory bounds (localhost auth is skipped, so any local process could flood):** `server.js` enforces a global admission cap — `inFlightProxied` may not exceed `accountManager.totalCapacity()` (sum of per-account caps + `overflowQueueMaxDepth`, default 256) — and **rejects with `429` before buffering** the body. The queue depth (`overflowQueueMaxDepth`) and per-request body size (`config.maxRequestBytes`, default 32 MiB → `413`, enforced on the proxied path *and* in `relayRaw` for `/v1/oauth/token`) together bound total buffered memory at roughly `totalCapacity × maxRequestBytes`.
- `forwardRequest` reserves a slot per attempt and releases it on completion (request `finally`) or before a failover recursion (`releaseHeld()`); a 401 same-account refresh-retry keeps the slot. Status/TUI expose `inflight`/`maxConcurrent`.

### Server lifecycle (status / stop / restart)

The running `server` writes a **state file** next to the config (`getServerStatePath()` → `<config>.server.json`: `{ pid, port, startedAt }`) on listen and removes it on exit (a SIGKILL leaves a stale file that the next command detects as dead and cleans up). `findRunningServer` trusts the state file when the pid is alive **and** the port answers a TeamClaude-shaped `/teamclaude/status` (a foreign process on the port is *not* mistaken for ours → falls through to the EADDRINUSE message); otherwise it probes the port + `lsof`s the pid. `stop`/`restart` use this to SIGTERM→(wait)→SIGKILL the server, and `server` refuses to start a duplicate on an occupied port with a pointer to `stop`/`restart` instead of a raw bind error.

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
