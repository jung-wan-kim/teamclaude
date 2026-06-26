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
