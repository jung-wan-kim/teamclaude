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

// Regression (adversarial review): an account both THROTTLED (rateLimitedUntil,
// clamped to <=5m by the exhaustion-429 path) AND over its utilization threshold
// with a far-off reset is only usable once the LATER of the two clears. Returning
// the shorter throttle made the client re-flood every 5 min while the account was
// still quota-exhausted. retry-after must track max(throttle, binding reset).
test('throttled AND utilization-exhausted → retry-after waits for the later reset, not the 5m throttle', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const throttleMs = Date.now() + 300_000;   // 5-min throttle clamp
  const resetMs = Date.now() + 3600_000;     // real 5h reset ~1h out
  for (const acct of am.accounts) {
    acct.status = 'throttled';
    acct.rateLimitedUntil = throttleMs;
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
    assert.ok(ra > 3000 && ra <= 3600, `should wait for the 5h reset (~3600), not the 300s throttle, got ${ra}s`);
  } finally {
    proxy.close();
  }
});

// Regression (adversarial review): a standard/API-key account's token and
// request windows reset at DIFFERENT times, but resetsAt collapses them
// (preferring the sooner token reset). With BOTH windows over threshold the
// account only frees at the LATER reset — returning the token reset (60s here)
// made clients re-flood every minute while the request window (1h) still
// blocked. retry-after must use each window's own reset and take the max.
test('API-key both windows exhausted → retry-after waits for the later window, not the sooner token reset', async () => {
  const am = new AccountManager([
    { name: 'k', type: 'api', apiKey: 'sk-test' },
  ], 0.98);
  const now = Date.now();
  const acct = am.accounts[0];
  acct.quota.tokensLimit = 100;
  acct.quota.tokensRemaining = 0;      // utilization 1.0 ≥ threshold
  acct.quota.requestsLimit = 100;
  acct.quota.requestsRemaining = 0;    // utilization 1.0 ≥ threshold
  acct.quota.tokensReset = new Date(now + 60_000).toISOString();     // tokens free in 60s
  acct.quota.requestsReset = new Date(now + 3600_000).toISOString(); // requests free in 1h
  acct.quota.resetsAt = acct.quota.tokensReset; // what updateQuota's collapse would store
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
    assert.ok(ra > 3000 && ra <= 3600, `should wait for the 1h request reset, not the 60s token reset, got ${ra}s`);
  } finally {
    proxy.close();
  }
});

// Regression (adversarial review round 3): the expired-window sweep must clear
// each standard window INDEPENDENTLY. Sweeping both on the collapsed resetsAt
// (token-first) freed the account the moment the sooner token window reset,
// even though the request window still blocked it for ~an hour — traffic then
// flowed to an account upstream would 429. After the token reset passes, the
// account must STAY unavailable (429 tracking the request window's reset).
test('token window expired but request window still blocked → account stays unavailable', async () => {
  const am = new AccountManager([
    { name: 'k', type: 'api', apiKey: 'sk-test' },
  ], 0.98);
  const now = Date.now();
  const acct = am.accounts[0];
  acct.quota.tokensLimit = 100;
  acct.quota.tokensRemaining = 0;
  acct.quota.requestsLimit = 100;
  acct.quota.requestsRemaining = 0;    // still exhausted for another hour
  acct.quota.tokensReset = new Date(now - 1_000).toISOString();      // token reset PASSED
  acct.quota.requestsReset = new Date(now + 3600_000).toISOString(); // requests free in 1h
  acct.quota.resetsAt = acct.quota.tokensReset; // collapsed value points at the passed reset
  const proxy = startProxy(am, 0);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429, 'account must remain blocked by the request window');
    const ra = parseInt(res.headers.get('retry-after'), 10);
    assert.ok(ra > 3000 && ra <= 3600, `should wait for the 1h request reset, got ${ra}s`);
    // The sweep cleared only the token window; the request window survived.
    assert.equal(acct.quota.tokensLimit, null);
    assert.equal(acct.quota.requestsLimit, 100);
  } finally {
    proxy.close();
  }
});

// Regression (adversarial review round 4): a MIXED fleet — one account exhausted
// for hours, another quota-healthy but momentarily at its concurrency cap — must
// NOT tell the client to wait for the exhausted account's reset. The healthy
// account's slot frees in seconds, so it caps the fleet wait at the short
// fallback (60s).
test('mixed exhausted + healthy-capped fleet → retry-after stays short, not the exhausted reset', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 5 * 60 * 1000, 1); // maxConcurrentPerAccount = 1
  // A: exhausted, resets in ~1h. B: healthy (10%) but its only slot is taken.
  am.accounts[0].quota.unified5h = 0.995;
  am.accounts[0].quota.unified5hReset = Date.now() + 3600_000;
  am.accounts[1].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5hReset = Date.now() + 3600_000;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: 'http://127.0.0.1:0',
    activeWarmup: false,
    overflowQueueTimeoutMs: 50, // time the queued request out fast
  });
  const proxyPort = await listen(proxy);
  am.accounts[1].inflight = 1; // B capped by an in-flight request

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    const ra = parseInt(res.headers.get('retry-after'), 10);
    assert.equal(ra, 60, `healthy-capped B should cap the wait at 60s, got ${ra}s`);
  } finally {
    proxy.close();
  }
});
