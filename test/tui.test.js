import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTokens } from '../src/tui.js';

test('fmtTokens humanizes counts for the activity log', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(undefined), '0');
  assert.equal(fmtTokens(850), '850');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(10_000), '10k');
  assert.equal(fmtTokens(20_000), '20k');
  assert.equal(fmtTokens(1_200_000), '1.2M');
});
