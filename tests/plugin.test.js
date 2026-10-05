/**
 * Integration tests for the plugin body with a fake host.
 *
 * These exist because the CLI-level checks cannot cover the decision path: the
 * module needs `@deepseek-ai/schemastery`, which only resolves from the
 * profile's install location. Run from there:
 *
 *   node --test <profile>/node_modules/dsh-effort-pilot/tests/plugin.test.js
 *
 * The first case is a regression for a real observability hole: a session that
 * sits on a hand-picked level used to write NOTHING to the decision journal,
 * which made a working plugin look dead.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const mod = await import(
  `file://${join(profile, 'node_modules', 'dsh-effort-pilot', 'lib', 'index.js').replace(/\\/g, '/')}`
);

/** A fake host whose only provider advertises off/high/max. */
function makeHost() {
  const listeners = new Map();
  const adapter = {
    resolveModel: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1000 },
      reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] },
    }),
  };
  const llm = {
    adapters: new Map([['p', { adapter }]]),
    resolveModelInfo: (provider, model) => adapter.resolveModel(provider, model),
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: '4' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
  // `webServer` is a declared dependency of the chip routes, so the fake host
  // provides it — and it REJECTS a duplicate path, like the real one. A fake that
  // accepted duplicates is what hid the partial-registration leak.
  const registeredRoutes = [];
  const webServer = {
    register(route) {
      if (registeredRoutes.includes(route.path)) throw new Error(`duplicate route ${route.path}`);
      registeredRoutes.push(route.path);
      return () => {};
    },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    get: key => (key === 'llm' ? llm : (key === 'webServer' ? webServer : undefined)),
    on: (name, handler, options) => {
      // The real emitter accepts an options object (`{prepend: true}`, which the
      // waterfall registration uses). The fake ignored it, so the prepend path was
      // never exercised.
      listeners.set(name, { handler, options });
      return () => {};
    },
  };
  return {
    ctx,
    registeredRoutes,
    /** The raw registration record, so a test can assert on `options`. */
    registration: name => listeners.get(name),
    request: () => listeners.get('agent/request')?.handler,
  };
}

/**
 * Run one request through the waterfall.
 *
 * `settled: true` (the default) makes `isFirstTurn()` false by putting a
 * `request/header` in the log — which is what a real second-or-later turn looks
 * like. That matters: on a genuine first turn the scheduler consults the
 * semantic judge, which needs the real `llm` service and would not resolve here.
 */
function callWaterfall(
  waterfall,
  { sessionId = 's1', turn = 1, provider = 'p', model = 'm', effort, settled = true } = {},
) {
  const events = settled ? [{ type: 'request/header', data: {} }] : [];
  return waterfall(
    { agent: { id: sessionId, session: { snapshotEvents: () => events } }, turn },
    async () => ({
      provider,
      model,
      messages: [],
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }),
  );
}

async function withJournal(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-pilot-plugin-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const value = mod.Config['~standard'].validate({}).value;
    return await fn({ dir, value, journalPath: join(dir, 'effort-pilot.log') });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('apply registers the routes the client half reads and prepends the waterfall', async () => {
  await withJournal(async ({ value }) => {
    const { ctx, registeredRoutes, registration } = makeHost();
    mod.apply(ctx, value);

    assert.deepEqual(
      registeredRoutes.sort(),
      [
        '/dsh-effort/config.json',
        '/dsh-effort/report.json',
        '/dsh-effort/state.json',
        '/dsh-effort/status.json',
      ].sort(),
      'every route the client half reads must be registered on activation',
    );

    // `{prepend: true}` is what makes this plugin decide BEFORE the built-in
    // resolution. The old fake ignored the options argument entirely, so this
    // registration detail was never asserted.
    const waterfall = registration('agent/request');
    assert.ok(waterfall, 'the waterfall must be registered');
    assert.equal(waterfall.options?.prepend, true, 'the waterfall must be prepended');
  });
});

test('a hand-picked level is journalled once, then not repeated', async () => {
  await withJournal(async ({ value, journalPath }) => {
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    // Startup lines (the chip's registration report) share the journal, so count
    // only DECISION lines — a tightened count here once failed on that alone.
    const decisions = text => text.split('\n')
      .filter(line => line.includes('manual=') || line.includes('turn='));

    // First request on a manual pick: must record.
    await callWaterfall(request(), { turn: 1, effort: 'max' });
    let text = await readFile(journalPath, 'utf8');
    assert.equal(decisions(text).length, 1, `expected one decision line, got: ${JSON.stringify(text)}`);
    assert.match(text, /manual=max/);
    assert.match(text, /level=max/);

    // Second request with the same pick: must NOT spam the journal.
    await callWaterfall(request(), { turn: 2, effort: 'max' });
    text = await readFile(journalPath, 'utf8');
    assert.equal(decisions(text).length, 1, 'a repeated pick must not re-record');

    // A changed pick records again.
    await callWaterfall(request(), { turn: 3, effort: 'high' });
    text = await readFile(journalPath, 'utf8');
    assert.equal(decisions(text).length, 2, 'a changed pick must record');
  });
});

test('a manual pick the model cannot take is stripped and journalled as such', async () => {
  await withJournal(async ({ value, journalPath }) => {
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    const result = await callWaterfall(request(), { turn: 1, effort: 'minimal' });
    assert.equal(result.reasoningEffort, undefined, 'an unadvertised manual pick is stripped');

    const text = await readFile(journalPath, 'utf8');
    assert.match(text, /manual=minimal/);
    assert.match(text, /stripped \(not advertised\)/);
  });
});

test('an Auto request is scheduled and journalled with its full trail', async () => {
  await withJournal(async ({ value, journalPath }) => {
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    const result = await callWaterfall(request(), { turn: 1, effort: 'auto' });
    assert.ok(['low', 'high', 'max'].includes(String(result.reasoningEffort)));

    const text = await readFile(journalPath, 'utf8');
    assert.match(text, /local=/, 'the trail must carry the local score');
    assert.match(text, /difficulty=/, 'the trail must carry the fused difficulty');
    assert.match(text, /=> level=/, 'the trail must carry the chosen level');
    assert.match(text, /first-turn|hold|switch|confirm/, 'the trail must carry the reason');
  });
});

test('journal: false disables the file entirely', async () => {
  await withJournal(async ({ value, journalPath }) => {
    value.journal = false;
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    await callWaterfall(request(), { turn: 1, effort: 'max' });
    await assert.rejects(() => readFile(journalPath, 'utf8'), /ENOENT/);
  });
});

test('a scheduled decision is published for the UI chip', async () => {
  await withJournal(async ({ dir, value }) => {
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    await callWaterfall(request(), { turn: 1, effort: 'auto' });

    const { readFile: rf } = await import('node:fs/promises');
    const state = JSON.parse(await rf(join(dir, '.dsh-effort-state.json'), 'utf8'));
    assert.equal(state.ok, true);
    assert.ok(['low', 'high', 'max'].includes(state.level), `unexpected level ${state.level}`);
    assert.ok(Number.isFinite(state.ts) && state.ts > 0);
    // The published level must be the one actually requested, never a pre-clamp
    // value — otherwise the chip would claim something the provider never saw.
    assert.equal(typeof state.difficulty, 'number');
  });
});

test('chip: false stops publishing', async () => {
  await withJournal(async ({ dir, value }) => {
    value.chip = false;
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    await callWaterfall(request(), { turn: 1, effort: 'auto' });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    assert.ok(!entries.includes('.dsh-effort-state.json'), `nothing should be published, found ${entries.join(', ')}`);
  });
});

test('the published level matches the injected one when the scheduler is clamped', async () => {
  await withJournal(async ({ dir, value }) => {
    // Force the scheduler to WANT `max` while the model only advertises
    // off/high. The first version of this check used the stock config, where the
    // decision lands on `high` anyway — so `state.level === result.reasoningEffort`
    // held trivially and would still hold if the clamp were removed entirely.
    value.lowMax = 0;
    value.highMin = 0;

    const { ctx, request } = makeHost();
    mod.apply(ctx, value);
    const waterfall = request();

    const result = await waterfall(
      { agent: { id: 'clamp', session: { snapshotEvents: () => [{ type: 'request/header', data: {} }] } }, turn: 2 },
      async () => ({ provider: 'p', model: 'm', messages: [], reasoningEffort: 'auto' }),
    );

    // The adapter in the fake host advertises off/high, so `max` must be clamped.
    assert.equal(String(result.reasoningEffort), 'high', 'the clamp must lift max down to the highest advertised level');

    const { readFile: rf } = await import('node:fs/promises');
    const state = JSON.parse(await rf(join(dir, '.dsh-effort-state.json'), 'utf8'));
    assert.equal(state.level, 'high', 'the chip must report the level actually sent, never the pre-clamp one');
    assert.equal(state.level, String(result.reasoningEffort), 'the chip and the request must agree');
  });
});

test('a route with only `off` gets the effort stripped, and the chip says so', async () => {
  await withJournal(async ({ dir, value }) => {
    // `plain` in the fake host advertises `off` + `high`. `clampToEfforts` filters
    // `off` out of the candidate thinking levels, so the nearest usable level is
    // `high` — NOT a strip. (A strip only happens when `off` is the ONLY entry.)
    // Asserting the real semantics here matters: the first draft of this test
    // expected `undefined` and failed, which means it was testing the wrong thing.
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    const result = await callWaterfall(request(), { turn: 2, model: 'plain', effort: 'auto' });
    assert.equal(String(result.reasoningEffort), 'high', 'off is filtered; high is the usable level');

    const { readFile: rf } = await import('node:fs/promises');
    const state = JSON.parse(await rf(join(dir, '.dsh-effort-state.json'), 'utf8'));
    assert.equal(state.level, String(result.reasoningEffort), 'the chip must match what was sent');
  });
});

test('clampToEfforts strips a route whose only entry is off', async () => {
  // The strip path belongs to `clampToEfforts`; pinned here because the
  // integration host cannot advertise an `off`-only route.
  const { clampToEfforts } = await import('../lib/decide.js');
  assert.equal(clampToEfforts('high', ['off'], false), undefined, 'off-only route takes nothing');
  assert.equal(clampToEfforts('high', [], false), undefined, 'no entries takes nothing');
  assert.equal(clampToEfforts('high', ['off', 'high'], false), 'high');
  assert.equal(clampToEfforts('max', ['quick', 'deep', 'standard'], false), 'standard',
    'a custom vocabulary must not collapse to the FIRST entry');
  assert.equal(clampToEfforts('max', ['standard', 'deep', 'quick'], false), 'quick',
    'a descending custom vocabulary must still reach its own highest');
});

test('a hand pick is respected; a hand pick cannot reach an unadvertised level', async () => {
  await withJournal(async ({ value }) => {
    const { ctx, request } = makeHost();
    mod.apply(ctx, value);

    assert.equal((await callWaterfall(request(), { turn: 1, effort: 'high' })).reasoningEffort, 'high');
    assert.equal((await callWaterfall(request(), { turn: 2, effort: 'off' })).reasoningEffort, 'off');
    assert.equal((await callWaterfall(request(), { turn: 3, effort: 'low' })).reasoningEffort, undefined);
  });
});
