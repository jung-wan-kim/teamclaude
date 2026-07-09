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

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Poll a predicate until true or the budget runs out (warm-up is async/background).
async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 15));
  }
  return cond();
}

// Mirror the real upstream contract: a Max response always carries BOTH the 5h
// and the 7d window. (A 5h-only mock would leave OAuth accounts permanently
// half-measured, so active warm-up candidacy — which re-probes half-measured
// accounts — would never converge in tests.)
const RL_HEADERS = () => ({
  'content-type': 'application/json',
  'anthropic-ratelimit-unified-5h-utilization': '0.1',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  'anthropic-ratelimit-unified-7d-utilization': '0.2',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 24 * HOUR) / 1000)),
});

// An upstream that records each request (auth, beta header, body) and answers
// every POST with rate-limit headers so the account becomes "measured".
function recordingUpstream(seen) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ auth: req.headers['authorization'], beta: req.headers['anthropic-beta'], body: raw });
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
}

function measured(am, name) {
  return am.getStatus().accounts.find(a => a.name === name)?.quota.unified5h != null;
}

// ── unit: warmupCandidates() ───────────────────────────────────────────────

test('warmupCandidates returns only available + unmeasured + idle accounts', () => {
  const am = new AccountManager(makeAccounts(5), 0.98, 0, 3);
  // a0 measured (both windows, as a real response reports)
  am.updateQuota(0, RL_HEADERS());
  // a1 unmeasured + idle → the only candidate
  // a2 disabled
  am.setEnabled(am.accounts[2], false);
  // a3 throttled (rate-limited into the future)
  am.markRateLimited(3, 300);
  // a4 unmeasured but a request is in flight → excluded (that request will measure it)
  am.accounts[4].inflight = 1;

  const names = am.warmupCandidates().map(a => a.name);
  assert.deepEqual(names, ['a1'], 'only the idle, unmeasured, enabled account is a candidate');
});

// Regression (review finding): a PARTIAL rollover — weekly window swept while
// the session window survives — left the account "measured", so periodic
// warm-up never re-probed it and its weekly quota/order stayed unknown until
// real traffic arrived. A half-measured OAuth account must be a candidate.
test('a partially-measured OAuth account (weekly swept, session alive) is re-probed', () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const now = Date.now();
  am.accounts[0].quota.unified5h = 0.2;
  am.accounts[0].quota.unified5hReset = now + 4 * HOUR;   // session window still valid
  am.accounts[0].quota.unified7d = 0.4;
  am.accounts[0].quota.unified7dReset = now - 1000;        // weekly just rolled over
  am.sweepExpired();                                       // clears the weekly half only
  assert.equal(am.accounts[0].quota.unified7d, null);
  assert.equal(am.accounts[0].quota.unified5h, 0.2, 'session half survives the sweep');
  assert.deepEqual(am.warmupCandidates().map(a => a.name), ['a0'],
    'half-measured account is a warm-up candidate again');
});

// Regression (review finding): the half-measured re-probe path needs a
// convergence cap — a pathological upstream that keeps answering 2xx with only
// one header family must not be probed every interval forever.
test('a pathological upstream that omits the 7d window stops being probed after the cap', async () => {
  const seen = [];
  const halfUpstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(1);
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
      // no 7d family — accounts stay half-measured no matter how often probed
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(halfUpstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 20 });
  const proxyPort = await listen(proxy);
  try {
    // A real client request (2xx) commits the probe template and starts the fan-out.
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Both accounts end up half-measured; probes must stop once each hits the cap.
    assert.equal(await waitFor(() =>
      am.accounts.every(a => (a._partialProbes || 0) >= am.maxWarmupTries)), true,
      'each account accumulated its capped partial probes');
    assert.deepEqual(am.warmupCandidates(), [], 'capped accounts are no longer candidates');
    const count = seen.length;
    await new Promise(r => setTimeout(r, 150));   // several more intervals
    assert.equal(seen.length, count, 'no further probes after the cap');
    // A rollover sweep re-opens candidacy (fresh reason to probe).
    am.accounts[0].quota.unified5hReset = Date.now() - 1000;
    am.sweepExpired();
    assert.equal(am.accounts[0]._partialProbes, 0, 'sweep reset the counter');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => halfUpstream.close(r));
  }
});

// Same cap, header-less flavor: a 2xx with NO rate-limit headers teaches
// nothing and leaves the account fully unmeasured — it must also stop being
// probed after the cap instead of every interval forever.
test('a header-less 2xx upstream stops being probed after the cap', async () => {
  const seen = [];
  const bareUpstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(1);
    res.writeHead(200, { 'content-type': 'application/json' }); // no anthropic-ratelimit-*
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(bareUpstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 20 });
  const proxyPort = await listen(proxy);
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(await waitFor(() =>
      am.accounts.every(a => (a._partialProbes || 0) >= am.maxWarmupTries)), true,
      'fruitless header-less probes accumulated to the cap');
    assert.deepEqual(am.warmupCandidates(), [], 'capped accounts no longer probed');
    assert.equal(measured(am, 'a1'), false, 'account honestly stays unmeasured');
    const count = seen.length;
    await new Promise(r => setTimeout(r, 150));
    assert.equal(seen.length, count, 'no further probes after the cap');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => bareUpstream.close(r));
  }
});

// Regression (review finding): transient 5xx probe outcomes must NOT burn the
// convergence budget — a fully unmeasured account has no reset timestamp, so
// no sweep would ever clear its counter, and a passing upstream blip would
// abandon it permanently even after recovery.
test('transient 5xx probe failures do not burn the budget — recovery re-measures', async () => {
  let probeFails = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const isProbe = raw.includes('"max_tokens":1');
    if (isProbe && probeFails < 4) {              // more blips than maxWarmupTries
      probeFails++;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"err":"overloaded"}');
      return;
    }
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 20 });
  const proxyPort = await listen(proxy);
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // 4 probes hit 503 (uncounted), then upstream recovers → the next interval
    // probe fully measures the account. With 5xx counted this would have
    // stopped for good at 3 attempts.
    assert.equal(await waitFor(() => measured(am, 'a1'), 4000), true,
      'account measured after upstream recovered');
    assert.equal(am.accounts[1]._partialProbes || 0, 0, 'budget untouched by transient blips');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});

// Regression (review finding): utilization headers WITHOUT their reset
// timestamps give use-or-lose nothing to sort on — such an account is not
// "fully measured" and must remain a re-probe candidate (counting toward the
// cap), not be silently accepted as complete.
test('utilization-only headers (no resets) do not count as fully measured', () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-utilization': '0.2',
    // no -reset headers
  });
  assert.equal(am._isMeasured(am.accounts[0]), true, 'some data arrived');
  assert.equal(am._fullyMeasured(am.accounts[0]), false, 'but the windows are incomplete');
  assert.deepEqual(am.warmupCandidates().map(a => a.name), ['a0'], 'still a re-probe candidate');
});

// Forced fleet re-measure (TUI Reload): probes MEASURED accounts too, pulling
// fresh upstream numbers on demand — the plain warm-up only ever probes
// unmeasured accounts, so without this the dashboard drifts until a window
// rolls over or organic traffic reaches each account.
test('refreshQuotaAll re-probes already-measured accounts with fresh values', async () => {
  let util = '0.10';
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': util,
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': util,
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 24 * HOUR) / 1000)),
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  const proxyPort = await listen(proxy);
  try {
    // First real request commits the template; the fan-out measures the fleet at 0.10.
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(await waitFor(() => am.accounts.every(a => a.quota.unified5h === 0.1)), true,
      'fleet measured at the initial utilization');

    // Upstream usage moves (e.g. spend from another device) — the plain warm-up
    // will NOT re-probe (everyone is fully measured), so values stay stale...
    util = '0.55';
    const r1 = await proxy.refreshQuotaAll();
    // ...until the forced re-measure pulls the fresh numbers for every account.
    assert.deepEqual(r1, { targets: 3, measured: 3 }, 'every enabled idle account probed AND measured');
    assert.equal(am.accounts.every(a => a.quota.unified5h === 0.55), true,
      'measured accounts re-measured with the fresh utilization');

    // An account with a request in flight is skipped — that response will
    // refresh it anyway, and a probe would just race it.
    util = '0.80';
    am.accounts[1].inflight = 1;
    try {
      assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 2, measured: 2 },
        'busy account excluded from the fan-out');
      assert.equal(am.accounts[1].quota.unified5h, 0.55, 'busy account left untouched');
      assert.equal(am.accounts[0].quota.unified5h, 0.8, 'idle accounts still refreshed');
    } finally {
      am.accounts[1].inflight = 0;
    }
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});

// Root cause of "R updates nothing" in production: idle accounts sit past
// their token lifetime, and warmupAccount's expiring-token guard silently
// skips them. The FORCED refresh must revive tokens first (an explicit user
// action pays that refresh), and the returned counts must be honest when a
// token cannot be revived.
test('refreshQuotaAll refreshes lapsed tokens first and reports honest counts', async () => {
  const authsSeen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (raw.includes('"max_tokens":1')) authsSeen.push(req.headers['authorization']);
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(3), 0.98, 0, 3);
  am.accounts[1].expiresAt = Date.now() - 3600_000;   // lapsed — old guard silently skipped it
  am.accounts[2].expiresAt = Date.now() - 3600_000;   // lapsed AND unrefreshable
  const refreshed = [];
  am.ensureTokenFresh = async (ref) => {              // stand-in for the real OAuth refresh
    const a = am._resolve(ref);
    refreshed.push(a.name);
    if (a.name === 'a2') { a.status = 'error'; throw new Error('refresh_token revoked'); }
    if (Date.now() >= (a.expiresAt || 0)) { a.credential = `tok-fresh-${a.name}`; a.expiresAt = Date.now() + 3600_000; }
  };
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  const proxyPort = await listen(proxy);
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const r = await proxy.refreshQuotaAll();
    assert.equal(refreshed.length >= 3, true, 'token refresh attempted for every target');
    assert.equal(authsSeen.some(h => h === 'Bearer tok-fresh-a1'), true,
      'lapsed-token account was probed WITH its freshly refreshed token');
    assert.equal(r.targets, 3, 'the user asked to refresh 3 accounts');
    assert.equal(r.measured, 2, 'the unrefreshable account is not counted as measured');
    assert.equal(am.accounts[1].quota.unified5h, 0.1, 'revived account got fresh quota');
  } finally {
    await new Promise(r2 => proxy.close(r2));
    await new Promise(r2 => upstream.close(r2));
  }
});

test('refreshQuotaAll without a committed template reports -1 and sends nothing', async () => {
  const seen = [];
  const upstream = recordingUpstream(seen);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  await listen(proxy);
  try {
    assert.equal(await proxy.refreshQuotaAll(), -1, 'no template → honest -1, no guessing a shape');
    assert.equal(seen.length, 0, 'no probe was sent upstream');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});

// Regression (review findings): warm-up budget recovery paths.
test('a rollover sweep renews BOTH warm-up budgets (_partialProbes and _warmupTries)', () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const a = am.accounts[0];
  a.quota.unified5h = 0.5;
  a.quota.unified5hReset = Date.now() - 1000;   // rolled over
  a._partialProbes = 3;
  a._warmupTries = 3;                            // passive warm-up budget spent too
  am.sweepExpired();
  assert.equal(a._partialProbes, 0, 'active probe budget renewed');
  assert.equal(a._warmupTries, 0, 'passive request-routing warm-up budget renewed');
  assert.equal(am._isWarmupTarget(a), true, 'fresh window → passive warm-up target again');
});

test('a capped unmeasured account is retried after probeRetryAfterMs (slow backstop)', () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const a = am.accounts[0];                      // fully unmeasured — no timestamps to sweep
  a._partialProbes = 3;
  a._lastFruitlessProbeAt = Date.now();          // just failed → excluded
  assert.deepEqual(am.warmupCandidates(), [], 'freshly capped account not probed');
  a._lastFruitlessProbeAt = Date.now() - am.probeRetryAfterMs - 1000;  // window elapsed
  assert.deepEqual(am.warmupCandidates().map(x => x.name), ['a0'],
    'retried once per window so a transient-looking outage recovers without a restart');
});

// ── unit: the periodic timer sweeps rolled-over windows on an idle proxy ────

test('the periodic warm-up timer sweeps rolled-over windows even with no traffic', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  am.accounts[0].quota.unified5h = 0.5;
  am.accounts[0].quota.unified5hReset = Date.now() - 1000;   // already rolled over
  const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:9', warmupIntervalMs: 25 });
  await listen(proxy);
  try {
    assert.equal(await waitFor(() => am.accounts[0].quota.unified5h == null), true,
      'stale window cleared by the timer sweep alone (no request flowed)');
    assert.equal(am._isMeasured(am.accounts[0]), false, 'account is a warm-up target again');
  } finally {
    await new Promise(r => proxy.close(r));
  }
});

// ── integration: startup fan-out ───────────────────────────────────────────

test('the first real request triggers a fan-out that measures the rest of the fleet', async () => {
  const seen = [];
  const upstream = recordingUpstream(seen);
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(3), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    warmupIntervalMs: 0, // startup fan-out only — isolate it from the periodic timer
  });
  const port = await listen(proxy);

  // One genuine /v1/messages: routes to a0 (warm-up cursor) AND captures the template.
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
    body: JSON.stringify({ model: 'claude-x', system: 'You are Claude Code', messages: [{ role: 'user', content: 'real' }] }),
  });
  assert.equal(r.status, 200);

  // The fan-out probes the other two accounts → all three measured.
  assert.ok(await waitFor(() => seen.length === 3), `expected 3 upstream hits, got ${seen.length}`);
  assert.ok(await waitFor(() => ['a0', 'a1', 'a2'].every(n => measured(am, n))), 'whole fleet measured');

  // Exactly one hit per account (1 real + 2 probes), each with its own bearer token.
  const tokens = new Set(seen.map(s => s.auth));
  assert.deepEqual([...tokens].sort(), ['Bearer tok-0', 'Bearer tok-1', 'Bearer tok-2']);

  // The two probes replay the captured shape: max_tokens 1, same model + system, beta header.
  const probes = seen.filter(s => { try { return JSON.parse(s.body).messages?.[0]?.content === 'ping'; } catch { return false; } });
  assert.equal(probes.length, 2, 'exactly two probes (a0 was measured by the real request, not re-probed)');
  for (const p of probes) {
    const b = JSON.parse(p.body);
    assert.equal(b.max_tokens, 1, 'probe is minimal');
    assert.equal(b.model, 'claude-x', 'probe reuses captured model');
    assert.equal(b.system, 'You are Claude Code', 'probe replays captured system (OAuth requires it)');
    assert.equal(p.beta, 'oauth-2025-04-20', 'probe carries captured anthropic-beta');
  }

  proxy.close();
  upstream.close();
});

// ── integration: periodic warm-up ──────────────────────────────────────────

test('periodic warm-up measures an account added at runtime (no client traffic)', async () => {
  const seen = [];
  const upstream = recordingUpstream(seen);
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    warmupIntervalMs: 50, // fast periodic for the test
  });
  const port = await listen(proxy);

  // One request captures the template and (via the startup fan-out) measures a0+a1.
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'real' }] }),
  });
  assert.ok(await waitFor(() => measured(am, 'a0') && measured(am, 'a1')), 'a0+a1 measured after first request');

  // Add a new account AFTER the startup fan-out — only the periodic timer can reach it.
  am.addAccount({ name: 'a2', type: 'oauth', accessToken: 'tok-2', refreshToken: 'r', expiresAt: Date.now() + HOUR });
  assert.ok(!measured(am, 'a2'), 'new account starts unmeasured');

  assert.ok(await waitFor(() => measured(am, 'a2')), 'periodic warm-up measured the runtime-added account');

  proxy.close();
  upstream.close();
});

// ── integration: best-effort safety ────────────────────────────────────────

test('a failing probe leaves the account unmeasured and never breaks the proxy', async () => {
  const seen = [];
  // Real requests succeed (200 + headers); probes (content "ping") get a 500 with no rate-limit headers.
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ auth: req.headers['authorization'], body: raw });
    let isProbe = false;
    try { isProbe = JSON.parse(raw).messages?.[0]?.content === 'ping'; } catch { /* not json */ }
    if (isProbe) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"x"}'); return; }
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    warmupIntervalMs: 0,
  });
  const port = await listen(proxy);

  const r1 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'real' }] }),
  });
  assert.equal(r1.status, 200);

  // Give the (failing) probe time to run.
  assert.ok(await waitFor(() => seen.some(s => { try { return JSON.parse(s.body).messages?.[0]?.content === 'ping'; } catch { return false; } })), 'a probe was attempted');
  await new Promise(r => setTimeout(r, 50));

  assert.ok(measured(am, 'a0'), 'the account served by the real request is measured');
  assert.ok(!measured(am, 'a1'), 'the failed-probe account stays unmeasured (best-effort)');

  // The proxy is unharmed — a subsequent request still succeeds.
  const r2 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'again' }] }),
  });
  assert.equal(r2.status, 200);

  proxy.close();
  upstream.close();
});

test('a non-exhaustion 429 probe (rate-limit headers but not "rejected") does not measure the account', async () => {
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let isProbe = false;
    try { isProbe = JSON.parse(raw).messages?.[0]?.content === 'ping'; } catch { /* not json */ }
    if (isProbe) {
      // 429 WITH rate-limit headers but unified-status "allowed" → a request-rate /
      // global limit, NOT account exhaustion. Must leave the account untouched.
      res.writeHead(429, {
        ...RL_HEADERS(),
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-status': 'allowed',
        'retry-after': '1',
      });
      res.end('{"error":"rate"}');
      return;
    }
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  const port = await listen(proxy);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'real' }] }),
  });
  assert.ok(await waitFor(() => measured(am, 'a0')), 'a0 measured by the real request');
  await new Promise(r => setTimeout(r, 80)); // let the (non-exhaustion 429) probe finish

  const a1 = am.getStatus().accounts.find(a => a.name === 'a1');
  assert.ok(!measured(am, 'a1'), 'non-exhaustion 429 must NOT mark the probed account measured');
  assert.equal(a1.usage.totalRequests, 0, 'non-exhaustion 429 must not bump usage (no updateQuota)');
  assert.equal(a1.status, 'active', 'non-exhaustion 429 must not change account status');

  proxy.close();
  upstream.close();
});

test('an in-flight probe holds no client concurrency slot (client capacity undiminished)', async () => {
  let probeArrived = false;
  // Real requests answer 200; a probe ("ping") HANGS (never responds), so it is
  // genuinely in flight when we inspect capacity.
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let isProbe = false;
    try { isProbe = JSON.parse(raw).messages?.[0]?.content === 'ping'; } catch { /* not json */ }
    if (isProbe) { probeArrived = true; return; } // hang — hold the probe open
    res.writeHead(200, RL_HEADERS());
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98, 0, 2); // cap 2/account
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  const port = await listen(proxy);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'real' }] }),
  });
  assert.ok(await waitFor(() => probeArrived), 'a probe reached upstream and is hanging in flight');

  // The hanging probe must occupy ZERO concurrency slots — the whole fleet's cap
  // stays available to clients, so a probe can never starve / 429 client traffic.
  const totalInflight = am.accounts.reduce((s, a) => s + a.inflight, 0);
  assert.equal(totalInflight, 0, 'an in-flight probe reserves no client slot');

  proxy.close(); // aborts the hanging probe (warmupAbort)
  upstream.close();
});

// ── integration: master switch ─────────────────────────────────────────────

test('activeWarmup:false sends no probes (only client traffic reaches upstream)', async () => {
  const seen = [];
  const upstream = recordingUpstream(seen);
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(3), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const port = await listen(proxy);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'real' }] }),
  });

  // Wait a beat to prove no background fan-out fires.
  await new Promise(r => setTimeout(r, 150));
  assert.equal(seen.length, 1, 'only the one client request reached upstream — no probes');
  assert.ok(measured(am, 'a0'), 'the routed account is still measured (passive warm-up)');
  assert.ok(!measured(am, 'a1') && !measured(am, 'a2'), 'the rest stay unmeasured (active warm-up off)');

  proxy.close();
  upstream.close();
});
