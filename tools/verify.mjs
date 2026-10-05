/**
 * Full verification against the copy the host will actually load.
 *
 * Resolves the plugin through the profile so that `@deepseek-ai/schemastery`
 * resolves the same way it will at runtime, then exercises the loader contract
 * and the request waterfall with a fake host.
 *
 * Usage:
 *   node <profile>/node_modules/dsh-effort-pilot/tools/sync.mjs   # then
 *   node <profile>/node_modules/dsh-effort-pilot/tools/verify.mjs
 *
 * Exit code 0 means the plugin should activate; anything else is a defect to
 * fix before restarting the app.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ISOLATION: this script calls `apply()` with a fake host, and `apply()` opens
// the decision journal. Without redirecting DSH_HOME the fake requests would be
// written into the user's real journal and pollute it with `model=p/plain` test
// rows — which is exactly what happened the first time.
const isolationDir = await mkdtemp(join(tmpdir(), 'effort-pilot-verify-'));
const realHome = process.env.DSH_HOME;
process.env.DSH_HOME = isolationDir;
process.on('exit', () => {
  if (realHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realHome;
});

const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const pluginDir = join(profile, 'node_modules', 'dsh-effort-pilot');
/** The source tree this script ships in — used for the orphan comparison. */
const here = dirname(fileURLToPath(import.meta.url));

const mod = await import(new URL(`file://${join(pluginDir, 'lib', 'index.js').replace(/\\/g, '/')}`).href);

const failures = [];
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}: ${error.message}`);
  }
};

console.log('bundle manifest');
// The loader inserts this plugin's row by reading `dsh.bundle.patch` from
// package.json. Without that field the bundle contributes NOTHING and the
// plugin is silently absent from the tree, with no error anywhere — which is
// exactly how the first install failed. Checked against the installed manifest.
const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
await check('package.json declares dsh.bundle.patch', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
});
await check('the declared patch inserts a named row', async () => {
  const patch = await readFile(join(pluginDir, manifest.dsh.bundle.patch), 'utf8');
  assert.match(patch, /insert:/, 'the patch must insert a loader row');
  assert.match(patch, /name:\s*dsh-effort-pilot/, 'the inserted row must name this package');
  assert.match(patch, /id:\s*effort-pilot/, 'the inserted row must carry a patch id');
});

console.log('client half (slot contract)');
// The client half is resolved through `dsh.client` + `exports["./client"]`. A
// missing or misnamed entry means the chip simply never renders, with no error —
// the same silent-failure shape as a missing `dsh.bundle.patch`.
await check('package.json declares the client half for the web platform', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'client.inject must be an array (empty is fine)');
});
await check('the client bundle is exported and present', async () => {
  const target = manifest.exports?.['./client']?.default;
  assert.equal(target, './lib/client.js', `exports["./client"] is ${JSON.stringify(target)}`);
  const source = await readFile(join(pluginDir, target), 'utf8');
  // The lazy-CJS wrapper the web app's module loader expects.
  assert.match(source, /__ModuleLoader__\.load\(/, 'must use the module-loader contract');
  assert.match(source, /\bid:\s*["']dsh-effort-pilot["']/, 'the module id must match the package');
  assert.match(source, /factory:/, 'the loader entry needs a factory');
  // It must register into the composer seat and read the host's own feed.
  assert.match(source, /conversation\.input\.right/, 'must target the composer tool-row slot');
  assert.match(source, /\/dsh-effort\/state\.json/, 'must read the host-published state');
});

await check('the client bundle applies cleanly against a fake loader', async () => {
  // Execute the real file with a stubbed module loader and react, so a syntax or
  // contract mistake in the client half is caught here rather than in the browser.
  const { readFile: rf } = await import('node:fs/promises');
  const source = await rf(join(pluginDir, './lib/client.js'), 'utf8');

  let loaded;
  /**
   * The settings-route payload the fake host serves.
   *
   * `effective` deliberately includes a group (`weights`) that the card does NOT
   * manage, because that is what the real route returns. The card used to POST the
   * whole thing, so the host reported all six weights keys as "rejected" on every
   * successful save. That regression is what the assertions below now catch.
   */
  const CONFIG_FIXTURE = {
    effective: {
      enabled: true, mode: 'hybrid', lowMax: 3, highMin: 6, window: 8,
      allowDowngrade: true, allowUpgrade: true, respectManual: true,
      advertiseAuto: true, journal: true, chip: true,
      confirmRounds: 2, minDwellTurns: 1,
      weights: { retryRatio: 6, errorRatio: 5, rereadRatio: 2, payloadTrend: 3, toolDiversity: 1, contextPressure: 4 },
      semantic: {
        enabled: true, provider: 'zhipu', model: 'glm-4-flash', timeoutMs: 2500,
        resampleDecisions: 12, maxCallsPerSession: 100,
      },
    },
    // Realistic spec shapes, not `{}`: the card iterates these objects, and an
    // empty object would keep passing even if the host started publishing
    // something the card cannot read.
    editable: {
      enabled: { type: 'boolean' },
      mode: { type: 'enum', values: ['local', 'hybrid'] },
      lowMax: { type: 'number', min: 0, max: 10, integer: true },
      highMin: { type: 'number', min: 0, max: 10, integer: true },
      allowDowngrade: { type: 'boolean' },
      allowUpgrade: { type: 'boolean' },
      respectManual: { type: 'boolean' },
      advertiseAuto: { type: 'boolean' },
      chip: { type: 'boolean' },
      journal: { type: 'boolean' },
      window: { type: 'number', min: 1, max: 64, integer: true },
      confirmRounds: { type: 'number', min: 1, max: 32, integer: true },
      minDwellTurns: { type: 'number', min: 0, max: 100, integer: true },
    },
    editableNested: {
      semantic: {
        enabled: { type: 'boolean' },
        model: { type: 'string', maxLength: 64 },
        resampleDecisions: { type: 'number', min: 1, max: 1000, integer: true },
        timeoutMs: { type: 'number', min: 250, max: 30000, integer: true },
        maxCallsPerSession: { type: 'number', min: 0, max: 100000, integer: true },
        ambiguousLow: { type: 'number', min: 0, max: 10, integer: true },
        ambiguousHigh: { type: 'number', min: 0, max: 10, integer: true },
      },
    },
  };
  // A minimal but FAITHFUL react: it keeps state across re-renders, so a
  // component that only becomes renderable after new state arrives (the settings
  // card, which starts "loading" and then shows the form) actually gets there.
  // The earlier stub returned `initial` and never updated, which meant the card's
  // loaded branch — and the payload its save button builds — was never exercised.
  // Hooks are stored PER COMPONENT. A single shared array looks like it works
  // until two components render, at which point each consumes the other's slots —
  // which is exactly what happened here, and it is not a mistake real React can
  // make. Keeping a map keyed by the component being rendered mirrors real React
  // closely enough that a broken component actually fails.
  const hookStore = new Map();
  const effectStore = new Map();
  let currentComponent = null;
  let hookCursor = 0;

  const renderComponent = (component) => {
    currentComponent = component;
    hookCursor = 0;
    return component();
  };

  const depsChanged = (previous, next) => {
    if (previous === undefined) return true;
    if (!previous || !next || previous.length !== next.length) return true;
    for (let i = 0; i < previous.length; i += 1) {
      if (!Object.is(previous[i], next[i])) return true;
    }
    return false;
  };

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const store = hookStore.get(currentComponent) || [];
      hookStore.set(currentComponent, store);
      const slot = hookCursor;
      hookCursor += 1;
      if (store[slot] === undefined) store[slot] = initial;
      const set = (next) => {
        store[slot] = typeof next === 'function' ? next(store[slot]) : next;
        if (currentComponent) renderComponent(currentComponent);
      };
      return [store[slot], set];
    },
    /**
     * Honour the DEPENDENCY ARRAY.
     *
     * Running every effect on every render is not "close enough": the config fetch
     * sets state, the render runs the effect again, the fetch fires again — an
     * infinite loop that exhausted the heap instead of reporting a failure. A stub
     * must reproduce the semantics the component relies on, or it manufactures
     * bugs the real runtime cannot have.
     */
    useEffect: (fn, deps) => {
      const store = effectStore.get(currentComponent) || [];
      effectStore.set(currentComponent, store);
      const slot = hookCursor;
      hookCursor += 1;
      const previous = store[slot];
      if (!depsChanged(previous, deps)) return;
      store[slot] = deps ? [...deps] : undefined;
      try { fn(); } catch { /* the components guard themselves */ }
    },
  };
  const fetched = [];
  /** Bodies of any POST to the settings route. */
  const posted = [];
  // Stub the timers: the component starts a real interval, which would keep this
  // process alive forever. The first poll still runs, which is what is asserted.
  const stoppedIntervals = [];
  /** The most recent render output. */
  let host = null;
  /** Answer each route with a realistic payload. */
  const respondTo = (url) => {
    if (String(url).startsWith('/dsh-effort/config.json')) {
      return {
        ok: true,
        effective: CONFIG_FIXTURE.effective,
        declared: {},
        overrides: {},
        editable: CONFIG_FIXTURE.editable,
        editableNested: CONFIG_FIXTURE.editableNested,
        observations: {},
      };
    }
    return { ok: false };
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry; } } },
    require: (name) => {
      if (name === 'react') return fakeReact;
      throw new Error(`unexpected require: ${name}`);
    },
    fetch: (url, options) => {
      fetched.push(String(url));
      if (options && String(options.method).toUpperCase() === 'POST') {
        posted.push({ url: String(url), body: JSON.parse(String(options.body)) });
      }
      // Resolve SYNCHRONOUSLY-ish, then re-render: the card only builds its form
      // once the config payload has arrived.
      const payload = respondTo(url);
      return Promise.resolve({ json: () => Promise.resolve(payload) }).then((r) => {
        // Re-render the component that is currently mounted, so its state change
        // takes effect — the card only builds its form once the payload arrives.
        setTimeout(() => {
          if (currentComponent) host = renderComponent(currentComponent);
        }, 0);
        return r;
      });
    },
    setInterval: () => 1,
    clearInterval: (id) => { stoppedIntervals.push(id); },
    Date,
  };

  // The bundle is a plain script, not a module: evaluate it with the sandboxed
  // globals in scope.
  const run = new Function(
    'window', 'require', 'fetch', 'setInterval', 'clearInterval', 'Date',
    source,
  );
  run(
    sandbox.window, sandbox.require, sandbox.fetch,
    sandbox.setInterval, sandbox.clearInterval, sandbox.Date,
  );

  assert.ok(loaded, 'the loader entry must be registered');
  assert.equal(loaded.id, 'dsh-effort-pilot');
  const mod = loaded.factory(sandbox.require);
  assert.equal(mod.name, 'dsh-effort-pilot');
  assert.equal(typeof mod.apply, 'function');

  // The client half registers TWO surfaces, and each is wrapped in its own
  // try/catch so a host missing one seat still gets the other. That robustness
  // also means a throwing FAKE would be silently swallowed and the surface would
  // simply not appear — which is exactly how a "one slot entry" assertion kept
  // passing after the settings card was added. So the fake records the asked-for
  // slot and dispatches; it must accept both names, and the assertions below
  // require both to have registered.
  const registrations = [];
  const askedSlots = [];
  const ctx = {
    inject(services, cb) {
      assert.ok(services.includes('slots'), 'the client half needs the core slots service');
      cb({
        slots: {
          inject(slot, fn) {
            askedSlots.push(slot);
            return fn();
          },
          register(config, component) {
            registrations.push({ config, component });
            return () => {};
          },
        },
      });
    },
  };
  assert.doesNotThrow(() => mod.apply(ctx));

  const byName = (name) => registrations.filter((r) => r.config.name === name);
  assert.deepEqual(
    askedSlots.sort(),
    ['conversation.input.right', 'settings.section'],
    `the client half must ask for both seats, asked: ${askedSlots.join(', ')}`,
  );
  assert.equal(registrations.length, 2, `expected two slot entries, got ${registrations.length}`);

  const chip = byName('conversation.input.right')[0];
  assert.ok(chip, 'the composer chip must register');
  assert.equal(typeof chip.component, 'function', 'the chip entry must be a component');
  assert.equal(chip.config.id, 'effort-pilot-level');

  const card = byName('settings.section')[0];
  assert.ok(card, 'the settings card must register');
  assert.equal(typeof card.component, 'function', 'the settings entry must be a component');
  assert.equal(card.config.id, 'effort-pilot');
  assert.equal(typeof card.config.label, 'function', 'a settings section needs a label');
  assert.equal(typeof card.config.label(), 'string');

  // Rendering the chip must poll the state route AND announce the mount, because
  // the beacon is the host's only evidence that the client half is alive — a
  // route nobody calls would be dead code that only looks like observability.
  assert.doesNotThrow(() => renderComponent(chip.component));
  assert.ok(
    fetched.some((u) => u.startsWith('/dsh-effort/state.json')),
    `the chip must poll the published state, fetched: ${fetched.join(', ') || '(nothing)'}`,
  );
  assert.ok(
    fetched.some((u) => u.startsWith('/dsh-effort/report.json')),
    `the chip must announce its mount, fetched: ${fetched.join(', ') || '(nothing)'}`,
  );

  // And the card must read the settings route, or it would render nothing while
  // looking like a working panel.
  assert.doesNotThrow(() => renderComponent(card.component));
  assert.ok(
    fetched.some((u) => u.startsWith('/dsh-effort/config.json')),
    `the card must read the settings route, fetched: ${fetched.join(', ') || '(nothing)'}`,
  );

  // Let the card's fetch resolve, which flips it from "loading" to the form.
  await new Promise((resolve) => setTimeout(resolve, 5));
  host = renderComponent(card.component);
  assert.ok(host, 'the card must render once its config has arrived');

  /**
   * Find the first element whose props carry an `onClick`.
   *
   * The card's save button is the first interactive control it renders, and the
   * point is to drive the REAL click handler rather than to re-implement the
   * payload logic here.
   */
  const findButton = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props && typeof node.props.onClick === 'function') return node;
    for (const child of node.children || []) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  };

  const saveButton = findButton(host);
  assert.ok(saveButton, 'the card must render a clickable control');
  assert.doesNotThrow(() => saveButton.props.onClick());
  await new Promise((resolve) => setTimeout(resolve, 5));

  const save = posted.filter((p) => p.url.startsWith('/dsh-effort/config.json')).pop();
  assert.ok(save, `clicking save must POST the settings route, posted: ${JSON.stringify(posted)}`);
  const values = save.body.values || {};
  assert.equal(values.lowMax, CONFIG_FIXTURE.effective.lowMax, 'the live value must be sent');
  assert.equal(
    values.weights,
    undefined,
    'the payload must NOT include groups the host does not manage: posting them made every '
    + 'successful save report a list of rejected keys',
  );
  assert.equal(values.semantic.provider, undefined, 'nor unexposed nested keys');
  assert.ok(values.semantic.timeoutMs, 'but exposed nested keys must be sent');
});

console.log('loader contract');
check('exports apply', () => assert.equal(typeof mod.apply, 'function'));
check('exports inject including llm', () => assert.ok(mod.inject.includes('llm')));
check('declares webServer as a dependency, not an optional lookup', () => {
  // Looking webServer up optionally is how the chip routes went missing without
  // a single error: `ctx.get('webServer')` returned undefined and the routes
  // were never registered.
  assert.ok(mod.inject.includes('webServer'), `inject is ${JSON.stringify(mod.inject)}`);
});
check('exports name', () => assert.equal(mod.name, 'dsh-effort-pilot'));
check('exports Config', () => assert.ok(mod.Config?.['~standard']));

const validated = mod.Config['~standard'].validate({});
check('empty config validates (every field has a default)', () => {
  assert.equal(validated.issues, undefined, JSON.stringify(validated.issues));
});

const value = validated.value;
const read = field => (value[field]?.get ? value[field].get() : value[field]);

console.log('defaults');
const defaults = {
  enabled: read('enabled'),
  mode: read('mode'),
  lowMax: read('lowMax'),
  highMin: read('highMin'),
  confirmRounds: read('confirmRounds'),
  minDwellTurns: read('minDwellTurns'),
  allowDowngrade: read('allowDowngrade'),
  allowUpgrade: read('allowUpgrade'),
  respectManual: read('respectManual'),
};
console.log(' ', JSON.stringify(defaults));

check('decision: allowUpgrade default true (max is reachable)', () => assert.equal(defaults.allowUpgrade, true));
check('decision: mode default hybrid (semantic enabled)', () => assert.equal(defaults.mode, 'hybrid'));
check('decision: allowDowngrade default true', () => assert.equal(defaults.allowDowngrade, true));
check('journal is on by default (the plugin is otherwise unobservable)', () => {
  assert.equal(read('journal'), true);
});
check('chip publishing is on by default', () => {
  assert.equal(read('chip'), true);
});
check('volatile fields are live refs', () => assert.equal(typeof value.enabled.get, 'function'));

const semantic = value.semantic?.get ? value.semantic.get() : value.semantic;
const readSemantic = field => (semantic?.[field]?.get ? semantic[field].get() : semantic?.[field]);
console.log(' semantic:', JSON.stringify({
  enabled: readSemantic('enabled'),
  provider: readSemantic('provider'),
  model: readSemantic('model'),
  timeoutMs: readSemantic('timeoutMs'),
  maxCallsPerSession: readSemantic('maxCallsPerSession'),
}));
check('semantic route is configured', () => {
  assert.equal(readSemantic('provider'), 'zhipu');
  // A reasoning model here would burn its whole budget inside
  // `reasoning_content` and return an empty answer, so the default must stay a
  // non-reasoning model (see tools/probe-route.mjs for the measurement).
  assert.equal(readSemantic('model'), 'glm-4-flash');
});

console.log('activation');
const listeners = new Map();
/** A fake adapter whose reasoning metadata depends on the model id. */
const adapter = {
  resolveModel: async (provider, model) => {
    if (model === 'plain') {
      // Mirrors what the host hands back for a route that declares no
      // reasoning: the field is absent entirely, not an empty list.
      return { provider, id: model, name: model, context: { contextWindow: 128000 } };
    }
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
    };
  },
};
const adapters = new Map([['p', { adapter }]]);

let streamCalls = 0;
/** Minimal llm service surface: capability lookup plus a streaming call. */
const llm = {
  adapters,
  resolveModelInfo: (provider, model, signal) => adapter.resolveModel(provider, model, signal),
  stream: () => {
    streamCalls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};

const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  // Mirrors the real host: `webServer` is read as an OPTIONAL service, so it is
  // looked up by key rather than assumed present.
  get: key => (key === 'llm' ? llm : (key === 'webServer' ? ctx.webServer : undefined)),
  on: (name, handler) => {
    listeners.set(name, handler);
    return () => {};
  },
};

await check('apply() does not throw', () => mod.apply(ctx, value));
await check('registers agent/request', () => assert.ok(listeners.has('agent/request')));
await check('registers llm/adapters-updated', () => assert.ok(listeners.has('llm/adapters-updated')));

console.log('Auto mask advertisement');
await check('adapter.resolveModel is wrapped', () => assert.equal(adapter.resolveModel.__effortPilot, true));
const info = await adapter.resolveModel('p', 'm');
await check('Auto is appended to efforts', () => {
  const ids = info.reasoning.efforts.map(e => String(e.id));
  assert.ok(ids.includes('auto'), JSON.stringify(ids));
  assert.ok(ids.includes('high'), 'native levels must be preserved');
});
await check('a model without reasoning metadata is untouched', async () => {
  const bareInfo = await adapter.resolveModel('p', 'plain');
  assert.equal(bareInfo.reasoning, undefined);
});

console.log('request waterfall');
const waterfall = listeners.get('agent/request');

// A model advertising no reasoning metadata must never receive an effort.
const stripped = await waterfall(
  { agent: { id: 's1', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => ({ provider: 'p', model: 'plain', messages: [], reasoningEffort: 'high' }),
);
await check('reasoning-less route is stripped', () => assert.equal(stripped.reasoningEffort, undefined));

// A manual pick on a route that advertises no reasoning must be stripped, not
// forwarded: the provider would reject the whole request.
const manualNoReasoning = await waterfall(
  { agent: { id: 's2', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => ({ provider: 'p', model: 'plain', messages: [], reasoningEffort: 'high' }),
);
await check('manual pick on a reasoning-less route is stripped', () => {
  assert.equal(manualNoReasoning.reasoningEffort, undefined);
});

// A manual pick the model DOES advertise must pass through untouched.
const manual = await waterfall(
  { agent: { id: 's2b', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => ({ provider: 'p', model: 'm', messages: [], reasoningEffort: 'off' }),
);
await check('manual selection is passed through', () => assert.equal(manual.reasoningEffort, 'off'));

// A manual pick the model does NOT advertise is stripped rather than swapped:
// the user asked for that exact level, so silently substituting another would
// misreport what happened.
const manualUnsupported = await waterfall(
  { agent: { id: 's2c', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => ({ provider: 'p', model: 'm', messages: [], reasoningEffort: 'max' }),
);
await check('unsupported manual pick is stripped, not clamped', () => {
  assert.equal(manualUnsupported.reasoningEffort, undefined);
});

// The first turn on a capable model must never be downgraded to low.
const first = await waterfall(
  { agent: { id: 's3', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => ({ provider: 'p', model: 'm', messages: [], reasoningEffort: 'auto' }),
);
console.log('  first-turn injection:', String(first.reasoningEffort));
await check('first turn is not downgraded to low', () => assert.notEqual(first.reasoningEffort, 'low'));
await check('first turn injects an advertised level', () => {
  assert.ok(['off', 'high', 'auto'].includes(String(first.reasoningEffort)), String(first.reasoningEffort));
});

// L2 REACHABILITY. Every session above omits `deriveMessages`, so the prompt is
// underivable and the judge is skipped — which meant a permanently dead semantic
// layer passed the whole suite. This session provides it and asserts the stream
// was actually called.
const streamsBefore = streamCalls;
await waterfall(
  {
    agent: {
      id: 's-l2',
      session: {
        snapshotEvents: () => [],
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'a real prompt' }] }],
      },
    },
    turn: 1,
  },
  async () => ({ provider: 'p', model: 'm', messages: [], reasoningEffort: 'auto' }),
);
await check('the semantic judge is actually consulted when a prompt exists', () => {
  assert.ok(
    streamCalls > streamsBefore,
    `expected a judge call, streamCalls stayed at ${streamsBefore}`,
  );
});

// The waterfall must always call next(), or it vetoes the host's own config.
let calledNext = false;
await waterfall(
  { agent: { id: 's4', session: { snapshotEvents: () => [] } }, turn: 1 },
  async () => {
    calledNext = true;
    return { provider: 'p', model: 'm', messages: [] };
  },
);
await check('next() is always awaited', () => assert.equal(calledNext, true));

console.log('file encoding');
await check('no shipped file starts with a UTF-8 BOM', async () => {
  // A BOM is invisible in every editor and in `git diff`, and it silently breaks
  // `JSON.parse` — `package.json` stopped loading the moment one crept in from a
  // PowerShell `Set-Content -Encoding UTF8`. Nothing else in this suite notices,
  // because the file still looks correct and still "has the right content".
  const { readdir: rd, readFile: rf } = await import('node:fs/promises');
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await rd(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(js|mjs|cjs|json|yml|yaml|md)$/.test(entry.name)) continue;
      const head = (await rf(full)).subarray(0, 3);
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        offenders.push(full.slice(pluginDir.length + 1));
      }
    }
  };
  await walk(pluginDir);
  assert.deepEqual(offenders, [], `these files start with a BOM: ${offenders.join(', ')}`);
});

console.log('journal');
await check('the fake host journaled into the isolated directory, not the real one', async () => {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(isolationDir).catch(() => []);
  assert.ok(
    entries.includes('effort-pilot.log'),
    `expected a journal in the isolation dir, found: ${entries.join(', ') || '(empty)'}`,
  );
  const text = await readFile(join(isolationDir, 'effort-pilot.log'), 'utf8');
  assert.match(text, /\[effort-pilot\]/, 'the journal must hold the decision trail');
});

console.log('UI chip (host/page contract)');
// The page reads this shape, so the publisher's output is asserted here rather
// than trusted: a rename or a missing field would be silent at runtime — the
// chip would simply never appear.
await check('the plugin publishes the state the chip route reads', async () => {
  const { readFile: rf, readdir: rd } = await import('node:fs/promises');
  const entries = await rd(isolationDir).catch(() => []);
  assert.ok(
    entries.includes('.dsh-effort-state.json'),
    `expected the published state, found: ${entries.join(', ') || '(empty)'}`,
  );
  const state = JSON.parse(await rf(join(isolationDir, '.dsh-effort-state.json'), 'utf8'));
  assert.equal(state.ok, true);
  assert.ok(typeof state.level === 'string' && state.level.length > 0, 'a level must be published');
  assert.ok(Number.isFinite(state.ts) && state.ts > 0, 'a ts is required so the page can detect change');
});

await check('the chip routes are registered by apply()', async () => {
  const registered = [];
  const routes = [];
  ctx.webServer = {
    register(route) {
      registered.push(route.path);
      routes.push(route);
      return () => {};
    },
  };
  mod.apply(ctx, value);
  for (const expected of [
    '/dsh-effort/state.json',
    '/dsh-effort/config.json',
    '/dsh-effort/report.json',
    '/dsh-effort/status.json',
  ]) {
    assert.ok(registered.includes(expected), `missing ${expected} in ${registered.join(', ')}`);
  }
  // Every route must answer a LOOPBACK caller with 200 and a body, not merely
  // avoid throwing. Without `req.socket` the guard sees a non-loopback peer and
  // returns 403 — so the earlier version of this loop exercised only the refusal
  // path and never the body.
  //
  // AWAITED, because the settings route's handler is async: asserting
  // synchronously would read an empty response and pass for the wrong reason.
  for (const route of routes) {
    const res = {
      status: 0,
      body: undefined,
      writeHead(status) { res.status = status; },
      end(body) { res.body = body; },
    };
    await assert.doesNotReject(
      async () => route.handler({ url: '/', method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res),
      `${route.path} handler rejected`,
    );
    assert.equal(res.status, 200, `${route.path} must answer a loopback caller`);
    assert.equal(typeof res.body, 'string', `${route.path} must write a body`);
    assert.doesNotThrow(() => JSON.parse(res.body), `${route.path} body must be JSON`);
  }

  // And a non-loopback caller must be refused on EVERY route, so a future route
  // cannot be added without a guard.
  for (const route of routes) {
    const res = {
      status: 0,
      writeHead(status) { res.status = status; },
      end() {},
    };
    route.handler({ url: '/', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '203.0.113.9' } }, res);
    assert.equal(res.status, 403, `${route.path} must refuse a non-loopback caller`);
  }
});

await check('the scroll-note injection row is gone (the chip is a client plugin now)', () => {
  // The old design pushed an inline script row into the startup-collected
  // injection table and anchored the chip by searching the composer DOM. That
  // broke silently twice. Its absence is now an invariant: a leftover row would
  // load a script whose route no longer exists.
  assert.equal(
    listeners.has('webserver/index-inject'),
    false,
    'the plugin must not subscribe to index injection any more',
  );
});

await check('the old injected chip script is no longer shipped or served', async () => {
  // `lib/chip.js` was the DOM-anchoring script. Its absence is what makes the
  // slot migration real: with it gone there is no code left that guesses at the
  // composer's markup.
  const chipPath = join(profile, 'node_modules', 'dsh-effort-pilot', 'lib', 'chip.js');
  await assert.rejects(() => readFile(chipPath, 'utf8'), 'lib/chip.js must be removed');
});

await check('the whale widget is untouched (no leftover patch)', async () => {
  const widgetHost = join(profile, 'node_modules', 'dsh-whale-widget', 'lib', 'index.js');
  const widgetWeb = join(profile, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js');
  let host;
  let web;
  try {
    host = await readFile(widgetHost, 'utf8');
    web = await readFile(widgetWeb, 'utf8');
  } catch {
    console.log('       (dsh-whale-widget not installed — nothing to check)');
    return;
  }
  // The chip replaced the patched-bubble design, so any residue here would mean
  // the revert did not fully take.
  assert.doesNotMatch(host, /dsh-whale\/effort\.json/, 'the whale route patch must be gone');
  assert.doesNotMatch(web, /pollEffortLevel/, 'the whale frontend patch must be gone');
  assert.doesNotMatch(web, /effort-pilot bubble bridge/, 'the patch marker must be gone');
});

await check('the installed copy has no orphaned files', async () => {
  // A file DELETED from the source used to survive in the installed copy, where
  // the host kept loading it (a removed debug script, a superseded module).
  // sync.mjs prunes them; this asserts the mirror is actually clean.
  const { readdir, stat: statFile } = await import('node:fs/promises');
  const sourceRoot = join(here, '..');
  const targetRoot = join(profile, 'node_modules', 'dsh-effort-pilot');

  async function filesUnder(root, dir) {
    const found = [];
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const relative = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await filesUnder(root, relative)));
      else found.push(relative);
    }
    return found;
  }

  const orphans = [];
  for (const dir of ['lib', 'tools', 'tests']) {
    try {
      await statFile(join(targetRoot, dir));
    } catch {
      continue;
    }
    for (const relative of await filesUnder(targetRoot, dir)) {
      try {
        await statFile(join(sourceRoot, relative));
      } catch {
        orphans.push(relative);
      }
    }
  }
  assert.deepEqual(orphans, [], `orphaned in the installed copy: ${orphans.join(', ')}`);
});

await rm(isolationDir, { recursive: true, force: true });

console.log('replay tooling');
await check('the offline gate replay agrees with the real scorer', async () => {
  // `tools/audit-gate.mjs` re-implements `SemanticScorer.shouldScore` for replay.
  // It once carried an extra branch and over-reported judge coverage, and that
  // inflated number was used to justify the resample tuning. A replay tool that
  // disagrees with the code it replays is worse than no tool, so parity is
  // asserted as part of the contract rather than trusted.
  const { execFileSync } = await import('node:child_process');
  const parity = join(pluginDir, 'tools', 'check-gate-parity.mjs');
  const output = execFileSync(process.execPath, [parity], { encoding: 'utf8' });
  assert.match(output, /GATE PARITY OK/, output.trim().split('\n').pop());
});

console.log('');
if (failures.length > 0) {
  console.error(`VERIFY FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('VERIFY OK — the plugin is ready to load on the next app start');
