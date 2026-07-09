#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath, getServerStatePath, writeServerState, readServerState, clearServerState, readQuotaCache, writeQuotaCacheSync } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { TUI } from './tui.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'stop':
    await stopCommand();
    process.exit(0);
    break;
  case 'restart':
    await restartCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'import':
    await importCommand();
    process.exit(0);
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'disable':
    await setEnabledCommand(false);
    process.exit(0);
    break;
  case 'enable':
    await setEnabledCommand(true);
    process.exit(0);
    break;
  case 'priority':
    await setPriorityCommand();
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
    }
    await serverCommand();
    break;
}

// ── server ──────────────────────────────────────────────────

async function serverCommand() {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    console.error('  teamclaude import           Import from Claude Code');
    console.error('  teamclaude login            OAuth login via browser');
    console.error('  teamclaude login --api      Add an API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.98;
  // An explicit numeric `reevalIntervalMs: 0` (or any number <= 0) disables the
  // 5-minute periodic account re-switching. Require a finite number so a
  // malformed value (false, "", "abc", null, ...) falls back to the default
  // rather than silently disabling switching.
  const reevalIntervalMs = Number.isFinite(config.reevalIntervalMs)
    ? config.reevalIntervalMs
    : 5 * 60 * 1000;
  // Default per-account concurrency cap (max simultaneous in-flight requests an
  // account handles before load spreads to the next account). A per-account
  // `maxConcurrent` overrides this. Must be a positive number, else default 3.
  const maxConcurrentDefault = Number.isFinite(config.maxConcurrentPerAccount) && config.maxConcurrentPerAccount >= 1
    ? config.maxConcurrentPerAccount
    : 3;
  // Hard cap on the overflow wait-queue (requests waiting for a free slot when
  // every account is at its cap). Bounds memory/FDs under a request flood.
  const overflowQueueMaxDepth = Number.isFinite(config.overflowQueueMaxDepth) && config.overflowQueueMaxDepth >= 0
    ? config.overflowQueueMaxDepth
    : 256;
  const accountManager = new AccountManager(accounts, threshold, reevalIntervalMs, maxConcurrentDefault, overflowQueueMaxDepth);

  // Restore the last run's quota snapshot so a restart doesn't blank the
  // dashboard (quota otherwise lives only in memory and is re-learned from
  // traffic). Stale-safe: the proxy takes no traffic while down, expired
  // windows are lazily swept, and a still-future throttle is re-applied.
  const quotaCache = await readQuotaCache();
  if (quotaCache?.accounts) {
    accountManager.importQuotaState(quotaCache.accounts);
    // Restore the active-account marker too (identity by name) so the sticky
    // primary — and its warm prompt cache — carries across the restart.
    const cur = quotaCache.currentAccount
      && accountManager.accounts.find(a => a.name === quotaCache.currentAccount);
    if (cur) accountManager.currentIndex = cur.index;
    console.log(`[TeamClaude] Restored quota snapshot for ${quotaCache.accounts.length} account(s)`);
  }
  const saveQuotaSnapshot = () => writeQuotaCacheSync({
    savedAt: new Date().toISOString(),
    currentAccount: accountManager.accounts[accountManager.currentIndex]?.name || null,
    accounts: accountManager.exportQuotaState(),
  });

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamclaude import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep the in-memory config.accounts in sync so a TUI saveConfig doesn't
    // clobber fresh tokens. Match by IDENTITY (UUID first, then name) — not by the
    // AccountManager index `idx`, which can point at a different config entry when
    // a tokenless config account was skipped at load.
    const memIdx = findConfigAccount(config, account);
    if (memIdx >= 0) {
      config.accounts[memIdx].accessToken = newTokens.accessToken;
      config.accounts[memIdx].refreshToken = newTokens.refreshToken;
      config.accounts[memIdx].expiresAt = newTokens.expiresAt;
    }
    atomicConfigUpdate(diskConfig => {
      // Persist ONLY the refreshed account's tokens. We deliberately do NOT ingest
      // disk-only accounts here: that loop existed to keep the old INDEX-based
      // matching aligned, but matching is identity-based now (findConfigAccount),
      // so it's unnecessary — and re-adding every disk account would resurrect one
      // the TUI just deleted (whose save may not have committed yet). External
      // account discovery stays in syncAccountsFromDisk (TUI R / restart).
      // Match by UUID first, then by name — index may have shifted.
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        diskConfig.accounts[cfgIdx].accessToken = newTokens.accessToken;
        diskConfig.accounts[cfgIdx].refreshToken = newTokens.refreshToken;
        diskConfig.accounts[cfgIdx].expiresAt = newTokens.expiresAt;
      }
    }).catch(err => console.error(`[TeamClaude] Failed to save refreshed token: ${err.message}`));
  });
  const port = config.proxy.port;
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        const mapped = config.accounts.map(a => {
          // Match the live account by IDENTITY — never by array index:
          // resolveAccounts() can skip a tokenless/bad config entry, so
          // config.accounts and accountManager.accounts are not index-aligned, and
          // an index map would overlay the wrong account's credentials. Two-phase
          // (UUID first, then name): a single `uuid===x || name===x` find could
          // return an earlier same-name account before reaching the real UUID match.
          const am = (a.accountUuid && accountManager.accounts.find(x => x.accountUuid === a.accountUuid))
            || accountManager.accounts.find(x => x.name === a.name);
          const live = am ? {
            ...a,
            accessToken: am.credential,
            refreshToken: am.refreshToken,
            expiresAt: am.expiresAt,
          } : a;
          const diskAcct = (a.accountUuid && diskConfig.accounts.find(d => d.accountUuid === a.accountUuid))
            || diskConfig.accounts.find(d => d.name === a.name);
          return diskAcct ? { ...diskAcct, ...live } : live;
        });
        // The TUI's in-memory config is authoritative for the account SET (an
        // account it deleted must stay deleted, not be resurrected from the disk
        // copy this atomic update re-read). An account added to disk by an external
        // `teamclaude import/login` while the TUI runs is reconciled on the next
        // reload (R) / restart via syncAccountsFromDisk — not merged here, since we
        // can't distinguish "added externally" from "deleted locally" at save time.
        diskConfig.accounts = mapped;
      }),
      syncAccounts: async () => {
        const diskConfig = await loadConfig();
        if (!diskConfig) return 0;
        return syncAccountsFromDisk(diskConfig, config, accountManager);
      },
      // R also forces a fleet-wide quota re-measure. `server` is assigned below
      // (before listen), and the TUI only starts inside the listen callback, so
      // this closure never runs before the binding is initialized.
      refreshQuota: () => server.refreshQuotaAll(),
      onQuit: () => { server.close(() => process.exit(0)); },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  // If a TeamClaude server is already running on this config's port, don't try to
  // bind on top of it — point the user at stop/restart instead of a raw EADDRINUSE.
  const existing = await findRunningServer(config);
  if (existing && existing.port === port) {
    console.error(`[TeamClaude] A server is already running on port ${port}${existing.pid ? ` (pid ${existing.pid})` : ''}.`);
    console.error('  See it:      teamclaude status');
    console.error('  Stop it:     teamclaude stop');
    console.error('  Restart it:  teamclaude restart');
    process.exit(1);
  }

  const server = createProxyServer(accountManager, config, hooks);
  // Catch bind-time errors (e.g. EADDRINUSE) only. Once the socket is bound we
  // remove this handler so a later runtime 'error' isn't misreported as a
  // listen failure and exit the whole proxy.
  const onListenError = err => handleServerListenError(err, port);
  server.once('error', onListenError);

  server.listen(port, () => {
    server.removeListener('error', onListenError);
    // Record runtime state so `teamclaude status/stop/restart` can find us, and
    // remove it on process exit (covers SIGINT/SIGTERM/TUI quit/normal exit). A
    // SIGKILL leaves a stale file, which stop/server detect as dead and clean up.
    writeServerState({ pid: process.pid, port, startedAt: new Date().toISOString(), config: getConfigPath() }).catch(() => {});
    const stateP = getServerStatePath();
    process.on('exit', () => { try { unlinkSync(stateP); } catch { /* already gone */ } });
    // Persist the quota snapshot on every exit path (TUI quit, SIGINT/SIGTERM
    // → server.close → process.exit) and every minute as a crash backstop
    // (a SIGKILL loses at most the last interval). The 'exit' write is sync.
    process.on('exit', saveQuotaSnapshot);
    setInterval(saveQuotaSnapshot, 60_000).unref();
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamClaude Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Upstream:   ${config.upstream || 'https://api.anthropic.com'}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type})`);
      });
      console.log('');
      console.log('  Run Claude through proxy:  teamclaude run');
      console.log('  Show env vars:             teamclaude env');
      console.log(sep);
      console.log('');
    }
  });

  if (!tui) {
    process.on('SIGINT', () => {
      console.log('\n[TeamClaude] Shutting down...');
      server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      console.log('\n[TeamClaude] Shutting down...');
      server.close(() => process.exit(0));
    });
  }
}

// ── server lifecycle: discover / stop / restart ─────────────

// Function declaration (not a const arrow) so it is hoisted — these helpers run
// from the top-level command switch, which executes before later `const` lines
// in this module are initialized (temporal dead zone).
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Is a pid alive? EPERM = alive but not ours; ESRCH = gone. */
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(150);
  }
  return !isPidAlive(pid);
}

/**
 * Does a *TeamClaude* proxy answer on this port? Verifies the status endpoint
 * returns our JSON shape, not just any 200 — so a foreign process occupying the
 * port is NOT mistaken for our server (it falls through to the EADDRINUSE path).
 */
async function probeServer(port, timeoutMs = 1500) {
  if (!port) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data?.accounts) && typeof data?.switchThreshold === 'number';
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Best-effort: the pid listening on a TCP port (macOS/Linux via lsof). */
function lsofPid(port) {
  if (process.platform === 'win32') return null;
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = parseInt((r.stdout || '').trim().split('\n')[0], 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

/**
 * Locate a running TeamClaude server for this config's port, returning the pid
 * that ACTUALLY owns the listening socket — never a pid taken on faith from the
 * state file. That matters because a state file can be stale (the recorded pid
 * died and the OS recycled it for an unrelated process) or hand-written; trusting
 * it would let `stop` signal the wrong pid. So: confirm a TeamClaude-shaped server
 * answers on the port, then resolve the owner via `lsof`. The state file is only a
 * fallback for the pid when lsof can't determine it (and only if it's alive and
 * for this same port). Returns { pid, port } (pid may be null if undeterminable),
 * or null when nothing is listening.
 */
async function findRunningServer(config) {
  const configPort = config?.proxy?.port;
  const state = await readServerState();

  // Try the port the server ACTUALLY bound (recorded in the state file) first —
  // it may differ from the current config port after the config was edited, and
  // probing only the config port would miss (and then orphan) the live server.
  const candidates = [];
  if (state?.port) candidates.push(state.port);
  if (configPort && configPort !== state?.port) candidates.push(configPort);

  for (const port of candidates) {
    if (!(await probeServer(port))) continue;
    const ownerPid = lsofPid(port); // authoritative: who actually holds the socket
    if (ownerPid) return { pid: ownerPid, port };
    // lsof unavailable: trust the recorded pid only if alive AND recorded for THIS port.
    if (state?.pid && state.port === port && isPidAlive(state.pid)) return { pid: state.pid, port };
    return { pid: null, port };
  }

  // Nothing TeamClaude-shaped answers on any candidate port. Only drop the state
  // file if its recorded pid is also gone — don't delete the discovery record for
  // a server that's merely unreachable for a moment.
  if (state && !(state.pid && isPidAlive(state.pid))) await clearServerState();
  return null;
}

/**
 * Stop the running server: SIGTERM, wait for graceful exit, escalate to SIGKILL.
 * Returns { stopped, reason?, pid?, port? }.
 */
async function stopRunningServer() {
  const config = await loadConfig();
  if (!config) return { stopped: false, reason: 'not-running' };

  const found = await findRunningServer(config);
  if (!found) { await clearServerState(); return { stopped: false, reason: 'not-running' }; }

  const { pid, port } = found;
  if (!pid) return { stopped: false, reason: 'no-pid', port };

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') { await clearServerState(); return { stopped: true, pid, port }; }
    if (e.code === 'EPERM') return { stopped: false, reason: 'eperm', pid, port };
    throw e;
  }

  if (!(await waitForExit(pid, 6000))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* may have just exited */ }
    await waitForExit(pid, 2000);
  }
  if (isPidAlive(pid)) return { stopped: false, reason: 'failed', pid, port };

  await clearServerState();
  return { stopped: true, pid, port };
}

async function stopCommand() {
  const r = await stopRunningServer();
  if (r.stopped) {
    console.log(`Stopped TeamClaude server (pid ${r.pid}, port ${r.port}).`);
    return;
  }
  switch (r.reason) {
    case 'not-running':
      console.log('No TeamClaude server is running.');
      return;
    case 'no-pid':
      console.error(`A server is responding on port ${r.port} but its PID is unknown (lsof unavailable).`);
      console.error(`Stop it once with:  kill $(lsof -nP -iTCP:${r.port} -sTCP:LISTEN -t)`);
      process.exit(1);
      break;
    case 'eperm':
      console.error(`No permission to signal pid ${r.pid}.`);
      process.exit(1);
      break;
    default:
      console.error(`Failed to stop pid ${r.pid} on port ${r.port}.`);
      process.exit(1);
  }
}

async function restartCommand() {
  const r = await stopRunningServer();
  if (r.stopped) {
    console.log(`Stopped previous server (pid ${r.pid}).`);
  } else if (r.reason !== 'not-running') {
    console.error(`Could not stop the existing server (${r.reason}); aborting restart.`);
    if (r.reason === 'no-pid') {
      console.error(`Stop it manually first:  kill $(lsof -nP -iTCP:${r.port} -sTCP:LISTEN -t)`);
    }
    process.exit(1);
  }
  // Wait for the port to be released before re-binding.
  const port = (await loadConfig())?.proxy?.port;
  for (let i = 0; i < 20 && await probeServer(port, 500); i++) await delay(150);
  await serverCommand();
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();

  let name = argValue('--name');
  const jsonStr = argValue('--json');

  let creds;
  if (jsonStr) {
    // Accept raw JSON: --json '{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}'
    // or flat: --json '{"accessToken":"...","refreshToken":"...","expiresAt":...}'
    try {
      const raw = JSON.parse(jsonStr);
      const data = raw.claudeAiOauth || raw;
      if (!data.accessToken) {
        console.error('JSON must contain "accessToken" (directly or under "claudeAiOauth")');
        process.exit(1);
      }
      creds = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
      };
    } catch (err) {
      console.error(`Failed to parse --json: ${err.message}`);
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from') || '~/.claude/.credentials.json';
    try {
      creds = await importCredentials(fromPath);
    } catch (err) {
      console.error(`Failed to import from ${fromPath}: ${err.message}`);
      process.exit(1);
    }
  }

  await upsertOAuthAccount(config, name, creds, 'import');
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }

  // Default to OAuth if not a TTY
  if (!process.stdout.isTTY) {
    await loginOAuthCommand();
    return;
  }

  // Interactive menu
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.log('Select login method:\n');
  console.log('  1. Claude subscription  (Pro, Max, Team, Enterprise)');
  console.log('  2. Anthropic API key    (Console API billing)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginApiCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  if (!name) {
    // First FREE api-N (not `count + 1`, which collides after a delete) — a unique
    // name is the identity key for credential-less API-key accounts.
    let n = 1;
    do { name = `api-${n++}`; } while (config.accounts.some(a => a.name === name));
  }

  config.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  await saveConfig(config);
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamclaude import        Import from existing Claude Code credentials');
    console.error('  teamclaude login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${config.proxy.port}`);
  console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
}

// ── run ─────────────────────────────────────────────────────

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === '--') claudeArgs.shift();

  // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
  // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
  // lets Claude Code stay in subscription mode (full model access).
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${config.proxy.port}`,
    },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  // Locate the actual running server (its bound port may differ from the current
  // config port after an edit). findRunningServer handles stale-state cleanup; do
  // NOT clear state here, or a momentary blip would orphan a live server.
  const running = await findRunningServer(config);
  if (!running) {
    console.log(`Server:         not running (no proxy on port ${config.proxy.port})`);
    console.log('Start it with:  teamclaude server');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${running.port}/teamclaude/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();

    const pidStr = running.pid ? `pid ${running.pid}, ` : '';
    console.log(`Server:         running (${pidStr}port ${running.port})`);
    console.log(`Active account: ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';

      const disabledTag = acct.enabled === false ? ' [disabled]' : '';
      console.log(`  ${acct.name} (${acct.type})${current}${disabledTag}`);
      console.log(`    Status:   ${acct.status}${acct.enabled === false ? ' (disabled — out of rotation)' : ''}`);
      if (acct.priority != null) console.log(`    Priority: ${acct.priority} (lower = preferred)`);
      if (acct.maxConcurrent != null) {
        console.log(`    In flight: ${acct.inflight ?? 0}/${acct.maxConcurrent} concurrent`);
      }

      if (q.unified5h != null || q.unified7d != null || Object.keys(q.modelWeekly ?? {}).length > 0) {
        const ses = q.unified5h != null ? (q.unified5h * 100).toFixed(1) + '%' : '-';
        const wk = q.unified7d != null ? (q.unified7d * 100).toFixed(1) + '%' : '-';
        let line = `    Session:  ${ses} used    Weekly: ${wk} used`;
        // Model-scoped weekly windows (7d_oi = the Fable weekly limit). Guarded
        // with ?. so a status from an older running server (no modelWeekly
        // field) still prints. Unknown labels print as-is.
        for (const [label, w] of Object.entries(q.modelWeekly ?? {})) {
          if (w?.utilization == null) continue;
          const name = label === '7d_oi' ? 'Fable wk' : label;
          line += `    ${name}: ${(w.utilization * 100).toFixed(1)}% used`;
        }
        console.log(line);
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    // findRunningServer just confirmed a server answered; a failure here is a
    // transient blip, not a reason to delete the discovery record.
    console.log(`Server:         unreachable (port ${running.port}) — try again`);
    process.exit(1);
  }
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  const config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamclaude import, teamclaude login, or teamclaude login --api');
    return;
  }

  // Refresh expired tokens before fetching profiles
  let configDirty = false;
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'oauth' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken);
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      a.expiresAt = newTokens.expiresAt;
      configDirty = true;
    } catch (err) {
      // refresh failed — fetchProfile will report the specific error
    }
  }));
  if (configDirty) await saveConfig(config);

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a =>
      a.type === 'oauth' && a.accessToken ? fetchProfile(a.accessToken) : null
    )
  );

  // Deduplicate by accountUuid — keep the last (most recently added) entry
  const seen = new Map();
  let removed = 0;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const uuid = profiles[i]?.accountUuid || a.accountUuid;
    if (uuid) {
      if (seen.has(uuid)) {
        config.accounts.splice(i, 1);
        profiles.splice(i, 1);
        removed++;
      } else {
        seen.set(uuid, i);
        // Update stored UUID and name from profile
        if (profiles[i] && !profiles[i].error) {
          a.accountUuid = profiles[i].accountUuid;
          if (profiles[i].email) a.name = profiles[i].email;
        }
      }
    }
  }
  if (removed > 0) {
    await saveConfig(config);
    console.log(`Removed ${removed} duplicate account(s)\n`);
  }

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      continue;
    }

    // OAuth account
    const hasProfile = p && !p.error;
    const tier = hasProfile ? (p.hasClaudeMax ? 'Max' : p.hasClaudePro ? 'Pro' : 'subscription') : null;
    const status = hasProfile ? `Claude ${tier}` : `unknown (${p?.error || 'no token'})`;
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${status}${src})`);
    if (hasProfile && p.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
    if (hasProfile && p.orgName) console.log(`       Org:   ${p.orgName}`);
    if (verbose && a.expiresAt) {
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log(`       Token: expired`);
      } else {
        const mins = Math.floor(remaining / 60000);
        const hrs = Math.floor(mins / 60);
        const expiry = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
        console.log(`       Token: expires in ${expiry}`);
      }
    }
  }
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamclaude api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamclaude api /api/oauth/claude_cli/roles');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');

  const accounts = await resolveAccounts(config);
  let account;
  if (accountName) {
    account = accounts.find(a => a.name === accountName);
    if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'oauth') || accounts[0];
    if (!account) { console.error('No accounts configured'); process.exit(1); }
  }

  const credential = account.accessToken || account.apiKey;
  const isOAuth = account.type === 'oauth';
  const upstream = config.upstream || 'https://api.anthropic.com';
  const url = path.startsWith('http') ? path : `${upstream}${path}`;

  const headers = isOAuth
    ? { 'Authorization': `Bearer ${credential}` }
    : { 'x-api-key': credential };

  const fetchOpts = { method, headers };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

// ── enable / disable / priority ─────────────────────────────

/** Note that changes apply to a running server only after a reload/restart. */
function noteRunningServerReload(config) {
  return findRunningServer(config).then(running => {
    if (running) {
      console.log('A server is running — apply now with: teamclaude restart');
      console.log('  (or press "R" in the TUI to reload from config).');
    }
  }).catch(() => {});
}

async function setEnabledCommand(enabled) {
  const name = args[1];
  if (!name) {
    console.error(`Usage: teamclaude ${enabled ? 'enable' : 'disable'} <account-name>`);
    process.exit(1);
  }
  // atomicConfigUpdate re-reads disk before writing, so a concurrent token
  // refresh from the running server (or another CLI edit) isn't clobbered by a
  // stale snapshot. Match by name (what the user typed) within the fresh copy.
  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const acct = cfg.accounts.find(a => a.name === name);
    if (acct) { acct.enabled = enabled; found = true; }
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(`${enabled ? 'Enabled' : 'Disabled'} account "${name}"`);
  if (!enabled) console.log('  (excluded from active rotation; in-flight requests still finish)');
  await noteRunningServerReload(config);
}

async function setPriorityCommand() {
  const name = args[1];
  const raw = args[2];
  if (!name || raw === undefined) {
    console.error('Usage: teamclaude priority <account-name> <number|auto>');
    console.error('  Lower number = preferred first. Use "auto" (or "clear") to return the');
    console.error('  account to automatic ordering: weekly reset soonest is drained first.');
    process.exit(1);
  }
  const clearing = raw === 'auto' || raw === 'clear' || raw === 'none' || raw === 'null';
  let value = null;
  if (!clearing) {
    const n = Number(raw);
    if (!Number.isFinite(n)) { console.error(`Invalid priority "${raw}" — expected a number or "auto"`); process.exit(1); }
    value = Math.floor(n);
  }
  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const acct = cfg.accounts.find(a => a.name === name);
    if (acct) { found = true; if (clearing) delete acct.priority; else acct.priority = value; }
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(clearing
    ? `Set "${name}" to auto (use-or-lose ordering: weekly reset soonest first)`
    : `Set priority of "${name}" to ${value} (lower = preferred first)`);
  await noteRunningServerReload(config);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamClaude - Multi-account Claude proxy

Usage: teamclaude [command] [options]

Commands:
  server              Start the proxy server (default)
  stop                Stop the running proxy server
  restart             Stop the running server (if any) and start a fresh one
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  accounts            List configured accounts
  remove <name>       Remove an account
  disable <name>      Disable an account (excluded from rotation)
  enable <name>       Re-enable a disabled account
  priority <name> <n> Set selection priority (lower = preferred; "auto" to return
                      to automatic ordering — weekly reset soonest drained first)
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

async function upsertOAuthAccount(config, name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account UUID
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  if (!name) {
    // First FREE account-N (not `count + 1`, which collides after a delete) so the
    // generated name stays a unique identity key.
    let n = 1;
    do { name = `account-${n++}`; } while (config.accounts.some(a => a.name === name));
  }

  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  // Deduplicate: match by UUID first, then by name
  let idx = profile?.accountUuid
    ? config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
    : -1;
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    // Re-credentialing an existing account must not wipe its manual routing
    // settings — carry enabled/priority over from the entry being replaced.
    const prev = config.accounts[idx];
    if (prev.enabled !== undefined) account.enabled = prev.enabled;
    if (prev.priority !== undefined) account.priority = prev.priority;
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account (by UUID, then name).
 */
function findConfigAccount(diskConfig, account) {
  if (account.accountUuid) {
    const idx = diskConfig.accounts.findIndex(a => a.accountUuid === account.accountUuid);
    if (idx >= 0) return idx;
  }
  return diskConfig.accounts.findIndex(a => a.name === account.name);
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  for (const diskAcct of diskConfig.accounts) {
    const matchByUuid = diskAcct.accountUuid &&
      memConfig.accounts.findIndex(a => a.accountUuid === diskAcct.accountUuid);
    const matchByName = memConfig.accounts.findIndex(a => a.name === diskAcct.name);
    const memIdx = (matchByUuid >= 0 ? matchByUuid : null) ?? (matchByName >= 0 ? matchByName : -1);

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    // Find the corresponding AccountManager entry — UUID first, then name, so a
    // disk entry whose UUID and name resolve to *different* live accounts can't
    // misattribute the update to the name-match when a UUID-match exists.
    const mgr = (diskAcct.accountUuid && accountManager.accounts.find(a => a.accountUuid === diskAcct.accountUuid))
      || accountManager.accounts.find(a => a.name === diskAcct.name);

    // Apply enable/disable + priority from disk FIRST — independent of credential
    // re-resolution below. A failed re-import (freshCred null) must NOT strand a
    // `teamclaude disable`/`priority` set while the server runs. setEnabled drains
    // the overflow queue when re-enabling so a freed-up account is used at once.
    if (mgr) {
      const wantEnabled = diskAcct.enabled !== false;
      if (mgr.enabled !== wantEnabled) accountManager.setEnabled(mgr, wantEnabled);
      const diskPriority = Number.isFinite(diskAcct.priority) ? Math.floor(diskAcct.priority) : null;
      if (mgr.priority !== diskPriority) accountManager.setPriority(mgr, diskPriority);
      // Mirror the applied state into the in-memory config copy too. Otherwise a
      // later TUI saveConfig (for any unrelated op) would spread the pre-sync
      // enabled/priority over the disk value and silently revert a CLI change.
      const memAcct = memConfig.accounts[memIdx];
      if (memAcct) {
        if (wantEnabled) delete memAcct.enabled; else memAcct.enabled = false;
        if (diskPriority === null) delete memAcct.priority; else memAcct.priority = diskPriority;
      }
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred || !mgr) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          // Carry accountUuid through so the live account can be matched UUID-first
          // on sync (otherwise it stays null and a name change misroutes the update).
          accounts.push({ name: acct.name, type: 'oauth', accountUuid: acct.accountUuid, maxConcurrent: acct.maxConcurrent, enabled: acct.enabled, priority: acct.priority, ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

function handleServerListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[TeamClaude] Port ${port} is already in use.`);
    console.error('Another TeamClaude proxy may already be running.');
    console.error('  See it:     teamclaude status');
    console.error('  Stop it:    teamclaude stop');
    console.error('  Restart it: teamclaude restart');
  } else if (err.code === 'EACCES') {
    console.error(`[TeamClaude] Permission denied while listening on port ${port}.`);
    console.error('Choose a non-privileged port in the TeamClaude config.');
  } else {
    console.error(`[TeamClaude] Failed to listen on port ${port}: ${err.message}`);
  }
  process.exit(1);
}
