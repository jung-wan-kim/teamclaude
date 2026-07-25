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
  const am = new AccountManager(makeAccounts(5), 0.98, 0, 3);
  am.accounts[0].expiresAt = Date.now() + 2 * HOUR;         // fresh — must be left alone
  am.accounts[1].expiresAt = Date.now() - HOUR;             // expired (idle past its lifetime)
  am.accounts[2].expiresAt = Date.now() + 60_000;           // expiring within the 5-min window
  am.accounts[3].type = 'apikey';                           // no OAuth chain to maintain
  am.accounts[3].refreshToken = null;
  am.accounts[4].status = 'error';                          // stuck — force-retried

  const calls = [];
  am.ensureTokenFresh = async (ref, force = false) => {
    calls.push({ name: am._resolve(ref).name, force });
  };

  const attempted = await am.refreshLapsedTokens();
  assert.equal(attempted, 3, 'exactly the lapsed + error accounts are attempted');
  assert.deepEqual(
    calls.sort((x, y) => x.name.localeCompare(y.name)),
    [
      { name: 'a1', force: false },   // expired → normal refresh (ensureTokenFresh's own gate passes)
      { name: 'a2', force: false },   // expiring → proactive refresh
      { name: 'a4', force: true },    // error → forced retry (its expiresAt may look fine)
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

// ── ensureTokenFresh heals 'error' on a successful refresh ──────────────────
// Without this, the sweep's forced retry would rotate the token but leave the
// account status='error' forever — getActiveAccount excludes 'error', so the
// account would never rejoin rotation despite holding a valid token.

function fetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('a successful refresh clears status=error back to active', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.status = 'error';
  acct.expiresAt = Date.now() - HOUR;
  const restore = fetchStub(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
  }));
  try {
    await am.ensureTokenFresh(acct, true);
  } finally {
    restore();
  }
  assert.equal(acct.status, 'active', 'healed account rejoins rotation');
  assert.equal(acct.credential, 'new-at');
  assert.equal(acct.refreshToken, 'new-rt');
});

test('a failed refresh of an expired token keeps status=error (no false heal)', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const acct = am.accounts[0];
  acct.status = 'error';
  acct.expiresAt = Date.now() - HOUR;
  const restore = fetchStub(async () => ({
    ok: false,
    status: 401,
    text: async () => 'refresh token revoked',
    body: { cancel: async () => {} },
  }));
  try {
    await am.refreshLapsedTokens();   // full sweep path — must swallow the failure
  } finally {
    restore();
  }
  assert.equal(acct.status, 'error', 'a revoked chain stays out of rotation');
  assert.equal(acct.credential, 'tok-0', 'credential untouched by the failed refresh');
});
