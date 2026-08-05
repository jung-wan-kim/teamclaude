import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { poolQuota } from '../src/tui.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── 403 parking must never empty the fleet ───────────────────
//
// PR #5 parks an account on 403 so one lapsed subscription can't serve the
// whole fleet's traffic. Parking is persistent (recovery is re-login or a
// restart), and a 403 does not only mean "this account lapsed" — an edge/WAF
// block or an org-policy blip surfaces the same way. Applied to the LAST
// usable account that turns a transient refusal into a proxy nothing can
// recover from: the same fleet-wide outage the branch exists to prevent,
// reached from the other side.
//
// The guard is deliberately structural rather than keyed on the upstream error
// code: which codes mean "lapsed" is an upstream detail we can't pin down from
// here, and guessing wrong would silently disable the parking altogether.

test('a 403 on the LAST usable account keeps it active instead of emptying the fleet', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'transient refusal' },
    }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const send = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text().then(() => r.status));

    assert.equal(await send(), 403, 'the refusal is surfaced to the client');
    assert.equal(am.accounts[0].status, 'active',
      'the only account must stay in rotation — parking it would kill the proxy');
    // Exactly one upstream hit. Retrying here would hand the same still-active
    // account straight back, so it buys nothing and costs a second 403 — a
    // duplicate delivery of a possibly non-idempotent body, and double load on
    // an upstream that is already refusing. Asserting "hits went up" is too
    // weak to catch that; the count has to be exact.
    assert.equal(hits, 1, `one client request must cost one upstream 403, got ${hits}`);

    // And the fleet is still able to dispatch: a second request reaches
    // upstream too (if the account had been parked, selection would find
    // nothing and the request would never leave the proxy).
    assert.equal(await send(), 403, 'second request still reaches upstream');
    assert.equal(hits, 2, `second request must add exactly one more hit, got ${hits}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a 403 still parks the account while another one can take over', async () => {
  // Guards the PR #5 behaviour the fix above must not weaken.
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'not entitled' } }));
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
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'failed over to the entitled account');
    assert.equal(am.accounts[0].status, 'error', 'still parked — a healthy account was available');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// ── the pooled FLEET row must not report unusable capacity ───
//
// PR #2 excludes disabled accounts from the pool because they serve no
// traffic. An account parked by the 403 path above serves no traffic either,
// but keeps whatever quota reading it had when it failed — so leaving it in
// drags the pooled figure DOWN and shows runway that does not exist.

test('poolQuota excludes parked accounts, like it excludes disabled ones', () => {
  const q = u => ({ unified5h: u, unified7d: u });
  const mk = (name, u, extra = {}) => ({ name, type: 'oauth', status: 'active', quota: q(u), ...extra });

  const healthy = poolQuota([mk('a', 0.9), mk('b', 0.9)]);
  const withParked = poolQuota([mk('a', 0.9), mk('b', 0.9), mk('lapsed', 0.0, { status: 'error' })]);

  assert.equal(withParked.size, 2, 'the parked account is not counted in the rotation size');
  assert.equal(withParked.cols[0].util, healthy.cols[0].util,
    'a parked account must not dilute the pooled utilisation');
});

test('poolQuota keeps throttled and exhausted accounts — their quota does come back', () => {
  const q = u => ({ unified5h: u, unified7d: u });
  const mk = (name, u, extra = {}) => ({ name, type: 'oauth', status: 'active', quota: q(u), ...extra });

  const p = poolQuota([mk('a', 0.5), mk('b', 1.0, { status: 'throttled' })]);
  assert.equal(p.size, 2, 'a throttled account still holds real, returning capacity');
  assert.ok(Math.abs(p.cols[0].util - 0.75) < 1e-9, 'its utilisation counts toward the pool');
});
