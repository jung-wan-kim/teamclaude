# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TeamClaude is a transparent HTTP proxy that sits between Claude Code and the Anthropic API, managing multiple Claude (Max/Pro/API-key) accounts and rotating between them when one nears its session (5h) or weekly (7d) quota. Published as `@karpeleslab/teamclaude`.

## Commands

There is **no build step and no test suite**. Development is run directly against source.

```bash
node src/index.js <command>        # run any CLI command locally (server is the default)
npm start                          # = node src/index.js (starts the proxy server)
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

- **`src/index.js`** — CLI dispatcher + all non-server commands (`import`, `login`, `env`, `status`, `accounts`, `remove`, `api`). Also owns the **config-sync wiring** between the running server, the TUI, and external CLI invocations (see below).
- **`src/server.js`** — the HTTP proxy and the request-forwarding loop (`forwardRequest`), including account selection, retry, rate-limit handling, SSE streaming, and optional request logging.
- **`src/account-manager.js`** — `AccountManager` class: in-memory account state, round-robin rotation, quota tracking from response headers, and token-refresh coalescing. The single source of truth for *live* credentials while the server runs.
- **`src/oauth.js`** — OAuth PKCE login, token refresh, profile fetch, and credential import from Claude Code. No proxy state here — pure functions.
- **`src/config.js`** — load/save of `~/.config/teamclaude.json` (override via `TEAMCLAUDE_CONFIG`, or `$XDG_CONFIG_HOME`). Written `0o600`.
- **`src/tui.js`** — full-screen terminal dashboard (alternate screen buffer). Only used when both stdin and stdout are TTYs; otherwise the server logs plainly.

### Request flow (`forwardRequest` in server.js)

1. localhost clients skip proxy-API-key auth (`isLocal` check); remote clients must send the matching `x-api-key`.
2. `GET /teamclaude/status` returns `AccountManager.getStatus()` (credential-free).
3. **`POST /v1/oauth/token` is relayed untouched** (`relayRaw`) — the client manages its own token lifecycle independently of the proxy's. Never intercept or rewrite it; doing so causes token-rotation conflicts.
4. Body is fully buffered (needed to replay on 429 retry). Hop-by-hop headers, `x-api-key`, and `accept-encoding` are stripped before forwarding (Node `fetch` auto-decompresses, so `content-encoding`/`content-length` are also dropped on the way back).
5. Account selected via `getActiveAccount()`; OAuth token refreshed if expiring within 5 min.
6. **429 handling classifies the 429 (`isExhausted`, checked after `updateQuota` folds in the response headers) before acting** — never sleep on `retry-after` holding the client connection:
   - **Account-quota exhaustion** (`anthropic-ratelimit-unified-status: rejected`, or measured utilization ≥ threshold): throttle the account for `retry-after` (clamped to `[1s, 5m]`) and immediately re-dispatch to another available account. When *every* account is throttled, `getActiveAccount` returns `null` and the client gets a `429` to back off itself. This keeps cold-start warm-up fast (an exhausted account is skipped in one round-trip, not a 60s stall).
   - **Non-exhaustion 429** (transient / global / IP / request-level — a 429 that would hit *any* account): pass it straight through to the client with the upstream `retry-after`, leaving the account **active**. Do NOT throttle or replay across the fleet — replaying a request-global 429 would poison every account and break unrelated requests. The client (Claude Code) handles its own backoff.

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
