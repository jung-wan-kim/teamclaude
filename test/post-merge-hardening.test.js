import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
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
    assert.equal(am.accounts[0].status, 'throttled',
      'still leaves rotation — a healthy account was available to take over');
    assert.equal(am.accounts[0]._403Strikes, 1, 'one strike recorded');
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

// ── a 403 must not cost a human re-login ─────────────────────
//
// The whole fleet leaves through one egress IP, so an IP-level block returns
// 403 for accounts whose subscriptions are perfectly fine. Parking those
// permanently would mean re-registering healthy accounts by hand. The cooldown
// has to heal itself, and only a sustained run of 403s — real evidence of an
// entitlement loss — may cost an operator anything.

async function drive403(accountCount, sends) {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    Array.from({ length: accountCount }, (_, i) => ({
      name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: 'r',
      expiresAt: Date.now() + 3600_000,
    })), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  for (let i = 0; i < sends; i++) {
    // Rewind any cooldown so the next send actually reaches the account again —
    // this is what a caller arriving after the window would see.
    for (const a of am.accounts) if (a.rateLimitedUntil) a.rateLimitedUntil = Date.now() - 1;
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await r.text();
  }
  proxy.close(); upstream.close();
  return am;
}

test('a cooled-down account returns to rotation on its own, with no re-login', async () => {
  const am = await drive403(2, 1);
  const hit = am.accounts.find(a => a.status === 'throttled');
  assert.ok(hit, 'the refused account was cooled down rather than parked');
  assert.notEqual(hit.status, 'error', 'no operator action should be required');

  // Let the window lapse — availability alone must bring it back.
  hit.rateLimitedUntil = Date.now() - 1;
  assert.equal(am._isAvailable(hit), true, 'selectable again once the cooldown lapses');
  assert.equal(hit.status, 'active', 'and restored to active without any credential change');
});

test('re-login clears the strike run — a fresh account is not one 403 from a park', async () => {
  // The strike run describes the OLD credentials. If it survives re-login, the
  // account the operator just repaired sits a single unrelated 403 away from
  // being parked again, which makes re-login a non-recovery.
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const acct = am.accounts[0];
  acct._403Strikes = 4;
  acct.status = 'throttled';
  acct.rateLimitedUntil = Date.now() + 300_000;
  acct._403CooldownUntil = acct.rateLimitedUntil;   // this cooldown came from a 403

  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });

  assert.ok(!acct._403Strikes, 'the run from the old credentials is cleared');
  assert.equal(acct.status, 'active', 'and the cooldown that run imposed is lifted');
  assert.equal(am._isAvailable(acct), true, 'so the repaired account is immediately usable');
});

test('re-login does NOT lift a genuine quota throttle', async () => {
  // markRateLimited is shared with the 429 path. A quota throttle describes
  // upstream's rate limit, not the credentials — releasing it on re-login would
  // route traffic before retry-after and invite a 429 storm.
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const acct = am.accounts[0];
  am.markRateLimited(0, 300);                       // 429 quota throttle, no 403 marker
  const until = acct.rateLimitedUntil;

  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });

  assert.equal(acct.status, 'throttled', 'the quota throttle survives a credential change');
  assert.equal(acct.rateLimitedUntil, until, 'and its deadline is untouched');
  assert.equal(am._isAvailable(acct), false, 'so the account stays out until retry-after');
});

test('when the only alternative is capped, the client gets the real 403, not a synthetic 429', async () => {
  // "Is the fleet non-empty?" and "can the retry acquire an account right now?"
  // are different questions. A capped-but-healthy account answers the first
  // (its slot frees up, so stepping the refused account aside is safe) but not
  // the second — if the overflow queue cannot admit, the recursion ends in a
  // synthetic 429 that replaces the truthful 403 we are already holding.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.accounts[1].maxConcurrent = 0;   // healthy but with no slot free

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, overflowQueueTimeoutMs: 1,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 403, 'the refusal we actually received is what the client sees');
    assert.equal(am.accounts[0].status, 'throttled',
      'the refused account still steps aside — a capped peer means the fleet is not empty');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a 403 cooldown never shortens a longer quota throttle already in place', async () => {
  // Concurrency: one request can take an exhaustion 429 with a long
  // retry-after while another is still in flight on the same account. If the
  // 403 path overwrote that deadline with its own 60s the account would return
  // to rotation while upstream is still refusing it on quota — and the throttle
  // would be mislabelled 403-derived, so re-login would wrongly lift it too.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    // Stand in for the concurrent quota 429 that already landed.
    am.markRateLimited(0, 300);
    const quotaDeadline = am.accounts[0].rateLimitedUntil;
    am.accounts[0].status = 'active';   // let selection reach it, as an in-flight request would

    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text());

    assert.equal(am.accounts[0].rateLimitedUntil, quotaDeadline,
      'the longer quota deadline survives the 403 cooldown');
    assert.notEqual(am.accounts[0]._403CooldownUntil, quotaDeadline,
      'and it is not mislabelled as 403-derived, so re-login will not lift it');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a sustained run of 403s does eventually park — that is what re-login is for', async () => {
  // Five consecutive refusals on the same account is no longer plausibly a
  // transient block; at that point parking (and telling the operator) is right.
  const am = await drive403(2, 6);
  assert.ok(am.accounts.some(a => a.status === 'error'),
    'a sustained run must still reach a permanent park');
  const parked = am.accounts.find(a => a.status === 'error');
  assert.equal(parked._errorFromRefresh, false,
    'upstream rejected the ACCOUNT — the token sweep must not revive it');
  assert.ok(parked._403Strikes >= 5, `park only after the run, got ${parked._403Strikes}`);
});

// ── the 403 retry gate must ask about the set the recursion will SELECT from ──
//
// The gate decides "is there somewhere to fail over to". The recursion then
// selects with `ctx.tried429 ∪ ctx.tried5xx` excluded. An unqualified
// anyUsable() also counts an account this request already burned: a
// non-exhaustion 429 leaves its account `active` (per-request exclusion only,
// never throttled). The gate passes, acquisition finds nothing, and the client
// gets a synthetic 429 — exactly the truthful-403 → 429 swap the block exists
// to prevent.

test('a 403 is surfaced, not downgraded to 429, when the only peer was already tried', async () => {
  let n = 0;
  const upstream = http.createServer((_req, res) => {
    n++;
    if (n === 1) {
      // Plain request-rate 429: no `unified-status: rejected`, no utilization
      // headers → NOT quota exhaustion, so the account is excluded for this
      // request only and stays `active` for everyone else.
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'not entitled' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    overflowQueueTimeoutMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const status = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text().then(() => r.status));

    assert.equal(status, 403,
      'the refusal we actually hold must reach the client, not a synthetic 429 '
      + 'produced by a retry that had nowhere left to go');
    assert.equal(n, 2, `one 429 failover then one 403 — no third upstream hit, got ${n}`);
  } finally {
    proxy.close(); upstream.close();
  }
});

// ── keeping the last usable account must not pin the fleet to it forever ──────
//
// When the last usable account 403s we keep it active (parking it would leave
// the proxy with nothing to route to). But then no selection branch can move
// off it — it is available by construction and measured — so at
// `reevalIntervalMs: 0` every later request keeps hitting an account upstream
// is refusing, even after a peer's throttle expires.

test('the fleet leaves a 403-refused last-usable account as soon as a peer recovers', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'not entitled' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0); // reevalIntervalMs: 0 — no timer-driven re-pick, the sticky lock case
  const reset = String(Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000));
  // Measured, so cold-start warm-up round-robin doesn't drive selection.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': reset });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': reset });
  am.markRateLimited(am.accounts[1], 300); // b is out → a is the LAST usable one

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    overflowQueueTimeoutMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const status = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text().then(() => r.status));

    assert.equal(status, 403, 'the refusal is surfaced');
    assert.equal(am.accounts[0].status, 'active', 'the last usable account stays in rotation');
    assert.ok(am.accounts[0]._403KeptActiveAt,
      'it must be marked as "kept only because there was nowhere else"');

    // b's throttle lapses — nothing else changes, and no timer can fire.
    am.accounts[1].rateLimitedUntil = Date.now() - 1000;

    const next = am.getActiveAccount();
    assert.equal(next.name, 'b',
      'once a peer is usable again the fleet must leave the refusing account; '
      + 'staying on it means every request keeps drawing a 403');
    // The marker survives the handover on purpose: routing elsewhere is not
    // evidence that upstream stopped refusing. Retiring it here would drop the
    // guard while the connection-affinity home still pointed at the account, so
    // the next request would snap right back to another 403.
    assert.ok(am.accounts[0]._403KeptActiveAt,
      'the marker retires on proof (a non-403 response / re-login), not on avoidance');
  } finally {
    proxy.close(); upstream.close();
  }
});

// ── the refusal must bind to SELECTION, not to one call site ──────────────────
//
// A first attempt put the handover in getActiveAccount's sticky-return path
// only. Two shortcuts run before it ever executes: `getActiveAccount(exclude)`
// early-returns `_selectBest(exclude)` for per-request failover, and
// `_tryAcquire` returns a connection's affinity home before selection at all.
// A keep-alive socket would then keep drawing 403s from its pinned home
// indefinitely. The penalty therefore lives in `_selectBest`'s sort, so every
// path inherits it.

test('a 403-refused account loses to a healthy peer on every selection path', () => {
  const now = Date.now();
  const reset = String(Math.floor((now + 2 * 60 * 60 * 1000) / 1000));
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: now + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: now + 3600_000 },
    { name: 'c', type: 'oauth', accessToken: 'tc', refreshToken: 'r', expiresAt: now + 3600_000 },
  ], 0.98, 0);
  for (let i = 0; i < 3; i++) {
    am.updateQuota(i, {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': reset,
    });
  }
  const [a, b, c] = am.accounts;
  a._403KeptActiveAt = now;      // upstream is refusing `a`, kept only as last resort
  am.currentIndex = a.index;

  // ① per-request failover — getActiveAccount(exclude) never reaches the sticky branch.
  assert.notEqual(am.getActiveAccount(new Set([c])).name, 'a',
    'failover selection must not hand back the account upstream is refusing');

  // ② an explicit priority must not outrank a refusal: pinning is a preference
  //    among accounts that work.
  am.setPriority('a', 0);
  assert.notEqual(am._selectBest().name, 'a',
    'explicit priority cannot override an upstream refusal');
  am.setPriority('a', null);

  // ③ connection affinity — _tryAcquire returns the pinned home before selection.
  const sock = {};
  am._affinity.set(sock, a);
  const acquired = am._tryAcquire(null, sock);
  assert.notEqual(acquired.name, 'a',
    'a keep-alive connection must not stay pinned to a refusing account');
  // ...and the home must MOVE. Affinity is normally preserved through transient
  // blips (a capped or failover-excluded home is still "usable"), but a refused
  // account stays `active` too — so keeping it as home means the connection
  // snaps straight back to another 403 as soon as the guard lifts.
  assert.notEqual(am._affinity.get(sock).name, 'a',
    'the affinity home must be re-pointed away from a refusing account, not merely skipped');
  am.releaseAccount(acquired);

  // ④ the round-robin tie-set must not fold the refused account back in. The
  //    sort demotes it, but if the tie predicate omits that dimension the two
  //    accounts count as tied and `tied[0]` hands the refused one straight back
  //    whenever currentIndex is the healthy peer.
  assert.ok(a._403KeptActiveAt, 'the marker survives a handover — it retires on proof, not avoidance');
  am.markRateLimited(c, 300);        // leave exactly a (marked) and b (healthy), equal quota
  am.currentIndex = b.index;
  assert.equal(am._selectBest().name, 'b',
    'the tie-breaker must respect the refusal — its equivalence key has to match the sort key');

  // ⑤ _strictlyPrefer must carry the same key, or _reprioritize (setPriority /
  //    setEnabled) leaves a refused account seated while _selectBest ranks a peer first.
  assert.equal(am._strictlyPrefer(b, a), true,
    'a healthy peer must be strictly preferred over a refused account');
  assert.equal(am._strictlyPrefer(a, b), false,
    'a refused account is never strictly preferred over a healthy peer');

  // ⑥ safety valve intact: when the refused account is the ONLY eligible one it still wins.
  am.markRateLimited(b, 300);
  assert.equal(am._selectBest().name, 'a',
    'the penalty must never empty the fleet — a refusal is not a removal');
});

// A 403 carries no rate-limit headers, so the refused account stays unmeasured —
// and cold-start warm-up round-robins over unmeasured accounts BEFORE the
// handover branch runs. Without excluding it there, the fleet keeps drawing
// duplicate 403s from it until maxWarmupTries is spent.
test('a 403-refused account is not a cold-start warm-up target', () => {
  const now = Date.now();
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: now + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: now + 3600_000 },
  ], 0.98, 0);
  const [a, b] = am.accounts;                 // both unmeasured (no updateQuota)

  assert.equal(am._isWarmupTarget(a), true, 'baseline: an unmeasured account is a warm-up target');
  a._403KeptActiveAt = now;
  assert.equal(am._isWarmupTarget(a), false,
    'a refused account must drop out of warm-up so selection reaches the handover');
  assert.equal(am._isWarmupTarget(b), true, 'its healthy peer is unaffected');

  // Safety valve: sole account — nothing else becomes a target either, and
  // selection still returns it rather than leaving the fleet with nothing.
  const solo = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: now + 3600_000 },
  ], 0.98, 0);
  solo.accounts[0]._403KeptActiveAt = now;
  assert.equal(solo._isWarmupTarget(solo.accounts[0]), false);
  assert.equal(solo.getActiveAccount().name, 'only',
    'a one-account fleet still routes to the refused account — a refusal is not a removal');
});

// "Retires on proof" has to mean every source of proof. A forced re-measure
// (refreshQuotaAll, the TUI's R) gets a 2xx from the account — the same evidence
// the client response path clears on — so it must clear too, or the account
// stays demoted out of selection/warm-up/affinity while looking healthy, one
// unrelated 403 away from a permanent park.
test('a successful warm-up probe retires the 403 marker and the strike run', async () => {
  const hour = 3600_000;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + hour) / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 24 * hour) / 1000)),
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + hour },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: Date.now() + hour },
  ], 0.98, 0);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    warmupIntervalMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    // One real request commits the probe template (nothing can be probed without it).
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    }).then(r => r.text());
    await new Promise(r => setTimeout(r, 80)); // let the startup fan-out settle

    const a = am.accounts[0];
    a._403KeptActiveAt = Date.now();
    a._403Strikes = 4;                // one unrelated 403 away from a permanent park
    // Date.now() is millisecond-granular and the ordering guard resolves an
    // ambiguous same-millisecond stamp conservatively (keep the marker), so put
    // the probe unambiguously after the refusal — as it is in reality.
    await new Promise(r => setTimeout(r, 5));

    const r = await proxy.refreshQuotaAll();
    assert.ok(r.measured >= 1, `the forced re-measure must actually probe, got ${JSON.stringify(r)}`);
    assert.equal(a._403KeptActiveAt, undefined,
      'a 2xx probe is proof the account serves — the routing marker must retire');
    // But NOT the strike run: a probe replays one cached template, so it only
    // proves that shape works. Letting it reset the run would mean an account
    // refused for a model its plan lacks could never reach a park — it would
    // oscillate 403 → mark → probe → clear → 403 forever. The park is one-way
    // and operator-visible, so it stays driven by real client traffic.
    assert.equal(a._403Strikes, 4,
      'a synthetic probe must not erase a real run of refusals');
  } finally {
    proxy.close(); upstream.close();
  }
});

// A probe can only attest to what predates its own start. If a client request
// 403s WHILE the probe is in flight, the marker it stamps is newer evidence than
// the probe's 2xx — clearing it would drop the guard on an account that is
// refusing right now, and at reevalIntervalMs 0 nothing else would re-pick.
test('an in-flight probe does not clear a marker stamped after it started', async () => {
  const hour = 3600_000;
  let slow = false;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    if (slow) await new Promise(r => setTimeout(r, 150));   // probe stays in flight
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + hour) / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 24 * hour) / 1000)),
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + hour },
  ], 0.98, 0);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    warmupIntervalMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    }).then(r => r.text());
    await new Promise(r => setTimeout(r, 80));

    const a = am.accounts[0];
    slow = true;
    const inFlight = proxy.refreshQuotaAll();          // probe departs now
    await new Promise(r => setTimeout(r, 50));         // ...and is still out there
    const stamped = Date.now();
    a._403LastAt = stamped;                            // client 403 lands mid-probe
    a._403KeptActiveAt = stamped;                      // (both fields, as the 403 branch sets them)
    await inFlight;

    assert.equal(a._403KeptActiveAt, stamped,
      'the probe attests only to what predates it — a newer refusal must survive');
  } finally {
    proxy.close(); upstream.close();
  }
});

// The same ordering hazard on the client path: requests run concurrently on one
// account, so a later request can 403 while an earlier one is still in flight.
// That earlier 2xx cannot attest to anything after its own dispatch.
test('a slow 2xx does not erase a 403 that landed after it was dispatched', async () => {
  let n = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    n++;
    if (n === 2) {                                  // the long-running request
      await new Promise(r => setTimeout(r, 200));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (n >= 3) {                                   // the refusal, lands first
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'not entitled' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  const send = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  }).then(r => r.text().then(() => r.status));

  try {
    await send();                                   // n=1, warms the path
    const slow = send();                            // n=2, 2xx held for 200ms
    await new Promise(r => setTimeout(r, 40));
    assert.equal(await send(), 403, 'n=3 refusal returns while the slow one is still out');
    const a = am.accounts[0];
    assert.ok(a._403KeptActiveAt, 'the refusal marks the account (sole account → kept active)');
    const stamped = a._403KeptActiveAt;

    assert.equal(await slow, 200, 'the earlier request still completes normally');
    assert.equal(a._403KeptActiveAt, stamped,
      'a response cannot retire a refusal that happened after it was dispatched');
    assert.equal(a._403Strikes, 1, 'nor reset the strike run that refusal started');
  } finally {
    proxy.close(); upstream.close();
  }
});

// A strike is meant to count a consecutive refusal ROUND. Counting responses
// instead lets one transient upstream blip park an account: N requests already
// in flight all come back 403 and, with a healthy peer available, every one of
// them passes canPark.
test('a concurrent burst of 403s counts as one round, not N strikes', async () => {
  const hour = 3600_000;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    if ((req.headers.authorization || '').includes('ta')) {
      await new Promise(r => setTimeout(r, 120));   // hold them all in flight together
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'blip' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + hour },
    { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'r', expiresAt: Date.now() + hour },
  ], 0.98, 0, 5);                                    // 5 concurrent slots per account
  const reset = String(Math.floor((Date.now() + 2 * hour) / 1000));
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': reset });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.2', 'anthropic-ratelimit-unified-5h-reset': reset });

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    sessionAffinity: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const send = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text().then(() => r.status));

    await Promise.all([send(), send(), send(), send(), send()]);

    const a = am.accounts[0];
    assert.notEqual(a.status, 'error',
      'one transient burst must not permanently park an account');
    assert.ok((a._403Strikes || 0) <= 1,
      `concurrent refusals are one round, got ${a._403Strikes} strikes`);
  } finally {
    proxy.close(); upstream.close();
  }
});

// updateAccountTokens wipes the strike run because it describes the OLD
// credentials. A request that left before the re-login can land after it — its
// verdict is about credentials the account no longer holds, so it must not
// re-create the run and park a freshly re-authenticated account.
test('a late 403 from pre-re-login credentials does not re-create the strike run', async () => {
  const hour = 3600_000;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    await new Promise(r => setTimeout(r, 200));
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'old creds' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'r', expiresAt: Date.now() + hour },
  ], 0.98, 0);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const inFlight = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    }).then(r => r.text().then(() => r.status));

    await new Promise(r => setTimeout(r, 60));       // request is out with the old token
    am.accounts[0]._403Strikes = 4;                  // pretend a run had built up
    am.updateAccountTokens(0, {                      // re-login wipes it and bumps the generation
      accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + hour,
    });

    await inFlight;

    const a = am.accounts[0];
    assert.equal(a._403Strikes || 0, 0,
      'a verdict on discarded credentials must not rebuild the run');
    assert.notEqual(a.status, 'error',
      'and must not park the account that was just re-authenticated');
  } finally {
    proxy.close(); upstream.close();
  }
});

// A token refresh is not a re-login: entitlement belongs to the account, so the
// strike run survives it on purpose. But a park is one-way and operator-visible,
// and a 403 can be token-scoped — so a verdict on a token that has already been
// replaced must not be the one that crosses the threshold.
// STRUCTURAL guard, not behavioural — stated plainly because the difference
// matters. `ensureTokenFresh`'s refresh path calls the real `refreshAccessToken`
// against Anthropic, and the suite has no seam for it (the other refresh tests
// replace the whole method), so there is no way here to drive a live refresh and
// watch the generation move. What IS checkable is the pairing the correctness
// argument rests on: every site that replaces `account.credential` must bump
// `_credGen`, or a response dispatched with the old token counts as live
// evidence and can park the account. This fails loudly if a third
// credential-replacing site is added without the bump.
test('every credential replacement bumps the generation', async () => {
  const src = await readFile(new URL('../src/account-manager.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  // Dot and bracket form, whitespace-insensitive — a global count would pass if
  // a bump were moved to unrelated code, so each assignment is paired with a
  // bump that FOLLOWS it within the same block.
  const assigns = [];
  const bumpAt = [];
  lines.forEach((l, i) => {
    if (/account\s*(\.\s*credential|\[\s*['"`]credential['"`]\s*\])\s*=[^=]/.test(l)) assigns.push(i);
    if (/account\s*(\.\s*_credGen|\[\s*['"`]_credGen['"`]\s*\])\s*=[^=]/.test(l)) bumpAt.push(i);
  });

  assert.ok(assigns.length >= 2,
    `expected the refresh and re-login sites, found ${assigns.length}`);
  const WINDOW = 25;   // same block, allowing for the comment that explains it
  const unpaired = assigns.filter(i => !bumpAt.some(b => b > i && b - i <= WINDOW));
  assert.deepEqual(unpaired.map(i => i + 1), [],
    'every site replacing account.credential must bump _credGen right after it — '
    + `unpaired at line(s) ${unpaired.map(i => i + 1).join(', ') || 'none'}`);
});
