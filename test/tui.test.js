import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const HOUR = 3600_000;

// Build a TUI wired to a real AccountManager + a config copy, without start()
// (start() is what touches stdin/stdout — the constructor just sets fields). A
// mock saveConfig records that a persist happened and what was written.
function makeTUI(names = ['a0', 'a1']) {
  const accts = names.map(n => ({ name: n, type: 'apikey', apiKey: `sk-${n}` }));
  const am = new AccountManager(accts.map(a => ({ ...a })), 0.98, 0, 5);
  const config = { accounts: accts.map(a => ({ ...a })) };
  let saves = 0;
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => { saves++; },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  return { tui, am, config, saves: () => saves };
}

test('TUI "o" enters select mode for setting priority', () => {
  const { tui } = makeTUI();
  tui.mode = 'normal';
  tui._keyNormal('o');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'priority');
});

test('TUI priority select → Enter opens the numeric input prompt for that account', () => {
  const { tui } = makeTUI();
  tui.mode = 'select'; tui.selAction = 'priority'; tui.selIdx = 1;
  tui._keySelect('enter');
  assert.equal(tui.mode, 'input', 'priority needs a value → input mode (not back to normal)');
  assert.match(tui.inputPrompt, /Priority for "a1"/);
  assert.equal(typeof tui.inputCb, 'function');
});

test('TUI priority input sets the account priority and persists it (config + saveConfig)', async () => {
  const { tui, am, config, saves } = makeTUI();
  tui._promptPriority(1);                 // target a1
  await tui.inputCb('2');                 // user types "2", Enter
  assert.equal(am.accounts[1].priority, 2, 'AccountManager priority updated');
  assert.equal(config.accounts[1].priority, 2, 'config entry persisted');
  assert.equal(saves() >= 1, true, 'saveConfig was called');
  // a1 now outranks a0 (unset) in selection.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)) });
  am.updateQuota(1, { 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)) });
  assert.equal(am._selectBest().name, 'a1');
});

test('TUI priority input with empty value clears the priority', async () => {
  const { tui, am, config } = makeTUI();
  tui._promptPriority(0);
  await tui.inputCb('3');                 // set first
  assert.equal(am.accounts[0].priority, 3);
  tui._promptPriority(0);
  await tui.inputCb('');                  // empty → clear
  assert.equal(am.accounts[0].priority, null, 'cleared in AccountManager');
  // Persisted as explicit null (not a deleted key) so the shared saveConfig
  // `{...diskAcct, ...live}` merge can't let a stale disk priority survive.
  assert.equal(config.accounts[0].priority, null, 'config priority set to null');
});

test('a config priority of null loads as "unset" (use-or-lose), matching a cleared key', () => {
  const am = new AccountManager([
    { name: 'a0', type: 'apikey', apiKey: 'k', priority: null },
    { name: 'a1', type: 'apikey', apiKey: 'k' },
  ], 0.98, 0, 5);
  assert.equal(am.accounts[0].priority, null, 'null priority loads as unset');
  assert.equal(am._priority(am.accounts[0]), Infinity, 'unset sentinel — no preference');
});

test('TUI priority input rejects a non-numeric value (no change)', async () => {
  const { tui, am } = makeTUI();
  tui._promptPriority(0);
  await tui.inputCb('abc');
  assert.equal(am.accounts[0].priority, null, 'invalid input leaves priority unset');
});

test('TUI "e" toggle disables/enables the selected account and persists it', async () => {
  const { tui, am, config } = makeTUI();
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, false, 'disabled in AccountManager');
  assert.equal(config.accounts[0].enabled, false, 'persisted to config');
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, true, 'toggled back on');
  assert.equal(config.accounts[0].enabled, true);
});
