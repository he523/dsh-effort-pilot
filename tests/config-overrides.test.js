/**
 * Unit tests for the configuration override layer.
 *
 * This is the only place the plugin accepts a WRITE from the UI, so the contract
 * is pinned here rather than trusted: a corrupted, hand-edited, or hostile
 * overrides file must never be able to push a nonsensical threshold into the
 * scheduler, and an unknown key must be reported rather than silently ignored.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ALLOWED, OVERRIDES_FILE, clear, load, merge, overridesPath, sanitise, save,
} from '../lib/config-overrides.js';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-pilot-cfg-'));
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

test('overridesPath honours DSH_HOME, read at call time', async () => {
  await withHome(async (dir) => {
    assert.equal(overridesPath(), join(dir, OVERRIDES_FILE));
  });
});

test('load on a missing file is an empty object, not a throw', async () => {
  await withHome(() => {
    assert.deepEqual(load(), {});
  });
});

test('load ignores a corrupt file instead of failing', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, OVERRIDES_FILE), '{ not json', 'utf8');
    assert.deepEqual(load(), {}, 'a corrupt file must degrade to the profile values');
  });
});

test('load re-sanitises a hand-edited file', async () => {
  await withHome(async (dir) => {
    // The file is user-writable, so a nonsense value typed by hand must not reach
    // the scheduler even though it was never submitted through the card.
    await writeFile(
      join(dir, OVERRIDES_FILE),
      JSON.stringify({ lowMax: 9999, mode: 'nonsense', highMin: 5, 'evil.key': 1 }),
      'utf8',
    );
    assert.deepEqual(load(), { highMin: 5 });
  });
});

test('sanitise keeps allowed keys and reports the rest', () => {
  const { clean, rejected } = sanitise({
    lowMax: 3,
    highMin: 7,
    mode: 'local',
    allowUpgrade: false,
    bogus: 1,
    semantic: { timeoutMs: 1200, alsoBogus: 2 },
  });
  assert.deepEqual(clean, {
    lowMax: 3,
    highMin: 7,
    mode: 'local',
    allowUpgrade: false,
    semantic: { timeoutMs: 1200 },
  });
  assert.deepEqual(rejected.sort(), ['bogus', 'semantic.alsoBogus'], 'the nested rejection is qualified by its group');
});

test('sanitise rejects out-of-range, non-integer and wrong-type values', () => {
  const cases = [
    [{ lowMax: -1 }, 'lowMax'],
    [{ lowMax: 999 }, 'lowMax'],
    [{ lowMax: 2.5 }, 'lowMax'],
    [{ lowMax: 'three' }, 'lowMax'],
    [{ mode: 'turbo' }, 'mode'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ window: 0 }, 'window'],
    [{ semantic: { timeoutMs: 10 } }, 'semantic.timeoutMs'],
    [{ semantic: { resampleDecisions: 0 } }, 'semantic.resampleDecisions'],
  ];
  for (const [input, expected] of cases) {
    const { clean, rejected } = sanitise(input);
    assert.deepEqual(clean, {}, `${JSON.stringify(input)} must be rejected`);
    assert.ok(rejected.includes(expected), `expected ${expected} in ${JSON.stringify(rejected)}`);
  }
});

test('sanitise rejects a nested group that is not an object', () => {
  const { clean, rejected } = sanitise({ semantic: 5 });
  assert.deepEqual(clean, {});
  assert.deepEqual(rejected, ['semantic']);
});

test('sanitise survives a non-object input', () => {
  for (const input of [null, undefined, 5, 'x', []]) {
    const { clean } = sanitise(input);
    assert.deepEqual(clean, {}, `input ${JSON.stringify(input)} must yield nothing`);
  }
});

test('save writes atomically and leaves no temp files', async () => {
  await withHome(async (dir) => {
    const result = save({ lowMax: 4, semantic: { timeoutMs: 900 } });
    assert.equal(result.ok, true);
    assert.deepEqual(load(), { lowMax: 4, semantic: { timeoutMs: 900 } });

    const raw = await readFile(join(dir, OVERRIDES_FILE), 'utf8');
    assert.ok(raw.endsWith('\n'), 'the file should end with a newline');
    assert.deepEqual(await readdir(dir), [OVERRIDES_FILE], 'no temp leftovers');
  });
});

test('save reports every rejected key so a UI typo is visible', async () => {
  await withHome(() => {
    const result = save({ lowMax: 3, wrong: 1, worse: 2 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rejected.sort(), ['worse', 'wrong']);
    assert.deepEqual(load(), { lowMax: 3 }, 'only the valid key is stored');
  });
});

test('clear removes the overrides, returning the profile values', async () => {
  await withHome(async (dir) => {
    save({ lowMax: 9 });
    assert.notDeepEqual(load(), {});
    assert.equal(clear().ok, true);
    assert.deepEqual(load(), {});
    assert.deepEqual(await readdir(dir), [], 'the file is gone');
  });
});

test('clear on a missing file is not an error', async () => {
  await withHome(() => {
    assert.equal(clear().ok, true);
  });
});

test('merge overlays one level deep, keeping sibling nested fields', () => {
  const base = {
    lowMax: 2,
    highMin: 6,
    mode: 'hybrid',
    semantic: { timeoutMs: 2500, model: 'glm-4-flash', enabled: true },
    weights: { retryRatio: 6 },
  };
  const merged = merge(base, {
    lowMax: 3,
    semantic: { timeoutMs: 1200 },
  });
  assert.equal(merged.lowMax, 3, 'top level overridden');
  assert.equal(merged.highMin, 6, 'untouched top level kept');
  assert.equal(merged.mode, 'hybrid', 'untouched top level kept');
  assert.equal(merged.semantic.timeoutMs, 1200, 'nested field overridden');
  assert.equal(merged.semantic.model, 'glm-4-flash', 'SIBLING nested field must survive');
  assert.equal(merged.semantic.enabled, true, 'SIBLING nested field must survive');
  assert.equal(merged.weights.retryRatio, 6, 'other group untouched');
});

test('merge does not mutate its inputs', () => {
  const base = { semantic: { a: 1 } };
  const overrides = { semantic: { b: 2 } };
  const merged = merge(base, overrides);
  assert.deepEqual(base, { semantic: { a: 1 } }, 'base must be untouched');
  assert.deepEqual(overrides, { semantic: { b: 2 } }, 'overrides must be untouched');
  assert.deepEqual(merged, { semantic: { a: 1, b: 2 } });
});

test('every allowed key has a usable spec', () => {
  // A spec with a typo would silently reject every value for that key.
  for (const [key, spec] of Object.entries(ALLOWED)) {
    assert.ok(['boolean', 'number', 'enum', 'string'].includes(spec.type), `${key} has type ${spec.type}`);
    if (spec.type === 'enum') assert.ok(Array.isArray(spec.values) && spec.values.length > 0, `${key} needs values`);
  }
});
