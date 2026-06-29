import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Regression (adversarial review): a 401 (auth failure / revoked token) must
// fail the account out and switch — not get retried as a warm-up target,
// which would route repeated 401s to the client. Account 'a' has no refresh
// token, so the proxy can't refresh it: it must mark 'a' error and switch to
// the healthy account 'b' after a single 401.
test('a 401 marks the account error and switches, without repeated 401s', async () => {
  let aHits = 0;
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      aHits++;
      res.writeHead(401, { 'content-type': 'application/json' }); // no rate-limit headers
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }, // no refreshToken → can't refresh
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 401 failover from background warm-up probes
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200);                  // switched to the healthy account
    assert.equal(aHits, 1, `revoked account must not be retried, got ${aHits} hits`);
    assert.equal(am.accounts[0].status, 'error');   // failed out → excluded from rotation + warm-up
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When every account fails auth, the proxy surfaces a 401 to the client
// (bounded — no infinite retry).
test('all accounts failing auth → returns 401 to the client', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 401 failover from background warm-up probes
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.ok(hits >= 1 && hits <= 4, `expected bounded retries, got ${hits}`);
    assert.ok(am.accounts.every(a => a.status === 'error'));
  } finally {
    proxy.close();
    upstream.close();
  }
});
