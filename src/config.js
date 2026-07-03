import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

// Runtime state for the running server (pid/port), written next to the config so
// `teamclaude status` / `stop` / `restart` can find and signal it without the
// user hunting for the PID. One file per config, so different configs (and ports)
// never collide.
export function getServerStatePath() {
  return getConfigPath().replace(/\.json$/, '') + '.server.json';
}

export async function writeServerState(state) {
  const path = getServerStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export async function readServerState() {
  try {
    return JSON.parse(await readFile(getServerStatePath(), 'utf-8'));
  } catch {
    return null; // missing or unreadable → treat as "no recorded server"
  }
}

export async function clearServerState() {
  try { await rm(getServerStatePath(), { force: true }); } catch { /* best-effort */ }
}

// Per-account quota snapshot (credential-free), written next to the config so a
// restarted server starts from the last known quota/throttle state instead of a
// blank dashboard. Unlike the server-state file this survives exit on purpose.
export function getQuotaCachePath() {
  return getConfigPath().replace(/\.json$/, '') + '.quota.json';
}

export async function readQuotaCache() {
  try {
    return JSON.parse(await readFile(getQuotaCachePath(), 'utf-8'));
  } catch {
    return null; // missing or unreadable → start unmeasured, exactly as before
  }
}

/**
 * Synchronous on purpose: the last write happens inside a process 'exit'
 * handler, where async I/O never completes. The snapshot is small (a few KB).
 */
export function writeQuotaCacheSync(data) {
  try {
    const path = getQuotaCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch { /* best-effort — a failed snapshot must never break the proxy */ }
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    // Max simultaneous in-flight requests per account before load spreads to the
    // next account (per-account `maxConcurrent` overrides this). Tune to just
    // below where one account starts returning rate/concurrency 429s.
    maxConcurrentPerAccount: 3,
    // Keep one client connection's sequential requests on the same account so
    // Anthropic's per-account prompt cache stays warm (a session's turns reuse
    // the keep-alive socket). Soft: concurrent overflow still spreads to other
    // accounts. Set false to route every request purely by use-or-lose priority.
    sessionAffinity: true,
    // How long (ms) a request waits for a free slot when every account is at its
    // cap, before returning 429. 0 = never queue.
    overflowQueueTimeoutMs: 15000,
    // Hard caps that bound proxy memory under a request flood.
    overflowQueueMaxDepth: 256,        // max queued requests before 429
    maxRequestBytes: 33554432,         // 32 MiB max buffered request body, else 413
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
  }
  return config;
}

export async function saveConfig(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs).
 *
 * Calls are SERIALIZED within this process (via the chain below): atomicConfigUpdate
 * re-reads the whole file, mutates, and writes it all back, so two concurrent callers
 * — e.g. a background token refresh and a TUI save/delete — would each read the same
 * snapshot and the later write would clobber the earlier one's change (resurrecting a
 * just-deleted account, or dropping a freshly-refreshed token). Chaining makes each
 * cycle observe the previous cycle's write. Cross-PROCESS races remain (the
 * single-proxy design assumption); a CLI write while the server runs is reconciled on
 * the next reload.
 */
let _configWriteChain = Promise.resolve();

export function atomicConfigUpdate(updater) {
  const run = async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await saveConfig(config);
    return config;
  };
  // Run after the previous cycle settles (success OR failure) so one failed update
  // can't stall the queue; keep the chain itself non-rejecting and surface the
  // result/error only to this caller.
  const result = _configWriteChain.then(run, run);
  _configWriteChain = result.then(() => {}, () => {});
  return result;
}
