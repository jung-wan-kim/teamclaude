import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolQuota } from '../src/tui.js';

// The pooled row answers "how much runway does the whole fleet have left, and
// when does more arrive". The rendering is a formatting detail; what has to be
// right is the arithmetic — which accounts count, which windows count, and
// which reset is reported.

const oauth = (name, q, extra = {}) => ({ name, type: 'oauth', quota: q, ...extra });
const HOUR = 3600_000;
// Means are floating point — compare with a tolerance, not for bit equality.
const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} (got ${actual}, want ${expected})`);

test('averages utilization across enabled accounts and reports the soonest reset', () => {
  const now = Date.now();
  const p = poolQuota([
    oauth('a', { unified5h: 0.2, unified5hReset: now + 3 * HOUR, unified7d: 0.5, unified7dReset: now + 40 * HOUR }),
    oauth('b', { unified5h: 0.8, unified5hReset: now + 1 * HOUR, unified7d: 0.9, unified7dReset: now + 90 * HOUR }),
  ]);
  assert.equal(p.size, 2);
  assert.equal(p.unified, true);
  close(p.cols[0].util, 0.5, '5h mean of 0.2 and 0.8');
  assert.equal(p.cols[0].reset, now + 1 * HOUR, 'soonest 5h reset, not the average');
  close(p.cols[1].util, 0.7, 'weekly mean');
  assert.equal(p.cols[1].reset, now + 40 * HOUR, 'soonest weekly reset');
});

test('disabled accounts are excluded — they serve no traffic', () => {
  const p = poolQuota([
    oauth('a', { unified5h: 0.2 }),
    oauth('b', { unified5h: 0.4 }),
    oauth('off', { unified5h: 1.0 }, { enabled: false }),
  ]);
  assert.equal(p.size, 2, 'pool size counts only accounts in rotation');
  close(p.cols[0].util, 0.3, 'mean of the two enabled accounts, the disabled 100% ignored');
});

test('an unmeasured window is skipped, never counted as 0%', () => {
  // Counting a not-yet-measured account as empty would report free capacity
  // nobody has confirmed exists.
  const p = poolQuota([
    oauth('measured', { unified5h: 0.9 }),
    oauth('unmeasured', {}),
  ]);
  close(p.cols[0].util, 0.9, 'mean over the one account that has data');
  assert.equal(p.cols[0].n, 1, 'contributor count reflects who actually had data');
});

test('a fully unmeasured pool reports no data rather than a fake zero', () => {
  const p = poolQuota([oauth('a', {}), oauth('b', {})]);
  assert.equal(p.cols[0].util, null);
  assert.equal(p.cols[0].reset, null);
});

test('the Fable (model-scoped weekly) window pools too, preferring 7d_oi', () => {
  const now = Date.now();
  const p = poolQuota([
    oauth('a', { modelWeekly: { '7d_oi': { utilization: 1, reset: now + 5 * HOUR } } }),
    oauth('b', { modelWeekly: { '7d_oi': { utilization: 0.5, reset: now + 2 * HOUR } } }),
  ]);
  close(p.cols[2].util, 0.75, 'Fable weekly mean');
  assert.equal(p.cols[2].reset, now + 2 * HOUR);
});

test('an API-key-only pool reports token/request utilization instead', () => {
  const p = poolQuota([
    { name: 'k1', type: 'apikey', quota: { tokensLimit: 100, tokensRemaining: 40, requestsLimit: 10, requestsRemaining: 5 } },
    { name: 'k2', type: 'apikey', quota: { tokensLimit: 100, tokensRemaining: 80, requestsLimit: 10, requestsRemaining: 5 } },
  ]);
  assert.equal(p.unified, false);
  close(p.cols[0].util, 0.4, 'mean of 60% and 20% used');
  close(p.cols[1].util, 0.5, 'both accounts at half their request quota');
});

test('a mixed pool reports the unified windows — Ses/Wk and Tok/Req are not the same quantity', () => {
  const p = poolQuota([
    oauth('max', { unified5h: 0.6 }),
    { name: 'key', type: 'apikey', quota: { tokensLimit: 100, tokensRemaining: 0 } },
  ]);
  assert.equal(p.unified, true);
  close(p.cols[0].util, 0.6, 'the API-key account is not averaged into the Max window');
});

test('fewer than two accounts in rotation → no pooled row (the row below is the total)', () => {
  assert.equal(poolQuota([]), null);
  assert.equal(poolQuota([oauth('solo', { unified5h: 0.5 })]), null);
  assert.equal(
    poolQuota([oauth('a', { unified5h: 0.5 }), oauth('b', { unified5h: 0.5 }, { enabled: false })]),
    null,
    'one enabled + one disabled is still a pool of one',
  );
});
