import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
    // How long (ms) a request waits for a free slot when every account is at its
    // cap, before returning 429. 0 = never queue.
    overflowQueueTimeoutMs: 15000,
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
 */
export async function atomicConfigUpdate(updater) {
  const config = await loadConfig() || createDefaultConfig();
  await updater(config);
  await saveConfig(config);
  return config;
}
