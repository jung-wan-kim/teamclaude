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

// ── unit: connection affinity (prompt-cache locality) ─────────────────────

test('affinity keeps a connection\'s sequential requests on the same account', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 3);
  measureAll(am);
  const key = {}; // stand-in for a client socket object

  const a1 = await am.acquireAccount(null, 0, null, key); am.releaseAccount(a1.index);
  const a2 = await am.acquireAccount(null, 0, null, key); am.releaseAccount(a2.index);
  const a3 = await am.acquireAccount(null, 0, null, key);

  assert.equal(a2.index, a1.index, 'second sequential request reuses the first account');
  assert.equal(a3.index, a1.index, 'third too — cache stays warm on one account');
});

test('affinity is a soft preference: spills when the preferred account is capped', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 1); // cap 1/account
  measureAll(am);
  const key = {};

  const a1 = await am.acquireAccount(null, 0, null, key);  // takes account X, fills its only slot
  const a2 = await am.acquireAccount(null, 0, null, key);  // same key, but X capped → must spill

  assert.notEqual(a2.index, a1.index, 'affinity must never exceed the per-account cap');
  assert.equal(am.accounts[a1.index].inflight, 1);
  assert.equal(am.accounts[a2.index].inflight, 1);
});

test('affinity falls through when the preferred account becomes unavailable', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const key = {};

  const a1 = await am.acquireAccount(null, 0, null, key);
  am.releaseAccount(a1.index);

  // Exhaust the affined account's quota → it's no longer available.
  am.updateQuota(a1.index, {
    'anthropic-ratelimit-unified-5h-utilization': '0.99',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });

  const a2 = await am.acquireAccount(null, 0, null, key);
  assert.notEqual(a2.index, a1.index, 'must move off the exhausted affined account');
});

test('affinity holds a connection on its account when the sticky primary moves to a better one', async () => {
  // reeval ON (1ms) so use-or-lose can move the global primary mid-stream — the
  // exact case that used to mass-bust the prompt cache. Affinity must shield a
  // live connection from that move while NEW connections follow the new primary.
  const now = Date.now();
  const am = new AccountManager(makeAccounts(2), 0.98, 1, 3);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 2 * HOUR) / 1000)) });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 2 * HOUR) / 1000)) });

  const key = {};
  const first = await am.acquireAccount(null, 0, null, key);
  am.releaseAccount(first.index);
  const other = first.index === 0 ? 1 : 0;

  // Make `other` reset sooner → use-or-lose now prefers it; wait past the interval.
  am.updateQuota(other, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 60_000) / 1000)) });
  await new Promise(r => setTimeout(r, 5));

  // A fresh connection follows the re-prioritized primary…
  const fresh = await am.acquireAccount(null, 0, null, {}); am.releaseAccount(fresh.index);
  assert.equal(fresh.index, other, 'a new connection routes to the now-better account');

  // …but the affined connection stays put, keeping its prompt cache warm.
  const again = await am.acquireAccount(null, 0, null, key);
  assert.equal(again.index, first.index, 'affinity shields the existing connection from the primary move');
});

test('affinity defers to cold-start warm-up so every account still gets measured', async () => {
  // Accounts start UNMEASURED. Even all on one connection (same affinity key),
  // warm-up must still round-robin so each account gets measured — affinity
  // must not pin everything to the first-measured account.
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const key = {};
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const a = await am.acquireAccount(null, 0, null, key);
    seen.add(a.index);
    am.releaseAccount(a.index);
  }
  assert.ok(seen.size >= 2, 'warm-up must reach both accounts despite affinity');
});

test('affinity does not pin to an unmeasured (headerless) account after warm-up tries are exhausted', async () => {
  // Accounts that never return rate-limit headers stay unmeasured. After their
  // warm-up tries (3 each) are spent, traffic on one affinity key must keep
  // round-robining (the unmeasured rebalance) rather than pinning to one
  // unmeasured account — otherwise the others never get measured / refreshed.
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const key = {};
  const picks = [];
  for (let i = 0; i < 10; i++) {
    const a = await am.acquireAccount(null, 0, null, key); // no updateQuota → stays unmeasured
    picks.push(a.index);
    am.releaseAccount(a.index);
  }
  // 2 accounts × 3 warm-up tries = first 6 picks are warm-up; the tail is where a
  // buggy affinity would pin to one unmeasured account.
  const tail = picks.slice(6);
  assert.ok(new Set(tail).size >= 2,
    `must keep spreading across unmeasured accounts after warm-up, tail=${tail.join(',')}`);
});

test('a non-object affinity key is ignored, not thrown on', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  // A primitive key would throw `Invalid value used as weak map key` if it
  // reached WeakMap.get/set — it must be ignored and acquire normally instead.
  const a = await am.acquireAccount(null, 0, null, 'session-1');
  assert.ok(a, 'string key must not crash acquire');
  am.releaseAccount(a.index);
});

test('a transient cap spill does not rewrite a connection\'s affinity', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 1); // cap 1/account
  measureAll(am);
  const key = {};

  const home = await am.acquireAccount(null, 0, null, key); // account X, fills its only slot
  // Same key while the home is in-flight (capped) → must spill to another
  // account, but must NOT adopt that spill as the connection's new home.
  const spill = await am.acquireAccount(null, 0, null, key);
  assert.notEqual(spill.index, home.index, 'spills off the momentarily-capped home');
  am.releaseAccount(home.index);
  am.releaseAccount(spill.index);

  // Next sequential request returns to the original (now uncapped) home.
  const next = await am.acquireAccount(null, 0, null, key);
  assert.equal(next.index, home.index, 'affinity returns to the home account after a transient cap spill');
});

test('a transient per-request failover does not rewrite a connection\'s affinity', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const key = {};

  const first = await am.acquireAccount(null, 0, null, key);
  const home = first.index;
  am.releaseAccount(first);

  // Simulate THIS request failing over off `home` (per-request exclude, as a
  // transient 429/5xx does). The exclude set holds the account OBJECT. The retry
  // must pick a different account but must NOT adopt it as the connection's home.
  const fb = await am.acquireAccount(new Set([first]), 0, null, key);
  assert.notEqual(fb.index, home, 'failover picks a different account');
  am.releaseAccount(fb);

  // The next normal request on the same connection returns to its warm home.
  const next = await am.acquireAccount(null, 0, null, key);
  assert.equal(next.index, home, 'affinity stays on the home account after a transient failover');
});

test('addAccount wakes a queued waiter the new capacity can serve', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1); // one account, cap 1
  measureAll(am);
  const held = await am.acquireAccount(null, 0, null, null); // fill the only slot

  // request2 has nowhere to go → it queues (cap saturated, a slot *could* free).
  let resolved = false;
  const pending = am.acquireAccount(null, 1000).then(a => { resolved = true; return a; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolved, false, 'request is queued while the only account is capped');

  // A freshly added account has free capacity → it must wake the queued waiter
  // immediately, not let it time out to a 429.
  am.addAccount({ name: 'new', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR });
  const a = await pending;
  assert.ok(a, 'the queued request is served by the newly added account');
  assert.notEqual(a, held, 'served by the new account, not the still-held one');
});

// ── unit: index handles survive a runtime removeAccount() ─────────────────

test('releaseAccount by object frees the right slot after a concurrent removeAccount re-index', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 1); // cap 1
  measureAll(am);

  const x = await am.acquireAccount(null, 0, null, null); // holds some account
  const y = await am.acquireAccount(null, 0, null, null); // holds another
  assert.notEqual(x.index, y.index);
  assert.equal(x.inflight, 1);
  assert.equal(y.inflight, 1);

  // Admin deletes a *third*, still-idle account → the array re-indexes, shifting
  // x/y to new index numbers. Releasing by OBJECT must still hit the right slots.
  const idle = am.accounts.find(a => a !== x && a !== y);
  am.removeAccount(idle.index);

  am.releaseAccount(x);
  am.releaseAccount(y);
  assert.equal(x.inflight, 0, 'x slot released despite re-index');
  assert.equal(y.inflight, 0, 'y slot released despite re-index');
  // both are acquirable again (cap accounting intact, not leaked)
  const z = await am.acquireAccount(null, 0, null, null);
  assert.ok(z, 'a slot is available again — no leak from the re-index');
});

test('removing the account that holds a slot does not underflow a surviving account', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 1); // cap 1
  measureAll(am);

  const a = await am.acquireAccount(null, 0, null, null); // a.index = 0 (say)
  const b = await am.acquireAccount(null, 0, null, null); // b.index = 1
  // Remove the account that is itself in flight; b shifts down to index 0.
  am.removeAccount(a.index);
  // Releasing the removed account's own object must not touch the survivor.
  am.releaseAccount(a);
  assert.equal(b.inflight, 1, 'survivor slot untouched by releasing the removed account');
  // Survivor releases correctly by object.
  am.releaseAccount(b);
  assert.equal(b.inflight, 0);
});

test('a failover exclude set skips the right account after a re-index (object identity)', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 5);
  measureAll(am);
  const bad = am.accounts[1]; // the account to keep excluded

  // Remove account 0 → `bad` shifts from index 1 to index 0. An index-based
  // exclude would now wrongly skip whoever sits at index 1; an object-based one
  // still skips `bad`.
  am.removeAccount(0);
  const picked = await am.acquireAccount(new Set([bad]), 0, null, null);
  assert.notEqual(picked, bad, 'the excluded account is still skipped after the re-index');
});

test('a late 429 for a removed in-flight account does not poison a surviving account', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am); // both at util 0.1
  const A = am.accounts[0];
  const B = am.accounts[1];

  // A is mid-flight upstream when an admin removes it. A is spliced out, B shifts
  // into index 0, and A's own `.index` is now stale (still 0 → points at B).
  am.removeAccount(A.index);

  // The server applies A's late upstream 429 / quota by the account OBJECT A, so
  // it must hit (the now-detached) A, never B.
  am.markRateLimited(A, 60);
  assert.equal(B.status, 'active', "survivor B must NOT be throttled by A's 429");
  am.updateQuota(A, {
    'anthropic-ratelimit-unified-5h-utilization': '0.99',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  assert.equal(B.quota.unified5h, 0.1, 'survivor B quota untouched by A response');
  assert.equal(am.isExhausted(A), true, 'isExhausted targets A (its own quota), object-resolved');
});

test('token-refresh callback is not emitted with a stale index for a removed account', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  const A = am.accounts[0];
  let emitted = null;
  am.onTokenRefresh((idx, tokens) => { emitted = { idx, tokens }; });

  // Remove A; B shifts into index 0 while A keeps a stale .index === 0.
  am.removeAccount(A.index);

  // A late token update for the (now-removed) A must NOT fire the persist
  // callback — otherwise its stale index 0 would write A's tokens into B's config.
  am.updateAccountTokens(A, { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + HOUR });
  assert.equal(emitted, null, 'no callback for a removed account → no stale-index config write');

  // Sanity: a live account still emits (with its current index).
  const B = am.accounts[0];
  am.updateAccountTokens(B, { accessToken: 'x2', refreshToken: 'y2', expiresAt: Date.now() + HOUR });
  assert.ok(emitted && emitted.idx === 0, 'a live account still persists, with its current index');
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

test('a keep-alive connection pins its sequential requests to one account (affinity end-to-end)', async () => {
  const served = []; // token (account) that handled each request, in order
  const upstream = http.createServer((req, res) => {
    served.push((req.headers['authorization'] || '').replace('Bearer ', ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  // reeval ON (1ms): the global sticky primary may move between turns, but a
  // live connection's affinity must hold it on one account (the #4 mitigation).
  const am = new AccountManager(makeAccounts(3), 0.98, 1, 3);
  measureAll(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  // One socket, reused for sequential (awaited) requests — the keep-alive case.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const call = () => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', agent }, res => {
      res.resume(); res.on('end', resolve); res.on('error', reject);
    });
    r.on('error', reject);
    r.end('{}');
  });

  await call();
  await new Promise(r => setTimeout(r, 5)); // let the reeval interval elapse between turns
  await call();
  await call();
  agent.destroy();

  assert.equal(served.length, 3);
  assert.ok(served.every(t => t === served[0]),
    'all turns on the keep-alive socket hit one account despite reeval re-prioritization');

  upstream.close();
  proxy.close();
});

test('an account removed just before dispatch is not used; the request re-selects a live account', async () => {
  const served = []; // Bearer token actually sent upstream, per request
  const upstream = http.createServer((req, res) => {
    served.push((req.headers['authorization'] || '').replace('Bearer ', ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am); // first request deterministically routes to account 0 (tok-0)

  // Delete the routed account synchronously, in the tiny window after selection
  // and before dispatch (onRequestRouted fires right before ensureTokenFresh).
  let removedOnce = false;
  const hooks = {
    onRequestRouted: () => { if (!removedOnce) { removedOnce = true; am.removeAccount(0); } },
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxy);

  const status = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' }).then(r => r.status);
  assert.equal(status, 200, 'served successfully by a surviving account');
  assert.ok(!served.includes('tok-0'),
    `must not dispatch on the just-removed account; served=${served.join(',')}`);
  assert.equal(am.accounts.every(a => a.inflight === 0), true, 'no leaked slot after the reselect');

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

test('a client disconnect during a stalled SSE stream releases the slot (no capacity leak)', async () => {
  // Upstream opens an SSE stream, sends one event, then STALLS forever (never ends).
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n');
    // intentionally never res.end()
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1); // cap 1 — leak shows immediately
  measureAll(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  const ac = new AbortController();
  const p = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal })
    .catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 80)); // stream started → slot reserved
  assert.equal(am.accounts[0].inflight, 1, 'slot held while streaming');

  ac.abort(); // client drops mid-stream while upstream is stalled
  await p;
  await new Promise(r => setTimeout(r, 150)); // let the abort unwind reader.read() + release

  assert.equal(am.accounts[0].inflight, 0, 'slot released after client disconnect — no capacity leak');
  // capacity is reusable immediately
  const a = await am.acquireAccount(null, 0, null, null);
  assert.ok(a, 'capacity recovered after the stalled-stream disconnect');
  am.releaseAccount(a);

  upstream.close();
  proxy.close();
});

test('a client disconnect during 5xx overload backoff releases the slot promptly', async () => {
  // Upstream always 529 → the proxy enters its backoff sleep between fleet retries.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end('{"type":"error"}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1); // cap 1
  measureAll(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  // A long backoff so the slot would be held for ~1s without the abort-aware wait.
  const prevR = process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
  const prevB = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '3';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '1000';
  try {
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal })
      .catch(() => 'aborted');
    await new Promise(r => setTimeout(r, 120)); // request has 529'd and is now in backoff sleep
    assert.equal(am.accounts[0].inflight, 1, 'slot held while backing off');

    ac.abort(); // client drops during the 1s backoff
    await p;
    await new Promise(r => setTimeout(r, 120)); // far less than the 1000ms backoff
    assert.equal(am.accounts[0].inflight, 0, 'slot released promptly on abort, not after the full backoff');
  } finally {
    if (prevR === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES; else process.env.TEAMCLAUDE_OVERLOAD_RETRIES = prevR;
    if (prevB === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS; else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = prevB;
    upstream.close();
    proxy.close();
  }
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

test('a client disconnect during a hung /v1/oauth/token relay frees admission capacity', async () => {
  const upstream = http.createServer(() => { /* hang forever — never respond */ });
  const upstreamPort = await listen(upstream);

  // totalCapacity = caps(1) + queueDepth(0) = 1, so one in-flight relay saturates
  // global admission — the leak (or its fix) is immediately observable.
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1, 0);
  measureAll(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  const ac1 = new AbortController();
  const p1 = fetch(`http://127.0.0.1:${port}/v1/oauth/token`, { method: 'POST', body: '{}', signal: ac1.signal })
    .catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 80)); // relay in flight → admission at capacity

  ac1.abort(); // client drops while the upstream relay hangs
  await p1;
  await new Promise(r => setTimeout(r, 80)); // abort unwinds the relay → capacity should free

  // A new relay must now be ADMITTED (not 429'd by a pinned inFlightProxied).
  const ac2 = new AbortController();
  let p2status = null;
  const p2 = fetch(`http://127.0.0.1:${port}/v1/oauth/token`, { method: 'POST', body: '{}', signal: ac2.signal })
    .then(r => { p2status = r.status; return r.status; })
    .catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 80));
  assert.notEqual(p2status, 429, 'capacity was freed by the aborted relay (new relay admitted, not rejected)');

  ac2.abort();
  await p2;
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

// ── disable / enable + priority (account on-off switch + selection order) ──────

test('a disabled account is excluded from acquire selection', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 10); // cap 10 > the 6 acquires below
  measureAll(am);
  am.setEnabled('a0', false);

  const picks = [];
  for (let i = 0; i < 6; i++) picks.push((await am.acquireAccount(null, 0)).name);
  assert.equal(picks.every(n => n === 'a1'), true, 'all requests route to the enabled account only');
  assert.equal(am.accounts.find(a => a.name === 'a0').inflight, 0, 'disabled account took no requests');
});

test('disabling the current account switches getActiveAccount to another', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am);
  const before = am.getActiveAccount();
  am.setEnabled(before, false);
  const after = am.getActiveAccount();
  assert.notEqual(after, null);
  assert.notEqual(after.name, before.name, 'must move off the disabled current account');
  assert.equal(after.enabled !== false, true);
});

test('disabling every account yields null (client gets 429)', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am);
  am.setEnabled('a0', false);
  am.setEnabled('a1', false);
  assert.equal(am.getActiveAccount(), null);
  assert.equal(await am.acquireAccount(null, 0), null);
});

test('an in-flight request on an account that gets disabled still drains its slot', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am);
  const held = await am.acquireAccount(null, 0);
  assert.equal(held.inflight, 1);
  am.setEnabled(held, false);                 // disable while a request is in flight
  assert.equal(held.inflight, 1, 'disabling does not kill the in-flight request');
  am.releaseAccount(held);
  assert.equal(held.inflight, 0, 'slot released normally after the request finishes');
});

test('re-enabling an account hands its freed capacity to a queued waiter', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 1); // cap 1/account
  measureAll(am);
  am.setEnabled('a1', false);                 // only a0 usable

  const a0 = await am.acquireAccount(null, 1000);
  assert.equal(a0.name, 'a0');                // a0 now capped (cap 1)

  let resolved = false;
  const pending = am.acquireAccount(null, 1000).then(a => { resolved = true; return a; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(resolved, false, 'queued while a0 is capped and a1 disabled');

  am.setEnabled('a1', true);                  // re-enable → drainWaiters → waiter wakes on a1
  const got = await pending;
  assert.equal(resolved, true);
  assert.equal(got.name, 'a1', 'the re-enabled account served the waiting request');
});

test('a disabled account is never a warm-up target', async () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 5); // none measured yet
  am.setEnabled('a1', false);
  const warmed = new Set();
  for (let i = 0; i < 10; i++) {
    const a = am._nextWarmup();
    if (!a) break;
    warmed.add(a.name);
  }
  assert.equal(warmed.has('a1'), false, 'disabled account is not warmed up');
});

test('explicit priority drives selection order (lower = preferred); use-or-lose breaks ties', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 5);
  measureAll(am);                              // equal reset + util → priority decides
  am.setPriority('a0', 3);
  am.setPriority('a1', 1);
  am.setPriority('a2', 2);

  assert.equal(am._selectBest().name, 'a1', 'priority 1 chosen first');
  const exA1 = new Set([am.accounts.find(a => a.name === 'a1')]);
  assert.equal(am._selectBest(exA1).name, 'a2', 'priority 2 next when 1 excluded');
  const exA1A2 = new Set([am.accounts.find(a => a.name === 'a1'), am.accounts.find(a => a.name === 'a2')]);
  assert.equal(am._selectBest(exA1A2).name, 'a0', 'priority 3 last');
});

test('with no priorities set, selection is unchanged use-or-lose (soonest reset first)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  // a1 resets sooner than a0 → use-or-lose prefers a1
  const now = Date.now();
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 2 * HOUR) / 1000)) });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 1 * HOUR) / 1000)) });
  assert.equal(am._selectBest().name, 'a1', 'soonest-resetting account preferred when no priority set');
});

test('priority ties fall back to use-or-lose (soonest reset)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  const now = Date.now();
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 2 * HOUR) / 1000)) });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 1 * HOUR) / 1000)) });
  am.setPriority('a0', 5);
  am.setPriority('a1', 5);                     // same priority → soonest reset (a1) wins
  assert.equal(am._selectBest().name, 'a1');
});

test('getStatus exposes enabled + priority; setters resolve by name', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  measureAll(am);
  assert.equal(am.setEnabled('a0', false)?.name, 'a0', 'setEnabled resolves by name');
  assert.equal(am.setPriority('a1', 7)?.name, 'a1', 'setPriority resolves by name');
  assert.equal(am.setEnabled('nope', false), null, 'unknown name → null');

  const st = am.getStatus();
  const s0 = st.accounts.find(a => a.name === 'a0');
  const s1 = st.accounts.find(a => a.name === 'a1');
  assert.equal(s0.enabled, false);
  assert.equal(s0.priority, null);
  assert.equal(s1.enabled, true);
  assert.equal(s1.priority, 7);
});

test('enabled + priority survive a getStatus round-trip from config-style input', () => {
  const am = new AccountManager([
    { name: 'a0', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, enabled: false, priority: 2 },
    { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ], 0.98, 0, 5);
  const st = am.getStatus();
  assert.equal(st.accounts[0].enabled, false, 'enabled:false honored from constructor input');
  assert.equal(st.accounts[0].priority, 2, 'priority honored from constructor input');
  assert.equal(st.accounts[1].enabled, true, 'default enabled when unset');
  assert.equal(st.accounts[1].priority, null, 'default null priority when unset');
});

test('setEnabled/setPriority reject a bare numeric index (object-handle invariant)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 5);
  // A stale index after a removeAccount would otherwise hit the wrong account;
  // the setters accept only an account object or a name.
  assert.equal(am.setEnabled(0, false), null, 'numeric index rejected');
  assert.equal(am.setPriority(1, 5), null, 'numeric index rejected');
  assert.equal(am.accounts.every(a => a.enabled !== false), true, 'no account was disabled');
  assert.equal(am.accounts.every(a => a.priority == null), true, 'no priority was set');
});

test('setEnabled on a removed account object returns null (no misattribution after re-index)', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 5);
  const a0 = am.accounts[0];
  am.removeAccount(0);                       // a1,a2 shift down to index 0,1
  assert.equal(am.setEnabled(a0, false), null, 'stale removed object resolves to null');
  assert.equal(am.accounts.every(a => a.enabled !== false), true, 'survivors untouched');
});
