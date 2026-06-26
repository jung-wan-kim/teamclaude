import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startProxy(am, upstreamPort) {
  return createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
}

function overloaded529(res) {
  res.writeHead(529, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
}

// A 529 on one account must NOT be surfaced to the client (which would fail the
// turn, e.g. Claude Code "API Error: 529 Overloaded"). The request fails over to
// a healthy account and returns 200 — immediately, with no backoff sleep, and
// without poisoning either account (a 529 is upstream overload, not a bad account).
test('529 on one account fails over to a healthy account, no backoff, no poison', async () => {
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) overloaded529(res);
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
    assert.equal(res.status, 200);                                       // served by healthy account, not 529'd to client
    assert.ok(elapsed < 2000, `expected immediate failover, took ${elapsed}ms`); // no backoff on the failover path
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When EVERY account is overloaded (genuine 529 incident), the proxy must back
// off and retry the whole fleet a bounded number of times, then — only after the
// budget is spent — surface the 529. It must not hang forever and must not
// poison accounts. Backoff timings are shrunk via env so the test stays fast.
test('all accounts 529 → bounded backoff retries, then passes 529 through (no hang, no poison)', async () => {
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '2';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '50';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '60';

  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    overloaded529(res);
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
    assert.equal(res.status, 529);                                  // surfaced only after backoff budget spent
    // 2 accounts × (1 initial fleet sweep + 2 backoff-retry sweeps) = 6 hits; allow slack.
    assert.ok(upstreamHits >= 2 && upstreamHits <= 10, `expected bounded retries, got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
    delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  }
});

// Codex P2 regression: TEAMCLAUDE_OVERLOAD_RETRIES=0 must actually DISABLE the
// proxy-held backoff retries (an operator escape hatch during an incident). An
// explicit 0 is falsy, so `parseInt(...) || 6` used to silently fall back to 6 —
// envInt()'s Number.isFinite guard fixes that. With 0 the request still fails over
// across accounts once, then passes the 529 straight through with NO backoff sleep.
test('TEAMCLAUDE_OVERLOAD_RETRIES=0 disables backoff — failover sweep then immediate passthrough', async () => {
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '0';
  // Make a default-6 fallback obvious if the knob were ignored: each backoff would
  // sleep ≥1s, so honoring 0 keeps this well under that.
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    overloaded529(res);
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
    assert.equal(res.status, 529);                                  // surfaced — retries disabled
    assert.ok(elapsed < 900, `expected no backoff sleep with retries=0, took ${elapsed}ms`);
    assert.equal(upstreamHits, 2, `expected one failover sweep (no backoff rounds), got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
    delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
  }
});
