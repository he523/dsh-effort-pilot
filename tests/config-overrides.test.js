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
  const { clean, rejected, ignored } = sanitise({
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
  assert.deepEqual(rejected, [], 'every supplied value was valid');
  assert.deepEqual(ignored.sort(), ['bogus', 'semantic.alsoBogus']);
});

test('sanitise separates an invalid VALUE from an unmanaged KEY', () => {
  // These are different facts and only one is the caller's problem. Conflating
  // them made a SUCCESSFUL save report a wall of "rejected keys" — because the
  // card posts the whole live config, which contains a group it does not own.
  const { clean, rejected, ignored } = sanitise({
    lowMax: 3,
    highMin: 999,          // editable, value out of range -> rejected
    weights: { x: 1 },     // group not managed at all   -> ignored
    semantic: {
      timeoutMs: 1200,     // editable, valid
      provider: 'zhipu',   // nested key not exposed     -> ignored
    },
  });

  assert.deepEqual(clean, { lowMax: 3, semantic: { timeoutMs: 1200 } });
  assert.deepEqual(rejected, ['highMin'], "an invalid value IS the caller's problem");
  assert.deepEqual(
    ignored.sort(),
    ['semantic.provider', 'weights'],
    'an unmanaged key is NOT a rejection',
  );
});

test('sanitise is completely silent for a caller posting only editable keys', () => {
  // The steady state: the card sends exactly what the host says it accepts, so
  // nothing is reported and the user never sees a spurious warning.
  const { rejected, ignored } = sanitise({ lowMax: 3, semantic: { timeoutMs: 1200 } });
  assert.deepEqual(rejected, []);
  assert.deepEqual(ignored, []);
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

test('sanitise ignores a nested group that is not an object', () => {
  // `semantic: 5` is a malformed SHAPE for a group, not a rejected value. It is
  // dropped either way; classifying it as "ignored" keeps `rejected` meaning
  // exactly "you sent a value I manage, and it was invalid".
  const { clean, rejected, ignored } = sanitise({ semantic: 5 });
  assert.deepEqual(clean, {});
  assert.deepEqual(rejected, []);
  assert.deepEqual(ignored, ['semantic']);
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

test('save reports an invalid value and an unknown key differently', async () => {
  await withHome(() => {
    const result = save({ lowMax: 999, wrong: 1 });
    assert.equal(result.ok, true);
    // `lowMax` IS editable, so an out-of-range value is a mistake to surface.
    assert.deepEqual(result.rejected, ['lowMax']);
    // `wrong` was never editable, so it is not an error — reporting it as one is
    // what made every successful save look like it had failed.
    assert.deepEqual(result.ignored, ['wrong']);
    assert.deepEqual(load(), {}, 'neither key may be stored');
  });
});

test('save of only valid editable keys reports nothing at all', async () => {
  await withHome(() => {
    const result = save({ lowMax: 3 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(load(), { lowMax: 3 });
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
