import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
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

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      const ctx = { account: null, status: null, authRetried: new Set(), tried429: new Set(), tried5xx: new Set(), overloadRetries: 0 };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
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
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
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
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

  // Select account. On a failover retry (a prior account 429'd for this
  // request) ctx.tried429 is non-empty → pick a different account, skipping the
  // ones already tried.
  const excludeForSelect = (ctx.tried429.size || ctx.tried5xx.size)
    ? new Set([...ctx.tried429, ...ctx.tried5xx])
    : null;
  const account = accountManager.getActiveAccount(excludeForSelect);
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

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
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
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

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
          && !ctx.authRetried.has(account.index)
          && retryCount < maxRetries && !res.destroyed) {
        ctx.authRetried.add(account.index);
        console.log(`[TeamClaude] 401 on "${account.name}" — forcing token refresh and retrying`);
        await accountManager.ensureTokenFresh(account.index, true);
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

      if (accountManager.isExhausted(account.index)) {
        // (a) Account-level exhaustion: throttle this account (so
        // getActiveAccount skips it until it resets) and immediately
        // re-dispatch to another available account — never sleep holding the
        // client. When every account is throttled, getActiveAccount returns
        // null and the client gets a 429 to back off on its own.
        console.log(`[TeamClaude] 429 (quota exhausted) on "${account.name}" — throttling ${retryAfter}s, switching accounts`);
        accountManager.markRateLimited(account.index, retryAfter);
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
      ctx.tried429.add(account.index);
      if (!res.destroyed && retryCount < maxRetries
          && accountManager.getActiveAccount(ctx.tried429)) {
        console.log(`[TeamClaude] 429 (rate/transient) on "${account.name}" — switching account for this request`);
        if (logDir) {
          logSections.push(`=== RESPONSE 429 — rate/transient, switching account (not throttled) ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
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

      const maxOverload = Math.max(0, parseInt(process.env.TEAMCLAUDE_OVERLOAD_RETRIES, 10) || 6);
      const backoffBase = Math.max(50, parseInt(process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS, 10) || 1000);
      const backoffCap = Math.max(backoffBase, parseInt(process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS, 10) || 10000);

      // (1) Per-request failover to an account not yet 5xx'd (or 429'd) this request.
      ctx.tried5xx.add(account.index);
      const exclude5xx = new Set([...ctx.tried429, ...ctx.tried5xx]);
      if (!res.destroyed && retryCount < maxRetries
          && accountManager.getActiveAccount(exclude5xx)) {
        console.log(`[TeamClaude] ${code} on "${account.name}" — switching account for this request`);
        if (logDir) {
          logSections.push(`=== RESPONSE ${code} — transient upstream 5xx, switching account ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
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
        await sleep(waitMs);
        if (res.destroyed) return;
        ctx.tried5xx.clear(); // fresh round: let every account be tried again
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
      await streamResponse(upstreamRes.body, res, account.index, accountManager, streamLog);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
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
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog) {
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
        parseSSEUsage(event, accountIndex, accountManager);
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
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
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
