import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isTokenExpiringSoon } from './oauth.js';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  // How long a request may wait for a per-account concurrency slot to free when
  // every available account is at its cap, before giving up with a 429. 0 = never
  // queue (fail fast). Default 15s.
  const queueTimeoutMs = Number.isFinite(config.overflowQueueTimeoutMs)
    ? Math.max(0, config.overflowQueueTimeoutMs)
    : 15000;
  // Cap the buffered request body. The proxy must buffer the whole body to replay
  // it across accounts on a 429/5xx, so an unbounded body is an unbounded buffer.
  const maxBodyBytes = Number.isFinite(config.maxRequestBytes) && config.maxRequestBytes > 0
    ? config.maxRequestBytes
    : 32 * 1024 * 1024;
  // Connection affinity: keep one client connection's sequential requests on the
  // same account for prompt-cache locality (HTTP/1.1 keep-alive reuses the socket
  // for a session's sequential turns). Soft — overflow still spreads. Set
  // `sessionAffinity: false` to route purely by use-or-lose every request instead.
  const sessionAffinity = config.sessionAffinity !== false;
  let requestCounter = 0;
  let inFlightProxied = 0; // proxied (non-status/oauth) requests currently being handled

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  // ── Active warm-up ─────────────────────────────────────────────────────────
  // Quota is only learned from real upstream rate-limit headers (Anthropic has no
  // "get my quota" endpoint), so a freshly (re)started proxy shows the whole fleet
  // as "—" until client traffic happens to flow through every account. Active
  // warm-up fixes that: it stages a request template from the first genuine
  // /v1/messages and COMMITS it only after upstream accepts that request (2xx) —
  // so a model/header combo upstream would reject can't seed a template that makes
  // every probe fail. The committed template (exact model + anthropic-version +
  // anthropic-beta + Claude-Code system) is replayed as a minimal probe
  // (max_tokens: 1) against each still-unmeasured account to populate its quota.
  // It fans out once the instant the template commits (right after the first
  // post-restart request) AND periodically (config.warmupIntervalMs, default 5m;
  // 0 = startup-only). Each probe is best-effort and side-effect-light: it never
  // refreshes tokens or mutates account status, reserves a real cap slot so it
  // can't push an account over maxConcurrent, and only learns from a 2xx (or an
  // account-level quota 429). `config.activeWarmup: false` disables it all.
  const activeWarmup = config.activeWarmup !== false;
  const warmupIntervalMs = Number.isFinite(config.warmupIntervalMs)
    ? Math.max(0, config.warmupIntervalMs)
    : 5 * 60 * 1000;
  const WARMUP_PROBE_TIMEOUT_MS = 15_000;
  let probeTemplate = null;   // committed { model, version, beta, system } — only after a 2xx
  let warmupInFlight = false; // guard against overlapping fan-outs
  let warmupClosed = false;   // set on server close: stop scheduling, abort in-flight probes
  const warmupAbort = new AbortController();

  // Stage a candidate template from a genuine /v1/messages request WITHOUT
  // committing — we only trust the shape once upstream has accepted it (see
  // commitProbeTemplate). Path-exact so /v1/messages/count_tokens isn't taken for
  // inference. Returns the candidate (or null).
  function stageProbeTemplate(req, body) {
    if (!activeWarmup || probeTemplate) return null;
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/messages') return null;
    let json;
    try { json = JSON.parse(body.toString()); } catch { return null; }
    if (!json || typeof json.model !== 'string') return null;
    return {
      model: json.model,
      version: req.headers['anthropic-version'] || '2023-06-01',
      beta: req.headers['anthropic-beta'] || null,
      system: json.system ?? null,
    };
  }

  // Commit a staged template once its request succeeded (2xx), then fan out so the
  // rest of the fleet is measured within seconds of the first post-restart request.
  function commitProbeTemplate(candidate, status) {
    if (!activeWarmup || probeTemplate || warmupClosed) return;
    if (!(status >= 200 && status < 300)) return; // only trust an accepted shape
    probeTemplate = candidate;
    setImmediate(() => { warmupUnmeasured(); });
  }

  function buildProbeBody(t) {
    const b = { model: t.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    if (t.system != null) b.system = t.system; // mirror the real request (OAuth requires the system prompt)
    return JSON.stringify(b);
  }

  // A probe fetch is bounded by BOTH a timeout and server-close, so a scheduled or
  // in-flight probe can't keep sending a credentialed request after teardown.
  // Returns { signal, cleanup }: the caller MUST call cleanup() when the probe
  // settles (success OR failure) so a fast probe doesn't leave its 15s timer and
  // its warmupAbort listener dangling until the timeout fires.
  function probeSignal() {
    const ac = new AbortController();
    if (warmupAbort.signal.aborted) { ac.abort(); return { signal: ac.signal, cleanup() {} }; }
    const onClose = () => ac.abort();
    warmupAbort.signal.addEventListener('abort', onClose, { once: true });
    const t = setTimeout(() => ac.abort(), WARMUP_PROBE_TIMEOUT_MS);
    t.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(t);
      warmupAbort.signal.removeEventListener('abort', onClose);
    };
    return { signal: ac.signal, cleanup };
  }

  // Probe one account: send a minimal /v1/messages with its own auth and fold the
  // rate-limit headers into its quota. Best-effort and side-effect-light:
  //  - Never refreshes tokens — a background refresh failure could mark the account
  //    'error' and pull it from rotation before any real request proved auth. An
  //    OAuth account with an expiring token is left to the client path (which has
  //    the proper 401 → forced-refresh → error handling).
  //  - Does NOT reserve a client concurrency slot. The hard rule is "client traffic
  //    must not break". A probe that shared the per-account cap would inevitably
  //    subtract one client slot, which — with the overflow queue disabled — lets
  //    the proxy itself 429 a client when every slot is momentarily taken (no
  //    account to fail over to). So the cap is left entirely to clients; a probe is
  //    at most ONE extra concurrent request, and only ever on an idle, non-sticky,
  //    unmeasured account (warmupCandidates requires inflight===0; real traffic
  //    concentrates on the *measured* sticky account, not here). maxConcurrent is a
  //    conservative soft cap kept under Anthropic's real per-account limit (see
  //    CLAUDE.md, "the cap is not a hard binding"), so that transient +1 stays
  //    safe — and in the unlikely event it did cause a client rate-429, the
  //    existing 429 failover transparently recovers it, whereas a probe-induced
  //    capacity 429 could not.
  //  - Learns ONLY from a response upstream accepted (2xx) or an account-level
  //    quota 429 ('rejected') — a 4xx / non-exhaustion 429 / 5xx never mutates state.
  async function warmupAccount(account) {
    if (!probeTemplate || warmupClosed || account._warming) return;
    // Don't refresh from a background probe; skip an OAuth account that needs one.
    if (account.type === 'oauth' && isTokenExpiringSoon(account.expiresAt)) return;
    // Re-confirm it's still an available, unmeasured, idle candidate.
    if (!accountManager.warmupCandidates().includes(account)) return;
    account._warming = true;
    const probe = probeSignal();
    try {
      const headers = { 'content-type': 'application/json', 'anthropic-version': probeTemplate.version };
      if (probeTemplate.beta) headers['anthropic-beta'] = probeTemplate.beta;
      if (account.type === 'oauth') headers['authorization'] = `Bearer ${account.credential}`;
      else headers['x-api-key'] = account.credential;

      const res = await fetch(`${upstream}/v1/messages`, {
        method: 'POST', headers, body: buildProbeBody(probeTemplate), signal: probe.signal,
      });
      const rl = {};
      for (const [k, v] of res.headers.entries()) {
        if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
      }
      await res.body?.cancel();
      // Learn ONLY from a response upstream accepted (2xx) or an *account-level*
      // quota 429 — one whose `unified-status` is `rejected` (the account is
      // genuinely over its limit). A non-exhaustion 429 (request-rate / global /
      // transient) carries rate-limit headers too but is NOT account state;
      // folding it in would wrongly mark the account measured/unavailable and
      // break best-effort. updateQuota by OBJECT is reindex-safe; still skip a
      // detached (removed-mid-fetch) account.
      const accountExhausted429 = res.status === 429
        && rl['anthropic-ratelimit-unified-status'] === 'rejected';
      if ((res.ok || accountExhausted429) && Object.keys(rl).length
          && accountManager.accounts[account.index] === account) {
        accountManager.updateQuota(account, rl);
        // Convergence accounting: a probe that leaves the account fully
        // measured resets the fruitless-probe counter; one that leaves it
        // half-measured (a header family missing) counts toward the cap.
        if (accountManager._fullyMeasured(account)) {
          account._partialProbes = 0;
        } else {
          account._partialProbes = (account._partialProbes || 0) + 1;
          account._lastFruitlessProbeAt = Date.now(); // paces the slow retry backstop
        }
        console.log(`[TeamClaude] Warm-up measured account "${account.name}"`);
      } else if (accountManager.accounts[account.index] === account
          && (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429))) {
        // The probe COMPLETED with a DETERMINISTIC fruitless outcome — a 2xx
        // with no rate-limit headers (contract violation that will repeat), or
        // a 4xx (bad shape / revoked auth — same next time). Count it toward
        // the convergence cap so such an upstream/account is not probed every
        // interval forever. Transient trouble — 5xx, a non-exhaustion 429, or
        // a network failure (the catch below) — is deliberately NOT counted: a
        // fully unmeasured account has no reset timestamp, so no sweep would
        // ever clear its counter, and counting a passing blip would abandon it
        // permanently even after upstream recovers.
        account._partialProbes = (account._partialProbes || 0) + 1;
        account._lastFruitlessProbeAt = Date.now(); // paces the slow retry backstop
      }
    } catch (err) {
      // Best-effort: leave the account unmeasured (exactly as before warm-up).
      console.error(`[TeamClaude] Warm-up probe failed for "${account.name}": ${err.message}`);
    } finally {
      probe.cleanup(); // clear the timeout + warmupAbort listener now (not 15s later)
      account._warming = false;
    }
  }

  // Probe every currently-unmeasured idle account in parallel. Guarded so two
  // triggers (first-commit + the interval) can't run overlapping fan-outs.
  async function warmupUnmeasured() {
    if (!activeWarmup || warmupClosed || !probeTemplate || warmupInFlight) return;
    warmupInFlight = true;
    try {
      await Promise.all(accountManager.warmupCandidates().map(a => warmupAccount(a)));
    } finally {
      warmupInFlight = false;
    }
  }

  // Periodic warm-up: re-measures any account that is still unmeasured — including
  // one whose quota window just reset (its utilization is cleared, so the
  // dashboard reads "—" again) — without waiting for client traffic to reach it.
  let warmupTimer = null;
  if (activeWarmup && warmupIntervalMs > 0) {
    warmupTimer = setInterval(() => {
      // Sweep expired quota windows first: a rolled-over window keeps its
      // account "measured" (with stale values) until some request-path sweep
      // runs, and warm-up only probes UNMEASURED accounts — so without this an
      // idle proxy would never re-measure after a reset. Sweep → unmeasured →
      // the fan-out below re-probes → fresh data → ordering/display update.
      accountManager.sweepExpired();
      warmupUnmeasured();
    }, warmupIntervalMs);
    warmupTimer.unref(); // never keep the process alive just for warm-up
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      // Everything below buffers a request body (the OAuth relay AND the proxied
      // path) → global admission control to bound proxy memory: inFlightProxied
      // may not exceed the fleet's useful capacity (sum of per-account caps +
      // overflow queue depth), and we reject BEFORE buffering. Without this, body
      // buffering happens before any queue admission, so N concurrent uploads each
      // buffer up to maxBodyBytes regardless of queue depth — memory would grow
      // with connection count (localhost auth is skipped, so any local process
      // could flood, including via /v1/oauth/token). Bound: totalCapacity × maxBodyBytes.
      if (inFlightProxied >= accountManager.totalCapacity()) {
        req.resume(); // drain & discard the body so the socket isn't leaked
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Proxy at capacity; retry shortly.' },
        }));
        return;
      }
      inFlightProxied++;
      try {
        // Let client token refresh requests pass through to upstream untouched.
        // The proxy manages its own tokens via ensureTokenFresh(); intercepting
        // or rewriting client refreshes would cause token rotation conflicts.
        if (req.method === 'POST' && req.url === '/v1/oauth/token') {
          await relayRaw(req, res, upstream, maxBodyBytes);
          return; // outer finally decrements inFlightProxied
        }

        // Track request
        const reqId = ++requestCounter;
        hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

        // tried429/tried5xx/authRetried hold account OBJECTS (not indexes), and
        // `held` is the acquired account OBJECT — both stable across a concurrent
        // removeAccount() re-index, so a release/exclude can't target the wrong account.
        const ctx = { account: null, status: null, authRetried: new Set(), tried429: new Set(), tried5xx: new Set(), overloadRetries: 0, held: null, queueTimeoutMs, abortSignal: null, affinityKey: sessionAffinity ? req.socket : null };
        try {
          // Buffer request body (needed for retry on 429), bounded by maxBodyBytes.
          const bodyChunks = [];
          let bodyLen = 0;
          let bodyTooLarge = false;
          for await (const chunk of req) {
            bodyLen += chunk.length;
            if (bodyLen > maxBodyBytes) { bodyTooLarge = true; break; }
            bodyChunks.push(chunk);
          }
          if (bodyTooLarge) {
            req.destroy();
            if (!res.headersSent) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: `Request body exceeds ${maxBodyBytes} bytes.` },
              }));
            }
            return;
          }
          const body = Buffer.concat(bodyChunks);

          // Stage a warm-up template from this request (no-op once committed / when
          // warm-up is off). It's COMMITTED only after forwardRequest returns a 2xx
          // below, so a request upstream rejects can't seed a bad template.
          const stagedTemplate = stageProbeTemplate(req, body);

          // Tie an abort signal to client disconnect so a request that's only
          // WAITING in the overflow queue is cancelled if the client goes away —
          // otherwise it would acquire a slot later and be dispatched upstream,
          // burning quota for a response nobody is listening for.
          const ac = new AbortController();
          const onClose = () => ac.abort();
          res.on('close', onClose);
          ctx.abortSignal = ac.signal;
          try {
            await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
            // Commit the warm-up template only after upstream accepted this request
            // (2xx via ctx.status), then fan out to measure the rest of the fleet.
            if (stagedTemplate) commitProbeTemplate(stagedTemplate, ctx.status);
          } finally {
            res.removeListener('close', onClose);
          }
        } catch (err) {
          ctx.status = ctx.status || 502;
          console.error('[TeamClaude] Unhandled error:', err);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'proxy_error', message: 'Internal proxy error' },
            }));
          }
        } finally {
          // Release the concurrency slot held by this request (if any). A failover
          // releases the previous account before re-acquiring, so at this point only
          // the last-held slot remains; releaseAccount guards against double-release.
          if (ctx.held != null) {
            accountManager.releaseAccount(ctx.held);
            ctx.held = null;
          }
          hooks.onRequestEnd?.(reqId, {
            method: req.method, path: req.url,
            account: ctx.account, status: ctx.status,
          });
        }
      } finally {
        inFlightProxied--;
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  // Shut warm-up down the instant a close is REQUESTED, not when the `'close'`
  // event finally fires — that waits for open keep-alive connections to drain,
  // and during that window the interval could still dispatch a credentialed
  // probe. Wrap server.close() to run the (idempotent) shutdown synchronously;
  // keep the `'close'` handler as a fallback for closes that bypass the method.
  // It stops scheduling new fan-outs (warmupClosed), aborts any in-flight /
  // scheduled probe (warmupAbort), and clears the periodic timer.
  const shutdownWarmup = () => {
    if (warmupClosed) return;
    warmupClosed = true;
    warmupAbort.abort();
    if (warmupTimer) clearInterval(warmupTimer);
  };
  const closeServer = server.close.bind(server);
  server.close = (cb) => { shutdownWarmup(); return closeServer(cb); };
  server.on('close', shutdownWarmup);

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 * Buffers the body bounded by maxBodyBytes (else 413) so the untouched
 * `/v1/oauth/token` path can't be used to exhaust proxy memory.
 */
async function relayRaw(req, res, upstream, maxBodyBytes = Infinity) {
  const bodyChunks = [];
  let bodyLen = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    bodyLen += chunk.length;
    if (bodyLen > maxBodyBytes) { tooLarge = true; break; }
    bodyChunks.push(chunk);
  }
  if (tooLarge) {
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Request body exceeds ${maxBodyBytes} bytes.` } }));
    }
    return;
  }
  const body = Buffer.concat(bodyChunks);

  // Abort the relay if the client disconnects, so a hung upstream OAuth endpoint
  // can't pin this connection (and its admission-control inFlightProxied slot)
  // forever. Tied to res 'close'; the listener is removed once we're done.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
      signal: ac.signal,
    });

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    // Client disconnected → we aborted the relay; nothing to respond to.
    if (ac.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  } finally {
    res.removeListener('close', onClose);
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

// Upstream statuses that are transient and safe to retry instead of surfacing to
// the client. 529 = "Overloaded" (Anthropic at capacity); 500/502/503/504 =
// gateway / availability blips. Passing these straight through fails the client's
// turn — e.g. Claude Code prints "API Error: 529 Overloaded" and stops — so
// forwardRequest fails them over to another account and, when the whole fleet is
// overloaded, retries with a bounded exponential backoff before giving up.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 529]);
// Sleep that also resolves immediately if `signal` aborts — so a client that
// disconnects during an overload backoff doesn't keep its account slot reserved
// for the whole (up to multi-second) wait. Cleans up its timer/listener either way.
function sleepOrAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Await `promise`, but stop waiting the instant `signal` aborts (client gone).
// The underlying op (e.g. a coalesced token refresh shared by other requests)
// is NOT cancelled — we only stop *this* request from blocking on it, so its
// account slot can be released promptly. Rejections still propagate.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); },
    );
  });
}

// parseInt with a default that HONORS an explicit 0 — unlike `parseInt(...) || def`,
// which discards a valid 0 (0 is falsy). e.g. TEAMCLAUDE_OVERLOAD_RETRIES=0 must
// actually disable proxy-held backoff retries during an incident, not fall back to
// the default. Mirrors the Number.isFinite guard used for reevalIntervalMs in index.js.
const envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
};

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

  // Select account. On a failover retry (a prior account 429'd / 5xx'd for this
  // request) ctx.tried* is non-empty → pick a different account, skipping the
  // ones already tried.
  const excludeForSelect = (ctx.tried429.size || ctx.tried5xx.size)
    ? new Set([...ctx.tried429, ...ctx.tried5xx])
    : null;

  // Reserve a per-account concurrency slot. On a 401 same-account refresh-retry
  // the slot is already held (ctx.held set, exclude unchanged) → reuse it.
  // Otherwise acquire a fresh slot, waiting briefly if every available account is
  // at its cap (overflow queue) before giving up with a 429. Releasing this slot
  // before any account-switching retry is the caller's job, via releaseHeld().
  let account;
  if (ctx.held != null) {
    account = ctx.held;
  } else {
    account = await accountManager.acquireAccount(excludeForSelect, ctx.queueTimeoutMs, ctx.abortSignal, ctx.affinityKey);
    if (account) ctx.held = account;
  }
  const releaseHeld = () => {
    if (ctx.held != null) {
      accountManager.releaseAccount(ctx.held);
      ctx.held = null;
    }
  };

  // The client disconnected while this request was queued (acquireAccount was
  // cancelled by the abort signal) — nothing to respond to.
  if (!account && (ctx.abortSignal?.aborted || res.destroyed)) return;

  if (!account) {
    ctx.account = '(none available)';
    // If every account is in auth-error state, this is an authentication
    // problem (revoked/expired tokens needing re-login), not a rate limit —
    // return 401 so the client surfaces it instead of pointlessly backing off.
    const accts = accountManager.accounts;
    if (accts.length > 0 && accts.every(a => a.status === 'error')) {
      ctx.status = 401;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `All ${accts.length} accounts failed authentication. Re-login required.`,
        },
      }));
      return;
    }
    ctx.status = 429;
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed. Stop waiting if the client disconnects (the
  // refresh is coalesced/shared, so we don't cancel it — we just don't pin this
  // request's account slot on a possibly-hung token endpoint).
  await raceAbort(accountManager.ensureTokenFresh(account), ctx.abortSignal);
  if (res.destroyed || ctx.abortSignal?.aborted) return; // client gone — outer finally frees the slot

  // The account may have been REMOVED (TUI/CLI delete) during the awaited refresh
  // above (or the 401 forced-refresh that recurses back here). A detached account
  // must not be used to dispatch upstream — its slot release is a no-op and we'd
  // be sending traffic on a credential the operator just retired. Re-select a live
  // account instead. (accounts[i] === account holds only while it's still live.)
  if (accountManager.accounts[account.index] !== account) {
    releaseHeld();
    if (res.destroyed) return; // client gone — outer finally cleans up
    if (retryCount < maxRetries) {
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    // Out of retry budget after repeated removals — respond rather than hang.
    ctx.status = 503;
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Account removed mid-request; retry shortly.' },
      }));
    }
    return;
  }

  if (account.status === 'error' && retryCount < maxRetries) {
    releaseHeld(); // failing over to a different account
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }

  const upstreamUrl = `${upstream}${req.url}`;
  const method = req.method;

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
      // Abort the upstream call when the client disconnects (ctx.abortSignal is
      // tied to res 'close'). Without this, a client that drops mid-SSE while the
      // upstream stalls would leave streamResponse blocked in reader.read(), so
      // the per-account slot and inFlightProxied never release — repeated stalls
      // would leak the proxy to capacity. Aborting rejects the read and unwinds
      // the finally that frees the slot.
      signal: ctx.abortSignal,
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account, rateLimitHeaders);

    // 401 = auth failure (stale or revoked token). For OAuth, attempt one
    // forced token refresh and retry the same account (the token may be stale
    // but still refreshable). If that doesn't fix it — refresh fails, the token
    // is revoked, or it's an API-key account — mark the account 'error' so it's
    // excluded from BOTH selection and warm-up, then switch to another account.
    // Without this, warm-up would keep routing client traffic to a revoked
    // account (it stays unmeasured/active), yielding repeated 401s.
    if (upstreamRes.status === 401) {
      await upstreamRes.body?.cancel();

      if (account.type === 'oauth' && account.refreshToken
          && !ctx.authRetried.has(account)
          && retryCount < maxRetries && !res.destroyed) {
        ctx.authRetried.add(account);
        console.log(`[TeamClaude] 401 on "${account.name}" — forcing token refresh and retrying`);
        await raceAbort(accountManager.ensureTokenFresh(account, true), ctx.abortSignal);
        if (res.destroyed || ctx.abortSignal?.aborted) return; // client gone during refresh
        // ensureTokenFresh only marks 'error' for an expired token; a successful
        // (or non-fatal) refresh leaves status intact → retry the same account.
        if (account.status !== 'error') {
          if (logDir) {
            logSections.push(`=== RESPONSE 401 — forced token refresh, retrying ===`);
            writeRequestLog(logDir, reqId, logSections);
          }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
      }

      // Refresh didn't help (failed / already retried / revoked-but-unexpired)
      // or it's an API-key account — fail this account out and switch.
      if (account.status !== 'error') {
        account.status = 'error';
        console.log(`[TeamClaude] 401 on "${account.name}" — auth failed, marking account error`);
      }
      if (logDir) {
        logSections.push(`=== RESPONSE 401 — auth failure, account marked error ===\n${formatHeaders(upstreamRes.headers)}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (res.destroyed) return;
      if (retryCount < maxRetries) {
        releaseHeld(); // this account is now 'error'; fail over to another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }
      // Every account failed auth — surface the 401 to the client.
      ctx.status = 401;
      if (!res.headersSent) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'All accounts failed authentication.' },
        }));
      }
      return;
    }

    // Handle 429s. A 429 can mean two very different things:
    //   (a) this account is out of quota (account-level exhaustion), or
    //   (b) a transient / global / IP / request-level limit that would 429 on
    //       any account.
    // Only (a) should throttle the account and switch; replaying (b) across the
    // fleet would mark every account throttled and break unrelated requests.
    // isExhausted() (checked after updateQuota folds in the 429 headers)
    // distinguishes them.
    if (upstreamRes.status === 429) {
      let retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10);
      if (Number.isNaN(retryAfter)) retryAfter = 60;
      retryAfter = Math.min(Math.max(retryAfter, 1), 300); // clamp [1s, 5m]
      // Discard the 429 response body
      await upstreamRes.body?.cancel();

      if (accountManager.isExhausted(account)) {
        // (a) Account-level exhaustion: throttle this account (so
        // getActiveAccount skips it until it resets) and immediately
        // re-dispatch to another available account — never sleep holding the
        // client. When every account is throttled, getActiveAccount returns
        // null and the client gets a 429 to back off on its own.
        console.log(`[TeamClaude] 429 (quota exhausted) on "${account.name}" — throttling ${retryAfter}s, switching accounts`);
        accountManager.markRateLimited(account, retryAfter);
        if (logDir) {
          logSections.push(`=== RESPONSE 429 — account quota exhausted, throttled ${retryAfter}s, switching ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
        if (res.destroyed) return;

        // Safety backstop: each retry throttles a distinct account, so
        // getActiveAccount returns null before this can fire. Cap anyway.
        if (retryCount >= maxRetries) {
          ctx.status = 429;
          const ra = computeRetryAfter(accountManager.getStatus().accounts);
          if (!res.headersSent) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(ra) });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: `All accounts throttled. Retry in ${ra}s.` },
            }));
          }
          return;
        }
        releaseHeld(); // throttled this account; switch to another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // (b) Non-exhaustion 429: usually an account-level request-rate /
      // concurrency limit (the account still has token quota, but is being hit
      // too fast) — or a transient / global limit. Try ANOTHER account for THIS
      // request (per-request exclusion via ctx.tried429) so concurrent overflow
      // spreads to an idle account instead of failing. Crucially we do NOT
      // throttle the account: throttling on a request-global 429 would poison
      // the fleet for unrelated requests. Only when every available account has
      // been tried for this request (→ effectively global) is the 429 passed
      // through to the client; no account state is mutated either way.
      ctx.tried429.add(account);
      if (!res.destroyed && retryCount < maxRetries
          && (accountManager.anyUsable(ctx.tried429) || accountManager.anyCapped(ctx.tried429))) {
        console.log(`[TeamClaude] 429 (rate/transient) on "${account.name}" — switching account for this request`);
        if (logDir) {
          logSections.push(`=== RESPONSE 429 — rate/transient, switching account (not throttled) ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
        releaseHeld(); // free this account's slot before trying another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      console.log(`[TeamClaude] 429 (global) on "${account.name}" — every account tried, passing through`);
      ctx.status = 429;
      if (logDir) {
        logSections.push(`=== RESPONSE 429 — global, passed through after trying all accounts ===\n${formatHeaders(upstreamRes.headers)}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: `Upstream rate limited (retry in ${retryAfter}s).` },
        }));
      }
      return;
    }

    // Handle retryable upstream 5xx (notably 529 "Overloaded" — Anthropic is over
    // capacity). Unlike a 429, a 529 is NOT account-specific: every account hits
    // the same overloaded upstream. Surfacing it fails the client's turn, so:
    //   (1) fail this request over to another account (cheap; for 500/502/503/504 a
    //       different account/region is occasionally healthier), then
    //   (2) once every account has 5xx'd for this request, wait a bounded
    //       exponential backoff and retry the whole fleet — the client transparently
    //       gets the eventual success instead of an error.
    // Only after the backoff budget is spent is the 5xx surfaced (so the client is
    // never left hanging indefinitely). No account state is mutated — a 529 is
    // upstream overload, not a bad account.
    if (RETRYABLE_STATUS.has(upstreamRes.status)) {
      const code = upstreamRes.status;
      await upstreamRes.body?.cancel();

      const maxOverload = Math.max(0, envInt('TEAMCLAUDE_OVERLOAD_RETRIES', 6));
      const backoffBase = Math.max(50, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS', 1000));
      const backoffCap = Math.max(backoffBase, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 10000));

      // (1) Per-request failover to an account not yet 5xx'd (or 429'd) this request.
      ctx.tried5xx.add(account);
      const exclude5xx = new Set([...ctx.tried429, ...ctx.tried5xx]);
      if (!res.destroyed && retryCount < maxRetries
          && (accountManager.anyUsable(exclude5xx) || accountManager.anyCapped(exclude5xx))) {
        console.log(`[TeamClaude] ${code} on "${account.name}" — switching account for this request`);
        if (logDir) {
          logSections.push(`=== RESPONSE ${code} — transient upstream 5xx, switching account ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
        releaseHeld(); // free this account's slot before trying another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // (2) Every account 5xx'd for this request → upstream overload. Back off and
      // retry the whole fleet so the client transparently rides out the blip.
      if (!res.destroyed && ctx.overloadRetries < maxOverload) {
        const waitMs = Math.min(backoffBase * 2 ** ctx.overloadRetries, backoffCap);
        ctx.overloadRetries += 1;
        console.log(`[TeamClaude] ${code} on every account — upstream overloaded, backing off ${waitMs}ms (retry ${ctx.overloadRetries}/${maxOverload})`);
        if (logDir) {
          logSections.push(`=== RESPONSE ${code} — all accounts overloaded, backoff ${waitMs}ms (retry ${ctx.overloadRetries}/${maxOverload}) ===`);
          writeRequestLog(logDir, reqId, logSections);
        }
        await sleepOrAbort(waitMs, ctx.abortSignal);
        // Client gone during the backoff → bail; the outer finally releases the
        // slot promptly instead of holding it for the rest of the wait.
        if (res.destroyed || ctx.abortSignal?.aborted) return;
        ctx.tried5xx.clear(); // fresh round: let every account be tried again
        releaseHeld();        // re-acquire from the full set on the next round
        return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      }

      // (3) Backoff budget spent — surface the 5xx rather than hold the client forever.
      console.log(`[TeamClaude] ${code} on "${account.name}" — overload persisted after ${ctx.overloadRetries} backoffs, passing through`);
      ctx.status = code;
      if (logDir) {
        logSections.push(`=== RESPONSE ${code} — overload persisted after ${ctx.overloadRetries} backoffs, passed through ===\n${formatHeaders(upstreamRes.headers)}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: `Upstream overloaded (HTTP ${code}). Retried ${ctx.overloadRetries}x.` },
        }));
      }
      return;
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end();
      return;
    }

    const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

    if (isStreaming) {
      const streamLog = logDir ? [] : null;
      await streamResponse(upstreamRes.body, res, account, accountManager, streamLog);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account, accountManager);
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    // Client disconnected → we aborted the upstream fetch (ctx.abortSignal). This
    // is not the account's fault: don't mark it 'error' or fail over (the client
    // is gone). Just unwind — the outer finally releases the slot / inFlightProxied.
    if (ctx.abortSignal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }

    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');

    // Transient network errors: just close the connection and let the client retry
    if (isTransient) {
      res.destroy();
      return;
    }

    if (retryCount < maxRetries && !res.headersSent) {
      account.status = 'error';
      releaseHeld(); // this account errored; fail over to another
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, account, accountManager, streamLog) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, account, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, account, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, account, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(account, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(account, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, account, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(account, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = acct.rateLimitedUntil || acct.quota.resetsAt;
    if (reset) {
      const ms = new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}
