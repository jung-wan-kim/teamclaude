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

// Regression (adversarial review): a NON-exhaustion 429 (transient / global /
// IP / request-level) must NOT be replayed across the fleet. A single such
// request must hit upstream exactly once, leave every account active (not
// throttled), and pass the 429 through to the client.
test('non-exhaustion 429 passes through without poisoning the fleet', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    // Blanket 429 with NO quota signals — a request-level/global limit.
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
    assert.equal(res.status, 429);                                  // passed through to client
    assert.equal(upstreamHits, 1, `expected no fan-out, got ${upstreamHits} hits`);
    assert.ok(am.accounts.every(a => a.status === 'active'),        // no account poisoned
      `expected all accounts active, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});
