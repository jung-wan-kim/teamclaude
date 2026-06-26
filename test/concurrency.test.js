import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  }));
}

// Populate quota the way a real upstream response would, so accounts are
// "measured + available" and warm-up doesn't interfere with the cap tests.
function measureAll(am, util = 0.1, resetInMs = HOUR) {
  const now = Date.now();
  am.accounts.forEach((_, i) => am.updateQuota(i, {
    'anthropic-ratelimit-unified-5h-utilization': String(util),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + resetInMs) / 1000)),
  }));
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── unit: AccountManager concurrency layer ────────────────────────────────

test('per-account cap spreads concurrent acquires across accounts, then refuses with no queue', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 2); // cap 2/account, reeval off
  measureAll(am);

  const picks = [];
  for (let i = 0; i < 6; i++) picks.push((await am.acquireAccount(null, 0)).name);

  const counts = {};
  for (const n of picks) counts[n] = (counts[n] || 0) + 1;
  assert.deepEqual(Object.values(counts).sort(), [2, 2, 2]); // each account filled to its cap
  assert.equal(am.accounts.every(a => a.inflight === 2), true);

  // every account is now capped and queue is disabled (timeout 0) → null
  assert.equal(await am.acquireAccount(null, 0), null);
});

test('overflow queues until a slot frees, then resolves to the freed account', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 1); // cap 1/account
  measureAll(am);

  const a0 = await am.acquireAccount(null, 1000);
  const a1 = await am.acquireAccount(null, 1000);
  assert.equal(am.accounts.every(a => a.inflight === 1), true);
  assert.notEqual(a0.index, a1.index);

  // both capped → this one must wait
  let resolved = false;
  const pending = am.acquireAccount(null, 1000).then(a => { resolved = true; return a; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(resolved, false, 'should still be queued while both accounts are capped');

  am.releaseAccount(a0.index); // free a slot
  const a2 = await pending;
  assert.ok(a2, 'queued request should acquire the freed slot');
  assert.equal(a2.index, a0.index);
});

test('overflow queue times out to null when no slot ever frees', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1);
  measureAll(am);
  await am.acquireAccount(null, 1000); // fill the only account

  const start = Date.now();
  const a = await am.acquireAccount(null, 80);
  assert.equal(a, null);
  assert.ok(Date.now() - start >= 70, 'should have waited roughly the timeout');
});

test('all accounts exhausted by quota returns null immediately (does not queue)', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am, 0.99); // both over threshold → unavailable (not merely capped)

  const start = Date.now();
  const a = await am.acquireAccount(null, 1000);
  assert.equal(a, null);
  assert.ok(Date.now() - start < 200, 'must not wait the full timeout when nothing is merely capped');
});

test('per-account maxConcurrent overrides the global default', () => {
  const accts = makeAccounts(2);
  accts[1].maxConcurrent = 5;
  const am = new AccountManager(accts, 0.98, 0, 2);
  assert.equal(am.accounts[0].maxConcurrent, 2); // global default
  assert.equal(am.accounts[1].maxConcurrent, 5); // override
});

test('releaseAccount never drives inflight below zero', () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 2);
  am.releaseAccount(0);
  am.releaseAccount(0);
  assert.equal(am.accounts[0].inflight, 0);
});

test('overflow queue is bounded: rejects past maxQueueDepth instead of growing', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1, 2); // cap 1, queue depth 2
  measureAll(am);
  await am.acquireAccount(null, 5000); // fill the only slot

  const w1 = am.acquireAccount(null, 5000); // queued (depth 1)
  const w2 = am.acquireAccount(null, 5000); // queued (depth 2)
  await new Promise(r => setTimeout(r, 20));
  assert.equal(am._waiters.length, 2);

  const over = await am.acquireAccount(null, 5000); // depth full → immediate null
  assert.equal(over, null);
  assert.equal(am._waiters.length, 2, 'queue must not grow past its depth cap');

  // drain so the queued waiters' timers are cleared (no dangling handles)
  am.releaseAccount(0);
  const a1 = await w1; assert.ok(a1);
  am.releaseAccount(a1.index);
  const a2 = await w2; assert.ok(a2);
  am.releaseAccount(a2.index);
});

test('proxy rejects an over-sized request body with 413 (bounded buffering)', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    maxRequestBytes: 1024, // 1 KiB cap for the test
  });
  const port = await listen(proxy);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5000),
  });
  assert.equal(res.status, 413);

  upstream.close();
  proxy.close();
});

// ── integration: proxy enforces the per-account cap end-to-end ─────────────

test('proxy caps concurrent in-flight per account and still serves every request', async () => {
  const live = {};  // token -> current concurrent in flight at upstream
  const peak = {};  // token -> peak concurrent observed

  const upstream = http.createServer(async (req, res) => {
    const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
    live[tok] = (live[tok] || 0) + 1;
    peak[tok] = Math.max(peak[tok] || 0, live[tok]);
    await new Promise(r => setTimeout(r, 60)); // hold open so concurrency overlaps
    live[tok]--;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(3), 0.98, 0, 2); // cap 2/account → 6 total
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    overflowQueueTimeoutMs: 5000,
  });
  const port = await listen(proxy);

  // 6 concurrent client requests (localhost → proxy auth skipped)
  const statuses = await Promise.all(Array.from({ length: 6 }, () =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1 }),
    }).then(r => r.status)));

  assert.equal(statuses.every(s => s === 200), true, 'every request should succeed');
  for (const [tok, p] of Object.entries(peak)) {
    assert.ok(p <= 2, `account ${tok} exceeded its concurrency cap (peak ${p})`);
  }
  assert.ok(Object.keys(peak).length >= 3, 'load should have spread across all 3 accounts');
  // slots fully released afterwards
  assert.equal(am.accounts.every(a => a.inflight === 0), true);

  upstream.close();
  proxy.close();
});

test('a queued request cancelled by client disconnect never reaches upstream', async () => {
  let hits = 0;
  const upstream = http.createServer(async (_req, res) => {
    hits++;
    await new Promise(r => setTimeout(r, 250)); // hold the slot so the 2nd request queues
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1); // cap 1
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, overflowQueueTimeoutMs: 5000,
  });
  const port = await listen(proxy);

  const p1 = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 60)); // req1 acquires the slot + reaches upstream

  const ac = new AbortController();
  const p2 = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal })
    .catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 60)); // req2 enqueues behind the full slot
  assert.equal(am._waiters.length, 1, 'req2 should be queued');

  ac.abort(); // client disconnects while queued
  await new Promise(r => setTimeout(r, 40));
  assert.equal(am._waiters.length, 0, 'aborted waiter must be removed');

  await p1; await p2;
  await new Promise(r => setTimeout(r, 150)); // window for any erroneous dispatch
  assert.equal(hits, 1, 'cancelled queued request must not reach upstream');

  upstream.close();
  proxy.close();
});

test('relayRaw enforces the body-size cap on /v1/oauth/token', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, maxRequestBytes: 1024,
  });
  const port = await listen(proxy);

  const res = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5000),
  });
  assert.equal(res.status, 413);

  upstream.close();
  proxy.close();
});

test('global admission cap rejects past capacity before buffering (upstream untouched)', async () => {
  let hits = 0;
  const upstream = http.createServer(async (_req, res) => {
    hits++;
    await new Promise(r => setTimeout(r, 200));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1, 0); // cap 1, queue depth 0 → capacity 1
  measureAll(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  const p1 = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' }).then(r => r.status);
  await new Promise(r => setTimeout(r, 50)); // req1 takes the only capacity slot
  const s2 = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' }).then(r => r.status);
  assert.equal(s2, 429, 'over-capacity request must be rejected');
  assert.equal(await p1, 200);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(hits, 1, 'rejected request never reached upstream');

  upstream.close();
  proxy.close();
});
