/**
 * Unit tests for the decision journal.
 *
 * The journal exists to make the scheduler observable, so its contract is that
 * it always records and never breaks a request — including when the filesystem
 * refuses.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { journalEnabled, openJournal } from '../lib/journal.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-pilot-journal-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('journalEnabled defaults to on', () => {
  assert.equal(journalEnabled(undefined), true);
  assert.equal(journalEnabled({}), true);
  assert.equal(journalEnabled({ journal: true }), true);
  assert.equal(journalEnabled({ journal: false }), false);
});

test('writes lines in order and creates the directory', async () => {
  await withTempDir(async dir => {
    const path = join(dir, 'nested', 'effort-pilot.log');
    const journal = openJournal(path);
    journal.write('first');
    journal.write('second');
    journal.write('third');
    journal.flush();

    // Writes are synchronous, so the file is readable immediately: a journal
    // that needs an explicit flush is a journal that silently ends up empty.
    const text = await readFile(path, 'utf8');
    assert.equal(text, 'first\nsecond\nthird\n');
  });
});

test('rotation happens before the first append of an oversized log', async () => {
  await withTempDir(async dir => {
    const path = join(dir, 'effort-pilot.log');
    await writeFile(path, 'x'.repeat(1_000_001));

    const journal = openJournal(path);
    journal.write('after rotation');

    const rotated = await readFile(`${path}.1`, 'utf8');
    assert.equal(rotated.length, 1_000_001, 'the oversized file is moved aside');
    const current = await readFile(path, 'utf8');
    assert.equal(current, 'after rotation\n');
  });
});

test('rotation also happens DURING a long-lived run, not only at open', async () => {
  // The bug this pins: the size check lived in `prepare()`, which returns early
  // once the journal is ready — so rotation ran once per process and a long-lived
  // host appended past the cap forever.
  await withTempDir(async dir => {
    const path = join(dir, 'effort-pilot.log');
    const journal = openJournal(path);

    // Start small so the cap is crossed while writing, not at open.
    await writeFile(path, 'seed\n');
    journal.write('first');

    // Push past MAX_BYTES in chunks so the amortised check triggers.
    const chunk = 'y'.repeat(50_000);
    for (let i = 0; i < 25; i += 1) journal.write(chunk);

    const rotated = await readFile(`${path}.1`, 'utf8');
    assert.ok(rotated.startsWith('seed\n'), 'the pre-rotation contents are moved aside');
    const current = await readFile(path, 'utf8');
    assert.ok(current.length < 1_000_000, `the live file must stay under the cap, got ${current.length}`);
  });
});

test('a failing path disables the journal instead of throwing', async () => {
  // A directory in place of the file makes every append fail.
  await withTempDir(async dir => {
    const path = join(dir, 'as-a-directory');
    const { mkdir, stat } = await import('node:fs/promises');
    await mkdir(path);

    const journal = openJournal(path);
    // Must not throw on any call, and must not create anything.
    journal.write('this cannot be written');
    journal.flush();
    journal.write('nor this');
    journal.flush();

    const info = await stat(path);
    assert.equal(info.isDirectory(), true, 'the path is untouched');
    await assert.rejects(() => readFile(`${path}.1`, 'utf8'), 'no rotated file is created on failure');
  });
});
