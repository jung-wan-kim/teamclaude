import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubscriptionHealthy, subscriptionTier, tierLabel, nextRenewalEstimate } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const HOUR = 3600_000;

// ── isSubscriptionHealthy ───────────────────────────────────────────────────

test('isSubscriptionHealthy: active/trialing/unknown are healthy, billing failures are not', () => {
  assert.equal(isSubscriptionHealthy('active'), true);
  assert.equal(isSubscriptionHealthy('trialing'), true);
  assert.equal(isSubscriptionHealthy(null), true, 'no data yet must not render as broken');
  assert.equal(isSubscriptionHealthy(undefined), true);
  for (const bad of ['past_due', 'canceled', 'unpaid', 'incomplete', 'paused']) {
    assert.equal(isSubscriptionHealthy(bad), false, bad);
  }
});

// ── subscriptionTier ────────────────────────────────────────────────────────

test('subscriptionTier: rate_limit_tier suffix wins, plan flags are the fallback', () => {
  assert.equal(subscriptionTier({ rateLimitTier: 'default_claude_max_20x' }), '20x');
  assert.equal(subscriptionTier({ rateLimitTier: 'default_claude_max_5x' }), '5x');
  assert.equal(subscriptionTier({ rateLimitTier: null, hasClaudeMax: true }), 'Max');
  assert.equal(subscriptionTier({ rateLimitTier: null, hasClaudePro: true }), 'Pro');
  assert.equal(subscriptionTier({ orgType: 'claude_pro' }), 'Pro');
  assert.equal(subscriptionTier({}), null);
  assert.equal(subscriptionTier(null), null);
});

test('tierLabel: multiplier tiers read as "Max Nx", flags pass through, unknown is null', () => {
  assert.equal(tierLabel({ rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(tierLabel({ rateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(tierLabel({ hasClaudePro: true }), 'Pro');
  assert.equal(tierLabel({ hasClaudeMax: true }), 'Max');
  assert.equal(tierLabel(null), null);
});

// ── nextRenewalEstimate ─────────────────────────────────────────────────────
// Billing anniversary = the subscription creation day-of-month, clamped to
// shorter months. All cases pin `now` so the tests are deterministic.

test('nextRenewalEstimate: anniversary later this month → this month', () => {
  const d = nextRenewalEstimate('2024-07-05T08:04:31Z', new Date(2026, 7, 1)); // Aug 1
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 5);
});

test('nextRenewalEstimate: anniversary already passed → next month', () => {
  const d = nextRenewalEstimate('2024-07-05T08:04:31Z', new Date(2026, 7, 20)); // Aug 20
  assert.equal(d.getMonth(), 8, 'rolls to September');
  assert.equal(d.getDate(), 5);
});

test('nextRenewalEstimate: today IS the anniversary → today', () => {
  const d = nextRenewalEstimate('2024-07-05T00:00:00', new Date(2026, 7, 5)); // Aug 5
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 5);
});

test('nextRenewalEstimate: December anniversary passed → wraps to January next year', () => {
  const d = nextRenewalEstimate('2024-12-10T00:00:00', new Date(2026, 11, 20)); // Dec 20
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 10);
});

test('nextRenewalEstimate: day-31 anchor clamps to shorter months (Stripe behavior)', () => {
  // Created on the 31st; asking in February → Feb 28 (2026 is not a leap year).
  const feb = nextRenewalEstimate('2024-01-31T00:00:00', new Date(2026, 1, 10));
  assert.equal(feb.getMonth(), 1);
  assert.equal(feb.getDate(), 28);
  // April (30 days) → clamped to 30.
  const apr = nextRenewalEstimate('2024-01-31T00:00:00', new Date(2026, 3, 1));
  assert.equal(apr.getMonth(), 3);
  assert.equal(apr.getDate(), 30);
});

test('nextRenewalEstimate: absent / unparsable input → null', () => {
  assert.equal(nextRenewalEstimate(null), null);
  assert.equal(nextRenewalEstimate(undefined), null);
  assert.equal(nextRenewalEstimate('not-a-date'), null);
});

// ── AccountManager.updateProfile: storage + transition alerts ───────────────

function makeAM(n = 2) {
  const accts = Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: `rt-${i}`, expiresAt: Date.now() + HOUR,
  }));
  return new AccountManager(accts, 0.98, 0, 3);
}

/** Run fn while capturing console.log/error lines; returns the lines. */
function captureConsole(fn) {
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = origLog; console.error = origErr; }
  return lines;
}

test('updateProfile stores the subscription fields on the account', () => {
  const am = makeAM(1);
  am.updateProfile(am.accounts[0], {
    subscriptionStatus: 'active',
    subscriptionCreatedAt: '2024-07-05T08:04:31Z',
    rateLimitTier: 'default_claude_max_20x',
    orgType: 'claude_max',
    hasClaudeMax: true,
    hasClaudePro: false,
  });
  const p = am.accounts[0].profile;
  assert.equal(p.subscriptionStatus, 'active');
  assert.equal(p.rateLimitTier, 'default_claude_max_20x');
  assert.ok(p.fetchedAt > 0, 'stamps fetchedAt');
});

test('updateProfile ignores error payloads and missing accounts', () => {
  const am = makeAM(1);
  am.updateProfile(am.accounts[0], { error: 'HTTP 401' });
  assert.equal(am.accounts[0].profile, null, 'an error payload must not clobber/seed the profile');
  am.updateProfile(99, { subscriptionStatus: 'active' }); // out-of-range index — must not throw
});

test('updateProfile alerts on a transition INTO an unhealthy status (including first fetch)', () => {
  const am = makeAM(2);
  // active → past_due: warn
  am.updateProfile(am.accounts[0], { subscriptionStatus: 'active' });
  let lines = captureConsole(() => am.updateProfile(am.accounts[0], { subscriptionStatus: 'past_due' }));
  assert.ok(lines.some(l => l.includes('⚠') && l.includes('a0') && l.includes('past_due')), 'active→past_due warns');
  // FIRST fetch already unhealthy: warn too (discovering a dead sub is the point)
  lines = captureConsole(() => am.updateProfile(am.accounts[1], { subscriptionStatus: 'canceled' }));
  assert.ok(lines.some(l => l.includes('⚠') && l.includes('a1') && l.includes('canceled')), 'unknown→canceled warns');
});

test('updateProfile is silent on steady state and logs recovery once as info', () => {
  const am = makeAM(1);
  am.updateProfile(am.accounts[0], { subscriptionStatus: 'past_due' });
  // Same status re-observed → silent (no per-sweep spam)
  let lines = captureConsole(() => am.updateProfile(am.accounts[0], { subscriptionStatus: 'past_due' }));
  assert.equal(lines.length, 0, 're-observing the same status is silent');
  // Recovery → one info line, no ⚠
  lines = captureConsole(() => am.updateProfile(am.accounts[0], { subscriptionStatus: 'active' }));
  assert.ok(lines.some(l => l.includes('recovered')), 'recovery is logged');
  assert.ok(!lines.some(l => l.includes('⚠')), 'recovery is not a warning');
  // Healthy first fetch → silent
  const am2 = makeAM(1);
  lines = captureConsole(() => am2.updateProfile(am2.accounts[0], { subscriptionStatus: 'active' }));
  assert.equal(lines.length, 0, 'unknown→active is the normal first fetch, not an event');
});

// ── AccountManager.refreshProfiles: the sweep ───────────────────────────────

test('refreshProfiles sweeps OAuth accounts sequentially with an injected fetcher', async () => {
  const am = makeAM(3);
  am.accounts[1].type = 'apikey';           // no profile endpoint for API keys
  am.accounts[1].refreshToken = null;
  const fetched = [];
  const n = await am.refreshProfiles(async tok => {
    fetched.push(tok);
    return { subscriptionStatus: 'active', rateLimitTier: 'default_claude_max_5x' };
  });
  assert.equal(n, 2, 'only the two OAuth accounts are swept');
  assert.deepEqual(fetched, ['tok-0', 'tok-2']);
  assert.equal(am.accounts[0].profile.subscriptionStatus, 'active');
  assert.equal(am.accounts[2].profile.rateLimitTier, 'default_claude_max_5x');
  assert.equal(am.accounts[1].profile, null, 'apikey account untouched');
});

test('refreshProfiles keeps the previous profile when a fetch fails, and skips error accounts', async () => {
  const am = makeAM(2);
  am.updateProfile(am.accounts[0], { subscriptionStatus: 'active' });
  am.accounts[1].status = 'error';
  const n = await am.refreshProfiles(async () => ({ error: 'HTTP 500' }));
  assert.equal(n, 0, 'nothing updated');
  assert.equal(am.accounts[0].profile.subscriptionStatus, 'active', 'stale profile kept on failure');
  assert.equal(am.accounts[1].profile, null, 'error account skipped');
});

test('refreshProfiles: overlapping sweeps are skipped', async () => {
  const am = makeAM(1);
  let resolveFirst;
  const first = am.refreshProfiles(() => new Promise(r => { resolveFirst = () => r({ subscriptionStatus: 'active' }); }));
  const second = await am.refreshProfiles(async () => { throw new Error('must not be called'); });
  assert.equal(second, 0, 'second sweep bails while the first is in flight');
  resolveFirst();
  assert.equal(await first, 1);
});

// ── snapshot persistence: profile survives a restart ────────────────────────

test('export/importQuotaState round-trips the profile (silently)', () => {
  const am = makeAM(1);
  am.accounts[0].accountUuid = 'uuid-0';
  am.updateProfile(am.accounts[0], {
    subscriptionStatus: 'past_due',
    subscriptionCreatedAt: '2024-07-05T08:04:31Z',
    rateLimitTier: 'default_claude_max_20x',
  });
  const saved = am.exportQuotaState();

  const am2 = makeAM(1);
  am2.accounts[0].accountUuid = 'uuid-0';
  const lines = captureConsole(() => am2.importQuotaState(saved));
  assert.equal(am2.accounts[0].profile.subscriptionStatus, 'past_due');
  assert.equal(am2.accounts[0].profile.rateLimitTier, 'default_claude_max_20x');
  assert.ok(!lines.some(l => l.includes('⚠')), 'restore is not a fresh observation — no re-alert');
});

test('getStatus exposes a profile COPY (not a live reference)', () => {
  const am = makeAM(1);
  am.updateProfile(am.accounts[0], { subscriptionStatus: 'active' });
  const st = am.getStatus();
  st.accounts[0].profile.subscriptionStatus = 'mutated';
  assert.equal(am.accounts[0].profile.subscriptionStatus, 'active', 'caller mutation must not leak in');
  const am2 = makeAM(1);
  assert.equal(am2.getStatus().accounts[0].profile, null, 'no profile → null, not undefined');
});

// ── TUI: tier badge, red unhealthy status, renewal column ───────────────────

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTUIWith(profile) {
  const accts = [{ name: 'acct', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }];
  const am = new AccountManager(accts, 0.98, 0, 3);
  if (profile) am.updateProfile(am.accounts[0], profile);
  const tui = new TUI({
    accountManager: am,
    config: { accounts: accts },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  return { tui, am };
}

test('TUI row shows the tier badge instead of the literal "oauth" once known', () => {
  const { tui, am } = makeTUIWith({ subscriptionStatus: 'active', rateLimitTier: 'default_claude_max_20x' });
  const row = strip(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.ok(row.includes('Max 20x'), `tier badge rendered: ${row}`);
  assert.ok(!row.includes('oauth'), 'literal type replaced by the badge');
});

test('TUI row falls back to the plain type with no profile', () => {
  const { tui, am } = makeTUIWith(null);
  const row = strip(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.ok(row.includes('oauth'), row);
});

test('TUI row shows an unhealthy subscription status (red) and hides the renewal date', () => {
  const { tui, am } = makeTUIWith({
    subscriptionStatus: 'past_due',
    subscriptionCreatedAt: '2024-07-05T08:04:31Z',
    rateLimitTier: 'default_claude_max_20x',
  });
  const raw = tui._renderAcct(am.accounts[0], 0, 10, true, true);
  const row = strip(raw);
  assert.ok(row.includes('past_du'), `status shown (7-col truncated): ${row}`);
  assert.ok(raw.includes('\x1b[31m'), 'rendered in red');
  assert.ok(!row.includes('↻'), 'no renewal estimate for a broken subscription');
});

test('TUI row appends the ↻ renewal estimate on wide (three-bar) terminals only', () => {
  const { tui, am } = makeTUIWith({ subscriptionStatus: 'active', subscriptionCreatedAt: '2024-07-05T08:04:31Z' });
  const wide = strip(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.ok(/↻\d+\/5/.test(wide), `renewal day (anniversary day 5) shown: ${wide}`);
  const mid = strip(tui._renderAcct(am.accounts[0], 0, 10, true, false));
  assert.ok(!mid.includes('↻'), 'mid-width rows skip the renewal column');
});
