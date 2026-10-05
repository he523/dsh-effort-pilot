/**
 * Unit tests for the published state that feeds the UI chip.
 *
 * This is the host/page boundary, so its contract is narrow and worth pinning:
 * it writes exactly one file, atomically, and never throws into the request path.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chipEnabled, clear, publish, STATE_FILE, statePath } from '../lib/publish-state.js';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-pilot-state-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('chipEnabled defaults to on and can be turned off', () => {
  assert.equal(chipEnabled(undefined), true);
  assert.equal(chipEnabled({}), true);
  assert.equal(chipEnabled({ chip: true }), true);
  assert.equal(chipEnabled({ chip: false }), false);
});

test('the state file does not live in another plugin\'s namespace', () => {
  // `.dshw-*` belongs to dsh-whale-widget; sharing that prefix would invite a
  // future collision.
  assert.equal(STATE_FILE.startsWith('.dshw-'), false, `${STATE_FILE} must not use the widget's prefix`);
  assert.equal(STATE_FILE, '.dsh-effort-state.json');
});

test('statePath honours DSH_HOME, read at call time', async () => {
  await withHome(async dir => {
    assert.equal(statePath(), join(dir, STATE_FILE));
  });
});

test('publish writes the decision where the chip route reads it', async () => {
  await withHome(async dir => {
    const result = publish({ level: 'high', turn: 7, difficulty: 5.4, localScore: 1.2, semanticScore: 7, reason: 'periodic/fused' });
    assert.equal(result.ok, true);

    const written = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
    assert.equal(written.ok, true);
    assert.equal(written.level, 'high');
    assert.equal(written.turn, 7);
    assert.equal(written.difficulty, 5.4);
    assert.equal(written.semanticScore, 7);
    assert.equal(written.reason, 'periodic/fused');
    assert.ok(Number.isFinite(written.ts) && written.ts > 0, 'the chip compares ts to detect change');
  });
});

test('publish stamps a new ts each time, so the chip sees a change', async () => {
  await withHome(async dir => {
    publish({ level: 'low' });
    const first = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')).ts;
    // Ensure the millisecond clock can advance.
    await new Promise(resolve => setTimeout(resolve, 5));
    publish({ level: 'max' });
    const second = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')).ts;
    assert.ok(second > first, `expected a newer ts, got ${first} then ${second}`);
  });
});

test('publish leaves no temp files behind', async () => {
  await withHome(async dir => {
    publish({ level: 'low' });
    publish({ level: 'high' });
    const entries = await readdir(dir);
    assert.deepEqual(entries, [STATE_FILE], `unexpected leftovers: ${entries.join(', ')}`);
  });
});

test('publish reports failure instead of throwing when the path is unwritable', async () => {
  await withHome(async dir => {
    // A FILE where the directory should be makes every write fail.
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'not a directory');
    process.env.DSH_HOME = blocked;

    let result;
    assert.doesNotThrow(() => {
      result = publish({ level: 'low' });
    });
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string' && result.error.length > 0, 'a reason must be reported');
  });
});

test('clear removes the published state', async () => {
  await withHome(async dir => {
    publish({ level: 'low' });
    await mkdir(dir, { recursive: true });
    assert.equal((await readdir(dir)).includes(STATE_FILE), true);
    assert.equal(clear().ok, true);
    assert.equal((await readdir(dir)).includes(STATE_FILE), false);
  });
});

test('clear on a missing file is not an error', async () => {
  await withHome(async () => {
    assert.equal(clear().ok, true);
  });
});
