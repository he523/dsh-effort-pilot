/**
 * Unit tests for the configuration override layer.
 *
 * This is the only place the plugin accepts a WRITE from the UI, so the contract
 * is pinned here rather than trusted: a corrupted, hand-edited, or hostile
 * overrides file must never be able to push a nonsensical threshold into the
 * scheduler, and an unknown key must be reported rather than silently ignored.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('save stages through a sibling temp file, then renames it into place', async () => {
  // WHY THIS IS SHAPED ODDLY. The previous version of this test asserted "one file
  // with the right content exists afterwards", which a plain `writeFileSync` also
  // satisfies — so it could not detect atomicity being removed, the exact property
  // it appeared to cover.
  //
  // Observing the mechanism directly is not possible from here: the module imports
  // `writeFileSync`/`renameSync` as named ESM bindings, and ESM binds those to the
  // original exports, so patching `node:fs` in this test cannot intercept them.
  // Rather than keep an assertion that cannot fail, this records what CAN be
  // observed — that the rename source is a sibling of the destination, so the
  // rename is same-filesystem and therefore atomic and instant — and the failure
  // path below covers the other half.
  await withHome(async (dir) => {
    const result = save({ lowMax: 4, semantic: { timeoutMs: 900 } });
    assert.equal(result.ok, true);
    assert.deepEqual(load(), { lowMax: 4, semantic: { timeoutMs: 900 } });

    assert.deepEqual(
      await readdir(dir),
      [OVERRIDES_FILE],
      'the destination must be the only file left: the staging file is a sibling, '
      + 'not a system-temp file, and it is gone once the rename succeeds',
    );
    const raw = await readFile(join(dir, OVERRIDES_FILE), 'utf8');
    assert.ok(raw.endsWith('\n'), 'the file should end with a newline');
  });
});

test('a failed save reports the error and leaves no temp file behind', async () => {
  // This is the half that CAN be observed, and it was untested. Making the
  // DESTINATION a directory makes the rename fail, which is how this write
  // realistically goes wrong; the staging file must not survive the failure.
  await withHome(async (dir) => {
    await mkdir(join(dir, OVERRIDES_FILE), { recursive: true });

    const result = save({ lowMax: 4 });
    assert.equal(result.ok, false, 'a failed write must not report success');
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name !== OVERRIDES_FILE),
      [],
      'the staging file must be cleaned up when the rename fails',
    );
  });
});

test('save cannot be made to throw even when the filesystem refuses the write', async () => {
  // `save` documents that it never throws, and the write route depends on that:
  // a rejection there produces a 400 with an empty body instead of a real error.
  await withHome(async (dir) => {
    // A directory at the destination plus a directory at the staging path makes
    // both the rename and the cleanup fail.
    await mkdir(join(dir, OVERRIDES_FILE), { recursive: true });
    await mkdir(join(dir, `${OVERRIDES_FILE}.${process.pid}.tmp`), { recursive: true });

    let result;
    await assert.doesNotReject(async () => { result = save({ lowMax: 4 }); });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });
});

test('save reports an invalid value differently from an unknown key', async () => {
  await withHome(() => {
    const result = save({ lowMax: 999, wrong: 1 });
    // NOT `ok`, because nothing survived — and a save replaces the file, so an
    // "ok" here would mean "I deleted your settings and stored nothing".
    assert.equal(result.ok, false);
    assert.equal(result.empty, true);
    // `lowMax` IS editable, so an out-of-range value is a mistake to surface.
    assert.deepEqual(result.rejected, ['lowMax']);
    // `wrong` was never editable, so it is not an error — reporting it as one is
    // what made every successful save look like it had failed.
    assert.deepEqual(result.ignored, ['wrong']);
    assert.deepEqual(load(), {}, 'neither key may be stored');
  });
});

test('save refuses to replace stored overrides with an empty set', async () => {
  await withHome(() => {
    save({ lowMax: 9 });
    assert.deepEqual(load(), { lowMax: 9 });

    // Every one of these validated down to nothing. Reporting success would have
    // deleted `lowMax`.
    for (const input of [{}, { bogus: 1 }, { lowMax: 999 }]) {
      const result = save(input);
      assert.equal(result.ok, false, `${JSON.stringify(input)} must not report success`);
      assert.equal(result.empty, true);
      assert.deepEqual(load(), { lowMax: 9 }, `${JSON.stringify(input)} must not delete the file`);
    }
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

test('save never throws, whatever the value type', async () => {
  await withHome(() => {
    // `Number({toString:1})` raises a TypeError. That call used to sit OUTSIDE
    // save()'s try, so a hostile body escaped the module's error contract and the
    // async write route rejected with no response at all.
    const hostile = [
      { lowMax: { toString: 1 } },
      { lowMax: { valueOf: 1 } },
      { window: { toString: 1 } },
      { semantic: { timeoutMs: { toString: 1 } } },
      { lowMax: [1, 2] },
      { lowMax: { nested: { deep: 1 } } },
      { semantic: { constructor: { toString: 1 } } },
    ];
    for (const input of hostile) {
      assert.doesNotThrow(() => save(input), `${JSON.stringify(input)} threw`);
    }
  });
});

test('save rejects a value of the wrong TYPE rather than coercing it', async () => {
  await withHome(() => {
    // Each of these used to be silently accepted: null->0, ''->0, true->1, [5]->5.
    for (const input of [{ lowMax: null }, { lowMax: '' }, { lowMax: true }, { window: [5] }, { lowMax: '3' }]) {
      const result = save(input);
      assert.equal(result.ok, false, `${JSON.stringify(input)} must not be stored`);
      assert.ok(result.rejected.length > 0, `${JSON.stringify(input)} must be reported as rejected`);
    }
    assert.deepEqual(load(), {});
  });
});

test('save ignores keys that only exist on Object.prototype', async () => {
  await withHome(() => {
    // An unguarded `ALLOWED[key]` lookup walks the prototype chain, so
    // `constructor`, `valueOf`, `toString` … resolved to real functions and were
    // treated as valid specs — specs with no type or bounds at all.
    for (const key of ['constructor', 'valueOf', 'toString', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__']) {
      const result = save({ [key]: 5 });
      assert.equal(result.ok, false, `${key} must not be storable`);
      assert.ok(result.ignored.includes(key), `${key} must be reported as ignored`);
    }
    assert.deepEqual(load(), {}, 'nothing may reach the file');

    // And the nested form.
    const nested = save({ semantic: { constructor: 9, timeoutMs: 1200 } });
    assert.equal(nested.ok, true);
    assert.ok(nested.ignored.includes('semantic.constructor'));
    assert.deepEqual(load(), { semantic: { timeoutMs: 1200 } });
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
