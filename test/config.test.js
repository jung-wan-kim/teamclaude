import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicConfigUpdate } from '../src/config.js';

// node --test runs each test file in its own process, so setting TEAMCLAUDE_CONFIG
// (and the module-level write chain) here doesn't leak into other test files.

test('atomicConfigUpdate serializes concurrent writers (no lost update / no resurrection)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = cfgPath;
  try {
    await writeFile(cfgPath, JSON.stringify({
      proxy: { port: 1 },
      accounts: [
        { name: 'A', type: 'apikey', apiKey: 'a' },
        { name: 'B', type: 'apikey', apiKey: 'b' },
      ],
    }, null, 2) + '\n', { mode: 0o600 });

    // Two concurrent read-modify-write cycles: one DELETES A (like a TUI delete),
    // the other UPDATES B's token (like a background token refresh). Each reads the
    // whole file and writes it all back — without serialization the later write
    // clobbers the earlier (either resurrecting A or losing B's update).
    await Promise.all([
      atomicConfigUpdate(c => { c.accounts = c.accounts.filter(a => a.name !== 'A'); }),
      atomicConfigUpdate(c => { const b = c.accounts.find(a => a.name === 'B'); if (b) b.apiKey = 'b-new'; }),
    ]);

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(a => a.name), ['B'], 'A stays deleted (not resurrected)');
    assert.equal(final.accounts[0].apiKey, 'b-new', "B's concurrent update is not lost");
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
