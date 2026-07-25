import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: `rt-${i}`, expiresAt: Date.now() + HOUR,
  }));
}

// ── refreshLapsedTokens: the periodic keep-alive sweep ──────────────────────
// The refresh-token chain only stays valid while it keeps rotating. An idle
// account (no traffic, and warm-up probes never refresh tokens) would let its
// chain lapse; the sweep refreshes it around each access-token expiry.

test('refreshLapsedTokens targets expiring/expired/error OAuth accounts only', async () => {
  const am = new AccountManager(makeAccounts(6), 0.98, 0, 3);
  am.accounts[0].expiresAt = Date.now() + 2 * HOUR;         // fresh — must be left alone
  am.accounts[1].expiresAt = Date.now() - HOUR;             // expired (idle past its lifetime)
  am.accounts[2].expiresAt = Date.now() + 60_000;           // expiring within the 5-min window
  am.accounts[3].type = 'apikey';                           // no OAuth chain to maintain
  am.accounts[3].refreshToken = null;
  am.accounts[4].status = 'error';                          // parked, token still valid → non-forced no-op (no churn)
  am.accounts[5].status = 'error';                          // parked, expiry UNKNOWN → force (only path that fires)
  am.accounts[5].expiresAt = null;

  const calls = [];
  am.ensureTokenFresh = async (ref, force = false) => {
    calls.push({ name: am._resolve(ref).name, force });
  };

  const attempted = await am.refreshLapsedTokens();
  assert.equal(attempted, 4, 'lapsed + error accounts are attempted (fresh + apikey skipped)');
  assert.deepEqual(
    calls.sort((x, y) => x.name.localeCompare(y.name)),
    [
      { name: 'a1', force: false },   // expired → normal refresh (ensureTokenFresh's own gate passes)
      { name: 'a2', force: false },   // expiring → proactive refresh
      { name: 'a4', force: false },   // error + valid token → non-forced (no-op inside; no rotation churn)
      { name: 'a5', force: true },    // error + no expiresAt → forced, else its chain silently lapses
    ],
  );
});

test('refreshLapsedTokens sweeps disabled accounts too (out of rotation ≠ let the chain die)', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  am.accounts[0].enabled = false;
  am.accounts[0].expiresAt = Date.now() - HOUR;
  const calls = [];
  am.ensureTokenFresh = async (ref) => { calls.push(am._resolve(ref).name); };
  assert.equal(await am.refreshLapsedTokens(), 1);
  assert.deepEqual(calls, ['a0'], 're-enabling later must yield a working token chain');
});

test('refreshLapsedTokens never throws when a refresh rejects', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  am.accounts[0].expiresAt = Date.now() - HOUR;
  am.accounts[1].expiresAt = Date.now() - HOUR;
  am.ensureTokenFresh = async (ref) => {
    if (am._resolve(ref).name === 'a0') throw new Error('refresh_token revoked');
  };
  const attempted = await am.refreshLapsedTokens();   // must not reject
  assert.equal(attempted, 2, 'a rejected refresh does not abort the sweep for the others');
});

test('refreshLapsedTokens runs refreshes sequentially, never as a concurrent burst', async () => {
  const am = new AccountManager(makeAccounts(5), 0.98, 0, 3);
  for (const a of am.accounts) a.expiresAt = Date.now() - HOUR;   // whole fleet lapsed
  let active = 0, peak = 0;
  am.ensureTokenFresh = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
  };
  await am.refreshLapsedTokens();
  assert.equal(peak, 1, 'a fleet-wide lapse must not burst concurrent POSTs at the token endpoint');
});

test('overlapping sweeps are skipped, not stacked', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  for (const a of am.accounts) a.expiresAt = Date.now() - HOUR;
  let calls = 0;
  am.ensureTokenFresh = async () => { calls++; await new Promise(r => setTimeout(r, 20)); };
  const first = am.refreshLapsedTokens();
  const second = await am.refreshLapsedTokens();      // fired while the first is mid-flight
  assert.equal(second, 0, 'the overlapping sweep reports 0 attempts');
  assert.equal(await first, 2);
  assert.equal(calls, 2, 'no account was refreshed twice by stacked sweeps');
});

// ── error-heal scoping in ensureTokenFresh ──────────────────────────────────
// Only a REFRESH-caused 'error' may be healed by a later successful refresh —
// the refresh succeeding is exactly the thing that failed. An error set by the
// request path (upstream 401 despite a fresh token) must NOT be revived by the
// token endpoint accepting a rotation, or the sweep would flap the account back
// into rotation to fail real client traffic every interval.

function fetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

const okTokenResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
});

const deniedTokenResponse = () => ({
  ok: false,
  status: 401,
  text: async () => 'refresh token revoked',
  body: { cancel: async () => {} },
});

test('a refresh-caused error heals back to active on the next successful refresh', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.expiresAt = Date.now() - HOUR;
  // End-to-end: the error is produced by a real failed refresh (network down),
  // exactly as it would be in production — not hand-set.
  let restore = fetchStub(async () => { throw new Error('fetch failed'); });
  try { await am.refreshLapsedTokens(); } finally { restore(); }
  assert.equal(acct.status, 'error', 'failed refresh of an expired token parks the account');

  restore = fetchStub(async () => okTokenResponse());
  try { await am.refreshLapsedTokens(); } finally { restore(); }
  assert.equal(acct.status, 'active', 'refresh-caused error heals — the failed thing now succeeded');
  assert.equal(acct.credential, 'new-at');
  assert.equal(acct.refreshToken, 'new-rt');
});

test('an upstream-auth error is NOT revived by a successful token refresh (no flapping)', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  // Mirror server.js's 401 marking: upstream rejected the account itself.
  acct.status = 'error';
  acct._errorFromRefresh = false;
  acct.expiresAt = Date.now() - HOUR;
  const restore = fetchStub(async () => okTokenResponse());
  try { await am.refreshLapsedTokens(); } finally { restore(); }
  assert.equal(acct.credential, 'new-at', 'the chain is still kept alive for a parked account');
  assert.equal(acct.status, 'error', 'token-endpoint success does not prove the API accepts the account');
});

test('a failed sweep refresh does not relabel an upstream-auth error as refresh-caused', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.status = 'error';
  acct._errorFromRefresh = false;   // parked by the request path
  acct.expiresAt = Date.now() - HOUR;
  let restore = fetchStub(async () => deniedTokenResponse());
  try { await am.refreshLapsedTokens(); } finally { restore(); }
  assert.equal(acct._errorFromRefresh, false, 'the original cause survives a failed refresh');

  restore = fetchStub(async () => okTokenResponse());
  try { await am.refreshLapsedTokens(); } finally { restore(); }
  assert.equal(acct.status, 'error', 'still parked — the relabel would have wrongly revived it');
});

test('a failed refresh of an expired token keeps status=error (no false heal)', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.expiresAt = Date.now() - HOUR;
  const restore = fetchStub(async () => deniedTokenResponse());
  try {
    await am.refreshLapsedTokens();   // full sweep path — must swallow the failure
  } finally {
    restore();
  }
  assert.equal(acct.status, 'error', 'a revoked chain stays out of rotation');
  assert.equal(acct.credential, 'tok-0', 'credential untouched by the failed refresh');
});

test('new external credentials (updateAccountTokens) heal ANY error cause', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.status = 'error';
  acct._errorFromRefresh = false;   // upstream-auth error — sweep won't revive it
  am.updateAccountTokens(0, { accessToken: 'reimported-at', refreshToken: 'reimported-rt', expiresAt: Date.now() + HOUR });
  assert.equal(acct.status, 'active', 're-import/login is the verified heal path for upstream-auth errors');
  assert.equal(acct._errorFromRefresh, undefined, 'stale cause label cleared on heal');
});

// ── race window: 401 landing on an already-parked account ───────────────────
// A request dispatched while the account was healthy can come back 401 AFTER a
// failed sweep refresh already parked the account as refresh-caused. If that
// 401 arrived on a STILL-VALID token it is account-level rejection evidence,
// and the label must be demoted so the next token-endpoint success does not
// revive the account (adversarial-review round 2, HIGH). A 401 on an EXPIRED
// token proves nothing beyond the expiry and must keep the label.

import http from 'node:http';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function run401RaceScenario(parkedTokenStillValid) {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r-a', expiresAt: Date.now() + HOUR },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r-b', expiresAt: Date.now() + HOUR },
  ], 0.98);
  am.ensureTokenFresh = async () => {};   // keep the 401 handler's forced refresh off the network
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      // Park the account WHILE its request is in flight (the race window):
      // a failed sweep refresh labeled it refresh-caused a moment ago.
      am.accounts[0].status = 'error';
      am.accounts[0]._errorFromRefresh = true;
      if (!parkedTokenStillValid) am.accounts[0].expiresAt = Date.now() - HOUR;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);
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
    assert.equal(res.status, 200, 'failed over to the healthy account');
    return am.accounts[0];
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
}

test('a 401 on a STILL-VALID token demotes a refresh-caused label (sweep must not revive)', async () => {
  const a = await run401RaceScenario(true);
  assert.equal(a.status, 'error');
  assert.equal(a._errorFromRefresh, false,
    'valid-token 401 is account-level rejection evidence — label demoted');
});

test('a 401 on an EXPIRED token keeps the refresh-caused label (expiry explains the 401)', async () => {
  const a = await run401RaceScenario(false);
  assert.equal(a.status, 'error');
  assert.equal(a._errorFromRefresh, true,
    'nothing beyond the expiry was proven — the sweep may still heal this account');
});
