import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

// Build a TUI wired to a real AccountManager + a config copy, without start()
// (start() is what touches stdin/stdout — the constructor just sets fields). A
// mock saveConfig records that a persist happened.
function makeTUI(names = ['a0', 'a1', 'a2']) {
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

// ── normal-mode cursor: ↑/↓ select, action keys act on the selection ─────────

test('normal mode: ↑/↓ move a selection cursor over the accounts (clamped at ends)', () => {
  const { tui } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 0;
  tui._keyNormal('down'); assert.equal(tui.selIdx, 1);
  tui._keyNormal('down'); assert.equal(tui.selIdx, 2);
  tui._keyNormal('down'); assert.equal(tui.selIdx, 2, 'clamped at the last account');
  tui._keyNormal('up');   assert.equal(tui.selIdx, 1);
  tui._keyNormal('up'); tui._keyNormal('up'); assert.equal(tui.selIdx, 0, 'clamped at the top');
});

test('normal mode: "s" switches to the ↑/↓-selected account directly (no sub-mode)', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 2; // all unranked → display order == am order
  tui._keyNormal('s');
  assert.equal(am.currentIndex, 2, 'active account is the selected one');
  assert.equal(tui.mode, 'normal');
});

test('normal mode: "e" toggles the ↑/↓-selected account directly', () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('e');
  assert.equal(am.accounts[1].enabled, false, 'selected account disabled directly');
});

test('normal mode: "o" grabs the ↑/↓-selected account into order (move) mode', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('o');
  assert.equal(tui.mode, 'order');
  assert.equal(tui.orderAccount, am.accounts[1], 'grabs the selected account');
});

test('normal mode: "d" asks for confirmation (enters select mode, not a direct delete)', () => {
  const { tui } = makeTUI(['a0', 'a1']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('d');
  assert.equal(tui.mode, 'select', 'delete is destructive → confirmation step, not a direct action');
});

test('select-mode (delete) → Enter removes the cursor account, Esc cancels', async () => {
  const { tui, config } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'select'; tui.selIdx = 1;          // cursor on a1
  tui._keySelect('esc');
  assert.equal(tui.mode, 'normal');
  assert.deepEqual(config.accounts.map(a => a.name), ['a0', 'a1', 'a2'], 'Esc cancels — nothing removed');
  // Enter path delegates to _doRemove (awaited here to assert its effect deterministically).
  await tui._doRemove(tui._displayList()[1].index);
  assert.deepEqual(config.accounts.map(a => a.name), ['a0', 'a2'], 'a1 removed on confirm');
});

// ── moving accounts in the order ────────────────────────────────────────────

test('moving an unranked account up ranks it (#1) and leaves the rest on use-or-lose', async () => {
  const { tui, am, config, saves } = makeTUI();
  tui._moveOrder(am.accounts[1], -1); // a1 up → becomes the only ranked account
  assert.equal(am.accounts[1].priority, 0, 'a1 is now ranked (priority 0, shown as #1)');
  assert.equal(config.accounts[1].priority, 0, 'persisted to config');
  assert.equal(am.accounts[0].priority, null, 'unranked accounts stay null (use-or-lose)');
  assert.equal(am.accounts[2].priority, null);
  assert.equal(tui._rankOf(am.accounts[1]), 1, 'rank badge is the 1-based position');
  assert.equal(saves() >= 1, true, 'saveConfig was called');
});

test('moving up swaps order among ranked; priorities stay contiguous', async () => {
  const { tui, am } = makeTUI();
  tui._moveOrder(am.accounts[0], -1); // a0 → #1 (priority 0)
  tui._moveOrder(am.accounts[1], -1); // a1 → #2 (priority 1)
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1, null]);
  tui._moveOrder(am.accounts[1], -1); // a1 up → swaps above a0
  assert.deepEqual(am.accounts.map(a => a.priority), [1, 0, null], 'a1 now #1, a0 #2');
});

test('moving the last ranked account down un-ranks it (back to use-or-lose)', async () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui._moveOrder(am.accounts[0], -1); // a0 #1
  tui._moveOrder(am.accounts[1], -1); // a1 #2
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1]);
  tui._moveOrder(am.accounts[1], +1); // a1 is last ranked → down → un-rank
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null], 'a1 back to auto (null)');
});

test('moving an account that is already top up, or an unranked account down, is a no-op', async () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui._moveOrder(am.accounts[0], -1);      // a0 #1
  tui._moveOrder(am.accounts[0], -1);      // already top → no change
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null]);
  tui._moveOrder(am.accounts[1], +1);      // a1 unranked, down → no change
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null]);
});

// ── display order ───────────────────────────────────────────────────────────

test('display list shows ranked accounts first (in order), then unranked', async () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui._moveOrder(am.accounts[2], -1); // a2 #1
  tui._moveOrder(am.accounts[0], -1); // a0 #2
  assert.deepEqual(tui._displayList().map(a => a.name), ['a2', 'a0', 'a1'],
    'ranked (a2, a0) first by order, then unranked a1');
});

test('order mode: ↑ moves the grabbed account and the selection follows it', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.orderAccount = am.accounts[2];
  tui.mode = 'order';
  tui.selIdx = tui._displayList().indexOf(am.accounts[2]); // 2 (unranked, bottom)
  tui._keyOrder('up'); // ranks a2 → it floats to the top of the (only) ranked group
  assert.equal(am.accounts[2].priority, 0, 'a2 became ranked');
  assert.equal(tui._displayList()[tui.selIdx], am.accounts[2], 'selection stays on the moved account');
});

test('order mode: "a" un-ranks the grabbed account back to auto in one keypress', () => {
  const { tui, am, config } = makeTUI(['a0', 'a1', 'a2']);
  tui._moveOrder(am.accounts[0], -1);            // a0 #1
  tui._moveOrder(am.accounts[1], -1);            // a1 #2
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1, null]);

  tui.orderAccount = am.accounts[0];
  tui.mode = 'order';
  tui._keyOrder('a');                             // a0 → auto
  assert.equal(am.accounts[0].priority, null, 'a0 back to auto (use-or-lose)');
  assert.equal(am.accounts[1].priority, 0, 'remaining ranked renumbered contiguously');
  assert.equal(config.accounts[0].priority, null, 'persisted null so a stale disk value cannot survive');
  assert.equal(tui.mode, 'order', 'stays in order mode (Enter/Esc to finish)');
  assert.equal(tui._displayList()[tui.selIdx], am.accounts[0], 'selection follows the account');

  tui._keyOrder('a');                             // already auto → harmless no-op
  assert.equal(am.accounts[0].priority, null);
});

// ── normalization of legacy / duplicate priority values ─────────────────────

test('duplicate / legacy priority values render as distinct positions and normalize on a move', async () => {
  const am = new AccountManager([
    { name: 'a0', type: 'apikey', apiKey: 'k', priority: 1 },
    { name: 'a1', type: 'apikey', apiKey: 'k', priority: 0 },
    { name: 'a2', type: 'apikey', apiKey: 'k', priority: 1 }, // duplicate "1"
  ], 0.98, 0, 5);
  const config = { accounts: am.accounts.map(a => ({ name: a.name, priority: a.priority })) };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  // Even with duplicate raw values, the badge shows distinct positions #1..#3.
  assert.deepEqual(tui._displayList().map(a => a.name), ['a1', 'a0', 'a2'], 'sorted by (priority, index)');
  assert.equal(tui._rankOf(am.accounts[1]), 1);
  assert.equal(tui._rankOf(am.accounts[0]), 2);
  assert.equal(tui._rankOf(am.accounts[2]), 3);

  // A move renumbers everyone to contiguous values (no more duplicates).
  tui._moveOrder(am.accounts[2], -1); // a2 up one (swap with a0)
  assert.deepEqual(am.accounts.map(a => a.priority), [2, 0, 1], 'contiguous 0,1,2 — duplicates gone');
});

test('a config priority of null loads as "unset" (use-or-lose)', () => {
  const am = new AccountManager([
    { name: 'a0', type: 'apikey', apiKey: 'k', priority: null },
    { name: 'a1', type: 'apikey', apiKey: 'k' },
  ], 0.98, 0, 5);
  assert.equal(am.accounts[0].priority, null, 'null priority loads as unset');
  assert.equal(am._priority(am.accounts[0]), Infinity, 'unset sentinel — no preference');
});

// ── generated names stay unique (identity key for credential-less accounts) ──

test('generated api names are collision-free after a delete (no duplicate)', async () => {
  const { tui, config } = makeTUI([]); // start empty
  await tui._doAddKey('sk-1');         // api-1
  await tui._doAddKey('sk-2');         // api-2
  assert.deepEqual(config.accounts.map(a => a.name), ['api-1', 'api-2']);
  await tui._doRemove(0);              // delete api-1
  assert.deepEqual(config.accounts.map(a => a.name), ['api-2']);
  await tui._doAddKey('sk-3');         // must reuse the freed api-1, NOT a 2nd api-2
  const names = config.accounts.map(a => a.name).sort();
  assert.equal(new Set(names).size, names.length, 'no duplicate account names');
  assert.deepEqual(names, ['api-1', 'api-2']);
});

// ── model-scoped weekly (Fable) quota bar ────────────────────────────────────

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a wide row renders a third "Fbl" bar for an OAuth account', () => {
  const am = new AccountManager([
    { name: 'max-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0, 5);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 3600_000) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.73',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 86400_000) / 1000)),
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 86400_000) / 1000)),
  });
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  const wide = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(wide, /Ses .*Wk .*Fbl .*94%/s, 'third bar labelled Fbl with the 7d_oi utilization');

  const mid = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false));
  assert.doesNotMatch(mid, /Fbl/, 'no third bar on mid widths');
});

test('an unmeasured Fable window renders an empty Fbl bar; API-key rows pad the slot', () => {
  const am = new AccountManager([
    { name: 'max-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'api-1', type: 'apikey', apiKey: 'sk-1' },
  ], 0.98, 0, 5);
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  const oauthRow = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(oauthRow, /Fbl/, 'OAuth row always shows the Fbl label (with "-" until measured)');

  const apiRow = stripAnsi(tui._renderAcct(am.accounts[1], 1, 10, true, true));
  assert.doesNotMatch(apiRow, /Fbl/, 'API-key accounts have no Fable window');
  assert.equal(oauthRow.length, apiRow.length, 'slot padded so columns stay aligned');
});

// ── enable/disable (unchanged) ──────────────────────────────────────────────

test('TUI "e" toggle disables/enables the selected account and persists it', async () => {
  const { tui, am, config } = makeTUI();
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, false, 'disabled in AccountManager');
  assert.equal(config.accounts[0].enabled, false, 'persisted to config');
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, true, 'toggled back on');
  assert.equal(config.accounts[0].enabled, true);
});
