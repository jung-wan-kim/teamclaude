import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startProxy(am, upstreamPort) {
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 429 failover from background warm-up probes
  });
  return proxy;
}

// An exhaustion 429 carries upstream quota signals (here: unified-status:
// rejected). These should throttle the account and switch.
function exhaustion429(res) {
  res.writeHead(429, {
    'retry-after': '300',
    'anthropic-ratelimit-unified-status': 'rejected',
    'content-type': 'application/json',
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
}

// Regression: a genuine account-quota 429 must throttle the account and switch
// immediately to a healthy one — never sleep on retry-after (300s here) holding
// the client connection.
test('account-exhaustion 429 switches to the next account immediately, no sleep', async () => {
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) exhaustion429(res);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);                    // served by the healthy account
    assert.ok(elapsed < 5000, `expected immediate switch, took ${elapsed}ms`); // no 300s sleep
    assert.equal(am.accounts[0].status, 'throttled'); // exhausted account throttled + skipped
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression: when every account is exhausted, the proxy must terminate with a
// bounded number of retries and return 429 — not loop forever.
test('all accounts exhausted → bounded retries, returns 429', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    exhaustion429(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);                                  // returns 429, not hanging
    assert.ok(upstreamHits >= 1 && upstreamHits <= 4,               // each account tried at most once
      `expected bounded retries, got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status === 'throttled'));    // both throttled until reset
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A non-exhaustion 429 (request-rate / concurrency limit) on a busy account
// must fail the request OVER to an idle account — not pass the 429 to the
// client. This is the real-world case: all concurrent traffic pinned to one
// account (use-or-lose primary) hits its RPM limit while it still has token
// quota; the overflow should spill to a healthy account.
test('non-exhaustion 429 fails over to a healthy account (no throttle)', async () => {
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      // Rate/concurrency 429: short retry-after, NO quota-exhaustion signals.
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200);                  // served by the idle account, not 429'd to client
    assert.equal(am.accounts[0].status, 'active');  // rate-limited account NOT throttled (still usable)
    assert.equal(am.accounts[1].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression (adversarial review): a request-GLOBAL 429 (would 429 on every
// account) must not poison the fleet. The request fails over through each
// account once, then passes the 429 through — but leaves EVERY account active
// (no throttle), so unrelated requests are unaffected.
test('request-global 429 tries each account once then passes through, no poisoning', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    // Blanket 429 with NO quota signals — 429s regardless of account.
    res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'c', type: 'oauth', accessToken: 'tok-c', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);                                  // passed through after trying all
    assert.equal(upstreamHits, 3, `expected one try per account, got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status === 'active'),        // no account poisoned/throttled
      `expected all accounts active, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression: when every account is exhausted by measured UTILIZATION (Max 5h/7d
// windows, no live throttle), the all-blocked 429's retry-after must track the
// real window reset — not the flat 60s fallback the client would just re-flood
// against every minute. The old computeRetryAfter only looked at rateLimitedUntil
// / resetsAt (a standard/API-key field Max accounts never set), so a utilization-
// exhausted Max fleet always returned 60s no matter how far off the real reset.
test('all-exhausted-by-utilization → 429 retry-after tracks the real reset, not a flat 60s', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  // Both over the 5h threshold with a reset ~1h out, measured purely from quota
  // state — no upstream 429 needed: acquireAccount returns null and the request
  // never leaves the proxy.
  const resetMs = Date.now() + 3600_000;
  for (const acct of am.accounts) {
    acct.quota.unified5h = 0.995;
    acct.quota.unified5hReset = resetMs;
  }
  const proxy = startProxy(am, 0);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    const ra = parseInt(res.headers.get('retry-after'), 10);
    assert.ok(ra > 3000 && ra <= 3600, `retry-after should track the ~1h reset, got ${ra}s`); // not the old 60
  } finally {
    proxy.close();
  }
});

// A merely concurrency-capped (but quota-healthy) fleet must NOT inherit that
// long reset: its 5h window is under threshold, so its always-future reset is not
// binding and retry-after stays at the short 60s fallback (a slot frees soon).
test('all-capped-but-healthy → 429 retry-after stays short (reset under threshold is not binding)', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 5 * 60 * 1000, 1); // maxConcurrentPerAccount = 1
  // Healthy but with a far-off 5h reset present (utilization well under threshold).
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[0].quota.unified5hReset = Date.now() + 3600_000;
  // Custom proxy with a tiny overflow-queue timeout so the capped request falls
  // to the all-blocked 429 fast instead of waiting the 15s default.
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: 'http://127.0.0.1:0',
    activeWarmup: false,
    overflowQueueTimeoutMs: 50,
  });
  const proxyPort = await listen(proxy);
  am.accounts[0].inflight = 1; // simulate the slot being held by an in-flight request

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    const ra = parseInt(res.headers.get('retry-after'), 10);
    assert.equal(ra, 60, `capped-but-healthy should fall back to 60s, got ${ra}s`);
  } finally {
    proxy.close();
  }
});
