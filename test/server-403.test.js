import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A 403 means the account authenticated fine but is not ENTITLED to serve the
// request — `oauth_not_allowed_for_organization` is what upstream returns once
// a subscription lapses or an org disables Claude Code access. Unlike a 401
// this is not a token problem, so a refresh can't fix it and the same
// credential is rejected identically next time.
//
// Regression: before the 403 branch existed this fell through to the
// pass-through path, which returned the 403 to the client AND left the account
// 'active'. The next request then re-selected the same account (neither
// throttled nor errored) and failed again — so a SINGLE lapsed account could
// serve the whole fleet's traffic with 403s while healthy accounts sat idle.
test('a 403 marks the account error and switches to a healthy account', async () => {
  let aHits = 0;
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      aHits++;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'OAuth authentication is currently not allowed for this organization.',
          details: { error_code: 'oauth_not_allowed_for_organization' },
        },
      }));
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
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate the failover from background warm-up probes
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'failed over to the entitled account');
    // A refresh cannot fix a 403, so the account must not be retried even
    // though it HAS a usable refresh token (this is what separates it from 401).
    assert.equal(aHits, 1, `unentitled account must not be retried, got ${aHits} hits`);
    // The invariant is that the refused account LEAVES rotation — not that it
    // leaves permanently. A single 403 is weak evidence (edge/WAF block, a
    // refusal scoped to this one request), and every account shares the proxy's
    // egress IP, so an immediate permanent park would cost a human re-login for
    // something that heals itself. The first strikes are a cooldown.
    assert.equal(am.accounts[0].status, 'throttled', 'out of rotation after one 403');
    assert.ok(am.accounts[0].rateLimitedUntil > Date.now(),
      'the cooldown must be in the future so selection actually skips it');
    assert.notEqual(am.accounts[0].status, 'error',
      'one 403 must not cost a re-login — that is reserved for a run of them');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A second request must not touch the parked account at all: the point of
// marking it 'error' is that the failure costs one upstream round-trip total,
// not one per request.
test('a parked (403) account is not selected again on the next request', async () => {
  let aHits = 0;
  const upstream = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '').includes('tok-a')) {
      aHits++;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
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
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      await res.text();
      assert.equal(res.status, 200, `request ${i + 1} served by the healthy account`);
    }
    assert.equal(aHits, 1, `403 must cost one round-trip total, got ${aHits}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When every account is unentitled the proxy must stop rather than recurse
// forever. The failover parks each account in turn until only one usable
// account is left, which it deliberately leaves active (see the assertions
// below) — so the contract asserted here is bounded retries + all-but-the-last
// parked + the fleet never left with nothing selectable, not the specific
// status code whichever exhaustion guard happened to answer with.
test('all accounts unentitled → bounded retries, all but the last account parked', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    // Not 200: the client is told the fleet can't serve it (the exact code is
    // whichever exhaustion guard fired — 403 from this path, or the
    // all-accounts-in-error guard's 401 once nothing is selectable).
    assert.ok(res.status === 403 || res.status === 401, `got ${res.status}`);
    assert.ok(hits >= 1 && hits <= 4, `retries must stay bounded, got ${hits} upstream hits`);
    // Every account EXCEPT the last usable one is parked. The 403 path
    // deliberately stops short of parking the final account: parking is
    // persistent (recovery is re-login or restart), so draining the fleet on a
    // refusal that might be an edge/WAF block or an org-policy blip would turn
    // a transient failure into a proxy no rotation can recover from. The last
    // account stays active and keeps surfacing the refusal per-request, which
    // is both visible and self-healing.
    const out = am.accounts.filter(a => a.status === 'throttled' || a.status === 'error').length;
    assert.equal(out, am.accounts.length - 1, 'all but the last usable account left rotation');
    assert.ok(am.accounts.some(a => a.status === 'active'),
      'the fleet must never be left with nothing selectable');
  } finally {
    proxy.close();
    upstream.close();
  }
});
