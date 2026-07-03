import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const MIN = 60_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
  }));
}

function setSession(am, idx, util, resetInMs, now = Date.now()) {
  am.accounts[idx].quota.unified5h = util;
  am.accounts[idx].quota.unified5hReset = now + resetInMs;
}

function setWeekly(am, idx, util, resetInMs, now = Date.now()) {
  am.accounts[idx].quota.unified7d = util;
  am.accounts[idx].quota.unified7dReset = now + resetInMs;
}

test('use-or-lose: account whose session resets soonest is chosen first', () => {
  const am = new AccountManager(makeAccounts(3), 0.98);
  setSession(am, 0, 0.10, 4 * HOUR);   // far reset, low usage
  setSession(am, 1, 0.50, 5 * MIN);    // soon reset, mid usage  ← should win
  setSession(am, 2, 0.05, 3 * HOUR);   // far reset, lowest usage
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('use-or-lose: soonest WEEKLY reset wins over soonest session reset', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  // acct-0: session resets very soon, but its week renews far out.
  setSession(am, 0, 0.20, 5 * MIN, now);
  setWeekly(am, 0, 0.40, 6 * 24 * HOUR, now);
  // acct-1: session resets later, but its week renews tomorrow — its unspent
  // weekly quota is about to be wasted, so it must be drained first.
  setSession(am, 1, 0.20, 4 * HOUR, now);
  setWeekly(am, 1, 0.40, 1 * 24 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('weekly tie → session reset decides (accounts without 7d data unchanged)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  const wkReset = 3 * 24 * HOUR;
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setWeekly(am, 0, 0.40, wkReset, now);
  setSession(am, 1, 0.20, 5 * MIN, now);   // same weekly reset → soonest session wins
  setWeekly(am, 1, 0.40, wkReset, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('explicit priority still beats weekly ordering', () => {
  const accts = makeAccounts(2);
  accts[0].priority = 0;                    // pinned #1
  const am = new AccountManager(accts, 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setWeekly(am, 0, 0.40, 6 * 24 * HOUR, now);   // far weekly reset
  setSession(am, 1, 0.20, 5 * MIN, now);
  setWeekly(am, 1, 0.40, 1 * 24 * HOUR, now);   // near weekly reset — loses to the pin
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('tie on reset time → lowest utilization wins', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const reset = 60 * MIN;
  setSession(am, 0, 0.40, reset);
  setSession(am, 1, 0.20, reset);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('accounts at/over threshold are excluded even if their reset is soonest', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  setSession(am, 0, 0.99, 1 * MIN);    // soonest reset but maxed out → excluded
  setSession(am, 1, 0.30, 4 * HOUR);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('current account is sticky between re-evaluations (cache preservation)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);
  setSession(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');   // first call re-evaluates → soonest

  // acct-0 becomes the soonest, but we are inside the 5-min window → stay put
  am.accounts[0].quota.unified5hReset = now + 1 * MIN;
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('re-prioritizes after the interval elapses', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);
  setSession(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');

  // Make acct-0 the soonest and force the interval to have elapsed
  am.accounts[0].quota.unified5hReset = now + 1 * MIN;
  am.lastEvalAt = now - 6 * MIN;
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('reevalIntervalMs <= 0 disables periodic re-prioritization (stays sticky)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);   // 0 = timer disabled
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);   // current (index 0), far reset, higher usage
  setSession(am, 1, 0.10, 5 * MIN, now);    // soonest reset + lower usage — would win if the timer ran

  // Timer disabled → never re-prioritizes, so it stays on the initial current
  // (acct-0) instead of switching to the use-or-lose winner acct-1...
  assert.equal(am.getActiveAccount().name, 'acct-0');
  am.lastEvalAt = now - 60 * MIN;                  // even with lots of time "elapsed"
  assert.equal(am.getActiveAccount().name, 'acct-0');

  // ...but a forced switch still happens when the current account is unavailable.
  am.accounts[0].quota.unified5h = 0.99;           // current now over threshold
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('immediate switch when current hits threshold, picking by priority', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  setSession(am, 0, 0.10, 4 * HOUR);
  setSession(am, 1, 0.10, 10 * MIN);
  setSession(am, 2, 0.10, 2 * MIN);
  assert.equal(am.getActiveAccount().name, 'acct-2');   // soonest

  am.accounts[2].quota.unified5h = 0.99;                // current now maxed
  assert.equal(am.getActiveAccount().name, 'acct-1');   // next-soonest available, not round-robin
});

test('weekly quota over threshold makes an account unavailable', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.10, 1 * MIN, now);
  am.accounts[0].quota.unified7d = 0.99;                // weekly maxed → excluded
  am.accounts[0].quota.unified7dReset = now + 2 * HOUR;
  setSession(am, 1, 0.30, 4 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('returns null when every account is exhausted (not yet reset)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.99, 30 * MIN, now);
  setSession(am, 1, 0.99, 30 * MIN, now);
  assert.equal(am.getActiveAccount(), null);
});

// Measure an account the way a real upstream response would (populates quota + totalRequests).
function measure(am, idx, util5h, resetInMs, now = Date.now()) {
  am.updateQuota(idx, {
    'anthropic-ratelimit-unified-5h-utilization': String(util5h),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + resetInMs) / 1000)),
  });
}

test('warm-up: routes to each unmeasured account until all measured, then priority', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  const now = Date.now();
  // Nothing measured yet → warm-up cycles through accounts one request at a time
  assert.equal(am.getActiveAccount().name, 'acct-0');
  measure(am, 0, 0.50, 4 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
  measure(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-2');
  measure(am, 2, 0.10, 3 * HOUR, now);
  // All measured → use-or-lose priority: soonest reset = acct-1
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('warm-up round-robins so a burst of any size stays spread (no pile-up on acct-0)', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  // 3 fresh accounts, no updateQuota between calls (simulates a concurrent startup
  // burst). Even a burst far larger than maxWarmupTries * accountCount must keep
  // spreading rather than pinning to acct-0 once warm-up attempts are exhausted.
  const picks = Array.from({ length: 12 }, () => am.getActiveAccount().name);
  assert.deepEqual(picks, [
    'acct-0', 'acct-1', 'acct-2', 'acct-0', 'acct-1', 'acct-2',
    'acct-0', 'acct-1', 'acct-2', 'acct-0', 'acct-1', 'acct-2',
  ]);
});

test('warm-up gives up on an account after maxWarmupTries and lets priority start', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  measure(am, 0, 0.30, 4 * HOUR, now);   // acct-0 measured; acct-1 keeps failing before headers
  // acct-1 is a warm-up target; route to it maxWarmupTries times (no measurement)
  for (let i = 0; i < am.maxWarmupTries; i++) {
    assert.equal(am.getActiveAccount().name, 'acct-1');
  }
  // attempts exhausted → warm-up stops → priority over measured accounts (only acct-0)
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('warm-up skips unavailable accounts', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  am.accounts[0].status = 'error';               // unavailable → never warmed
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

// Regression: a request that returns NO rate-limit headers (a HEAD / health
// check, a 404, an auth failure) must NOT permanently disqualify the account
// from warm-up. Otherwise it stays "unmeasured" forever — sorted to the bottom
// of use-or-lose priority (no reset data) and bounced by the unmeasured-
// rebalance — so rotation never uses it and its token never refreshes.
// (Real-world: maestrobs74/77 stuck unmeasured with expired tokens.)
test('a header-less response does not trap an account as permanently unmeasured', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  measure(am, 0, 0.10, 4 * HOUR, now);                  // acct-0 healthy + measured

  // acct-1 gets a warm-up request that returns no rate-limit headers:
  // updateQuota with empty headers bumps totalRequests but leaves it unmeasured.
  assert.equal(am.getActiveAccount().name, 'acct-1');   // warm-up routes to it
  am.updateQuota(1, {});                                 // header-less response
  assert.equal(am.accounts[1].usage.totalRequests, 1);
  assert.equal(am._isMeasured(am.accounts[1]), false);

  // It must STILL be a warm-up target (not abandoned), so a real measurement
  // can still happen. On the OLD code this returned acct-0 (acct-1 trapped).
  assert.equal(am.getActiveAccount().name, 'acct-1');

  // Once a header-bearing response measures it, warm-up stops and use-or-lose
  // priority takes over (acct-1 resets soonest → chosen).
  measure(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am._isMeasured(am.accounts[1]), true);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

// ── model-scoped weekly windows (7d_oi — the "Fable" weekly limit) ────────────

test('updateQuota parses model-scoped weekly windows (7d_oi) generically', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  const resetSec = Math.floor((now + 4 * 24 * HOUR) / 1000);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.86',
    'anthropic-ratelimit-unified-7d-reset': String(resetSec),
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(resetSec),
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed_warning',
  });
  const win = am.accounts[0].quota.modelWeekly['7d_oi'];
  assert.equal(win.utilization, 0.94);
  assert.equal(win.reset, resetSec * 1000, 'reset normalized to ms');
  // The plain 7d window is untouched by the model-scoped one.
  assert.equal(am.accounts[0].quota.unified7d, 0.86);
});

test('a model-scoped weekly limit over threshold does NOT make the account unavailable', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.30',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.50',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
    // Fable weekly exhausted — the account still serves every other model.
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
  });
  assert.equal(am._isAvailable(am.accounts[0]), true);
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

// Regression (review finding): a partial header pair — 7d-reset present but
// 7d-utilization missing/garbled — leaves a reset timestamp with no utilization.
// The expiry sweep used to be gated on `unified7d != null`, so that stale PAST
// timestamp survived forever and, with weekly-first ordering, permanently biased
// selection toward the account. The sweep must clear reset times independently.
test('a stale reset-only weekly timestamp is cleared (no permanent selection bias)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setSession(am, 1, 0.20, 4 * HOUR, now);
  // acct-0 got a garbled pair: reset set (already in the past), utilization never set.
  am.accounts[0].quota.unified7dReset = now - 1000;
  setWeekly(am, 1, 0.40, 3 * 24 * HOUR, now);
  am.getActiveAccount();                       // _isAvailable → expiry sweep
  assert.equal(am.accounts[0].quota.unified7dReset, null, 'stale reset-only timestamp swept');
  assert.equal(am._weeklyResetTime(am.accounts[0]), Infinity, 'no longer sorts as "resets soonest"');
});

// A FUTURE reset-only value (utilization missing/garbled) must not outrank an
// account with no 7d data either — the weekly window counts only when both
// utilization and reset are present ("no weekly data ranks at Infinity").
test('a reset-only weekly window (no utilization) does not bias weekly ordering', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  am.accounts[0].quota.unified7dReset = now + 60_000;   // future reset, utilization never set
  setSession(am, 1, 0.20, 5 * MIN, now);                // no 7d data, soonest session
  assert.equal(am._weeklyResetTime(am.accounts[0]), Infinity, 'partial window ranks at Infinity');
  assert.equal(am.getActiveAccount().name, 'acct-1', 'weekly tie → soonest session still wins');
});

test('an expired model-scoped weekly window is cleared lazily', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.30, 4 * HOUR, now);
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.94, reset: now - 1000 };
  am.getActiveAccount();               // runs _isNearQuota → lazy expiry sweep
  assert.deepEqual(am.accounts[0].quota.modelWeekly, {}, 'stale window removed after its reset passed');
});

// ── quota snapshot persistence (survives a server restart) ───────────────────

test('exportQuotaState → importQuotaState round-trips quota, modelWeekly and a future throttle', () => {
  const now = Date.now();
  const am1 = new AccountManager(makeAccounts(2), 0.98);
  am1.accounts[0].accountUuid = 'uuid-0';
  setSession(am1, 0, 0.54, 1 * HOUR, now);
  setWeekly(am1, 0, 0.86, 4 * 24 * HOUR, now);
  am1.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.94, reset: now + 4 * 24 * HOUR };
  am1.markRateLimited(0, 120);                       // throttled 2 min into the future
  am1.updateQuota(1, {});                            // bump usage counters only

  const snapshot = JSON.parse(JSON.stringify(am1.exportQuotaState())); // via-disk fidelity

  const am2 = new AccountManager(makeAccounts(2), 0.98);
  am2.accounts[0].accountUuid = 'uuid-0';
  am2.importQuotaState(snapshot);
  assert.equal(am2.accounts[0].quota.unified5h, 0.54);
  assert.equal(am2.accounts[0].quota.unified7d, 0.86);
  assert.equal(am2.accounts[0].quota.modelWeekly['7d_oi'].utilization, 0.94);
  assert.equal(am2.accounts[0].status, 'throttled', 'future throttle restored');
  assert.equal(am2._isMeasured(am2.accounts[0]), true, 'restored account skips warm-up');
  assert.equal(am2.accounts[1].usage.totalRequests, 1, 'usage counters carried over');
});

test('importQuotaState skips unknown accounts, expired throttles, and tolerates an old cache shape', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(1), 0.98);
  am.importQuotaState([
    { name: 'ghost', quota: { unified5h: 0.9 } },                       // no such account → skipped
    { name: 'acct-0',
      quota: { unified5h: 0.3, unified5hReset: now + HOUR },            // old cache: no modelWeekly field
      rateLimitedUntil: now - 5000 },                                   // throttle already expired
    null, 'garbage',                                                    // corrupt entries → ignored
  ]);
  assert.equal(am.accounts[0].quota.unified5h, 0.3);
  assert.deepEqual(am.accounts[0].quota.modelWeekly, {}, 'missing modelWeekly backfilled to {}');
  assert.equal(am.accounts[0].status, 'active', 'expired throttle NOT restored');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('getStatus exposes modelWeekly as a detached copy', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
  });
  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.modelWeekly['7d_oi'].utilization, 0.94);
  status.accounts[0].quota.modelWeekly['7d_oi'].utilization = 0;
  assert.equal(am.accounts[0].quota.modelWeekly['7d_oi'].utilization, 0.94,
    'mutating the snapshot must not reach live account state');
});
