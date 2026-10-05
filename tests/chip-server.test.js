/**
 * Unit tests for the host half of the level chip: the routes the client reads.
 *
 * The chip itself is a client plugin; this half only publishes the decision. The
 * routes are easy to get subtly wrong in ways that fail silently — a route that
 * throws instead of answering, a duplicate registration that leaves earlier
 * routes bound with no disposer — so they are pinned here rather than trusted.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONFIG_ROUTE, REPORT_ROUTE, STATE_ROUTE, STATUS_ROUTE, diagnostics, registerRoutes,
} from '../lib/chip-server.js';
import { load as loadOverrides, save as saveOverrides } from '../lib/config-overrides.js';

/** Every route this half registers. */
const ALL_ROUTES = [CONFIG_ROUTE, REPORT_ROUTE, STATE_ROUTE, STATUS_ROUTE];

/**
 * Point DSH_HOME at an empty directory.
 *
 * Without this the state route happily reads the real published file and the
 * "nothing published yet" branch is never exercised — the test passes for the
 * wrong reason. (That is exactly how this test first failed.)
 */
async function withEmptyHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-pilot-chip-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A loopback request, which is what the page actually sends. */
const loopbackReq = (url = '/') => ({ url, method: 'GET', socket: { remoteAddress: '127.0.0.1' } });

/** A request from another machine. */
const remoteReq = (url = '/') => ({ url, socket: { remoteAddress: '203.0.113.9' } });

/** A dual-stack listener reports IPv4 peers in IPv4-mapped form. */
const mappedReq = (url = '/') => ({ url, socket: { remoteAddress: '::ffff:127.0.0.1' } });

/** A request carrying a JSON body, delivered the way a real stream would. */
function postReq(body, socket = { remoteAddress: '127.0.0.1' }) {
  const handlers = {};
  const req = {
    url: '/',
    method: 'POST',
    socket,
    on(event, fn) { handlers[event] = fn; return req; },
    destroy() {},
  };
  // Deliver asynchronously: the handler attaches its listeners after awaiting
  // nothing, so synchronous emission would arrive before they exist.
  setImmediate(() => {
    handlers.data?.(Buffer.from(body, 'utf8'));
    handlers.end?.();
  });
  return req;
}

/**
 * A webServer that rejects a duplicate path, like the real one.
 *
 * A permissive fake cannot see the partial-registration leak: the real
 * `register()` throws on a duplicate `(kind, path)`, and an exception raised
 * after some routes were bound used to escape before the disposer was returned.
 */
function fakeWebCtx(rejectPath) {
  const routes = [];
  const disposed = [];
  const ctx = {
    webServer: {
      register(route) {
        if (route.path === rejectPath) throw new Error('duplicate route');
        routes.push(route);
        return () => disposed.push(route.path);
      },
    },
  };
  return { ctx, routes, disposed };
}

/** Minimal response object recording what the handler wrote. */
function fakeRes() {
  const res = {
    status: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.body = body;
    },
    json() {
      return JSON.parse(res.body);
    },
  };
  return res;
}

test('every route registers as an exact path', () => {
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  assert.deepEqual(
    routes.map(r => r.path).sort(),
    [...ALL_ROUTES].sort(),
  );
  for (const route of routes) assert.equal(route.kind, 'exact');
});

test('the state route answers ok:false when nothing is published', async () => {
  await withEmptyHome(() => {
    const { ctx, routes } = fakeWebCtx();
    registerRoutes(ctx);
    const stateRoute = routes.find(r => r.path === STATE_ROUTE);
    const res = fakeRes();
    assert.doesNotThrow(() => stateRoute.handler(loopbackReq(), res));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, false, 'a missing file is not an error');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });
});

test('the state route serves what was published', async () => {
  await withEmptyHome(async () => {
    const { publish, STATE_FILE, statePath } = await import('../lib/publish-state.js');
    publish({ level: 'high', difficulty: 4.2, reason: 'periodic' });
    assert.ok(statePath().endsWith(STATE_FILE));

    const { ctx, routes } = fakeWebCtx();
    registerRoutes(ctx);
    const stateRoute = routes.find(r => r.path === STATE_ROUTE);
    const res = fakeRes();
    stateRoute.handler(loopbackReq(), res);

    const served = JSON.parse(res.body);
    assert.equal(served.ok, true);
    assert.equal(served.level, 'high', 'the client half reads this field');
    assert.ok(Number.isFinite(served.ts) && served.ts > 0, 'a ts is required for the staleness check');
  });
});

test('the report route counts a loopback report and records where it rendered', () => {
  const before = diagnostics.reports;
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const reportRoute = routes.find(r => r.path === REPORT_ROUTE);

  const res = fakeRes();
  reportRoute.handler(loopbackReq('/dsh-effort/report.json?at=chip&t=123'), res);
  assert.equal(res.status, 200);
  assert.equal(diagnostics.reports, before + 1);
  assert.equal(diagnostics.lastReport.at, 'chip', 'the render point must be recorded');
});

test('the loopback guard keys off the socket, not the Host header', () => {
  // The Host header is client-supplied: `Host: 127.0.0.1` from another machine
  // used to pass the guard. Guarding on it was the defect; this pins the fix.
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const statusRoute = routes.find(r => r.path === STATUS_ROUTE);

  const spoofed = fakeRes();
  statusRoute.handler({ url: '/', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '203.0.113.9' } }, spoofed);
  assert.equal(spoofed.status, 403, 'a spoofed Host header must not pass');

  const mapped = fakeRes();
  statusRoute.handler(mappedReq(), mapped);
  assert.equal(mapped.status, 200, 'IPv4-mapped loopback must pass');
});

test('a non-loopback report is refused with 403', () => {
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const reportRoute = routes.find(r => r.path === REPORT_ROUTE);
  const res = fakeRes();
  reportRoute.handler(remoteReq(), res);
  assert.equal(res.status, 403, 'the beacon must not be writable from off-machine');
});

test('the status route refuses off-machine callers with 403, not 200', () => {
  // This is the assertion the first version was missing: checking only the body
  // let a 200-wrapped leak pass. The status code IS the guard.
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const statusRoute = routes.find((r) => r.path === STATUS_ROUTE);

  const denied = fakeRes();
  statusRoute.handler(remoteReq(), denied);
  assert.equal(denied.status, 403, 'off-machine callers must not receive 200');
  const body = JSON.parse(denied.body);
  assert.equal(body.ok, false);
  assert.equal(body.routeHits, undefined, 'counters must not leak off-machine');
});

test('the status route exposes the counters to loopback', () => {
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const statusRoute = routes.find(r => r.path === STATUS_ROUTE);
  const stateRoute = routes.find(r => r.path === STATE_ROUTE);

  /** Read the counters through the status route. */
  const counters = () => {
    const res = fakeRes();
    statusRoute.handler(loopbackReq(), res);
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  };

  const first = counters();
  assert.equal(first.ok, true);
  const before = first.routeHits[STATE_ROUTE] ?? 0;

  stateRoute.handler(loopbackReq(), fakeRes());

  // Assert a DELTA, not an absolute: `diagnostics` is module-level and shared, so
  // `>= 1` would pass only because an earlier test happened to hit the route — it
  // would fail if this test ran alone.
  assert.equal(
    counters().routeHits[STATE_ROUTE],
    before + 1,
    'each request must be counted',
  );
});

test('disposing removes every route', () => {
  const { ctx, disposed } = fakeWebCtx();
  const dispose = registerRoutes(ctx);
  dispose();
  assert.deepEqual(
    disposed.sort(),
    [...ALL_ROUTES].sort(),
  );
});

test('the settings route is the only WRITABLE one, so its guard is tested hard', async () => {
  // Every other route merely returns plugin-generated data. This one accepts a
  // write, so a missing guard would let anything on the LAN change how the
  // scheduler behaves — a much worse outcome than reading a level.
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const route = routes.find(r => r.path === CONFIG_ROUTE);
  assert.ok(route, 'the settings route must exist');

  for (const req of [remoteReq(), { url: '/', method: 'GET', socket: { remoteAddress: '::ffff:203.0.113.9' } }]) {
    const res = fakeRes();
    await route.handler(req, res);
    assert.equal(res.status, 403, 'a non-loopback caller must be refused');
  }

  // And a loopback caller must be served, so the guard is not simply always-on.
  const res = fakeRes();
  await route.handler(loopbackReq(), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
});

test('the settings route serves the live values, the declared baseline and observations', async () => {
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx, {
    readConfig: () => ({ lowMax: 3, highMin: 6, semantic: { timeoutMs: 1200 } }),
    declaredConfig: () => ({ lowMax: 2, highMin: 6 }),
    observe: () => ({ lastDecision: { level: 'high' }, verdicts: { samples: 3, histogram: { 0: 2, 6: 1 } } }),
    reloadOverrides: () => {},
  });
  const res = fakeRes();
  await routes.find(r => r.path === CONFIG_ROUTE).handler(loopbackReq(), res);

  const body = res.json();
  assert.equal(body.effective.lowMax, 3, 'the card must show the LIVE value');
  assert.equal(body.declared.lowMax, 2, 'and the profile-declared one, so it can offer a reset');
  assert.equal(body.observations.verdicts.samples, 3);
  assert.ok(body.editable.lowMax, 'the editable whitelist must be published');
  assert.ok(body.editableNested.semantic?.timeoutMs);
});

test('the settings route persists a valid write and reloads the overrides', async () => {
  await withEmptyHome(async () => {
    const { ctx, routes } = fakeWebCtx();
    let reloads = 0;
    registerRoutes(ctx, {
      readConfig: () => ({}),
      declaredConfig: () => ({}),
      reloadOverrides: () => { reloads += 1; },
      observe: () => ({}),
    });
    const route = routes.find(r => r.path === CONFIG_ROUTE);

    const res = fakeRes();
    await route.handler(postReq(JSON.stringify({ values: { lowMax: 4, bogus: 1 } })), res);
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.rejected, [], 'no editable value was invalid here');
    assert.deepEqual(body.ignored, ['bogus'], 'an unmanaged key is IGNORED, never reported as rejected');
    assert.deepEqual(body.values, { lowMax: 4 });
    assert.equal(reloads, 1, 'the running config must be refreshed immediately');

    // And the value survives a re-read through the same module.
    const stored = loadOverrides();
    assert.equal(stored.lowMax, 4);
  });
});

test('the settings route refuses an out-of-range value without storing it', async () => {
  await withEmptyHome(async () => {
    const { ctx, routes } = fakeWebCtx();
    registerRoutes(ctx, { reloadOverrides: () => {} });
    const res = fakeRes();
    await routes.find(r => r.path === CONFIG_ROUTE)
      .handler(postReq(JSON.stringify({ values: { lowMax: 999 } })), res);

    // 400, not 200: nothing survived validation, so accepting it would have
    // REPLACED the stored overrides with an empty set and reported success.
    assert.equal(res.status, 400);
    assert.deepEqual(res.json().rejected, ['lowMax']);
    assert.deepEqual(loadOverrides(), {}, 'nothing may be written for a rejected value');
  });
});

/** Every body shape that must NOT be able to replace the stored overrides. */
const WIPE_VECTORS = [
  ['{}', '{}'],
  ['{"values":{}}', '{"values":{}}'],
  ['{"reset":false}', '{"reset":false}'],
  ['{"values":{"bogus":1}}', '{"values":{"bogus":1}}'],
  ['an empty body', ''],
  ['an array', '[]'],
  ['a scalar', '5'],
  ['not JSON', '{ not json'],
  ['a hostile numeric value', '{"values":{"lowMax":{"toString":1}}}'],
  ['a prototype-named key', '{"values":{"constructor":5}}'],
];

test('no body shape can silently replace the stored overrides with nothing', async () => {
  // A save is a FULL REPLACE of the override file, so a body from which nothing
  // survives must be refused rather than reported as success. Before this guard,
  // `{}`, `{"values":{}}` and `{"reset":false}` each deleted every stored override
  // and answered 200 — and the client reaches that path for real, because
  // `pickEditable(null, …)` returns `{}` when its config load failed.
  for (const [label, body] of WIPE_VECTORS) {
    await withEmptyHome(async () => {
      saveOverrides({ lowMax: 9, highMin: 8 });
      const before = JSON.stringify(loadOverrides());

      const { ctx, routes } = fakeWebCtx();
      registerRoutes(ctx, { reloadOverrides: () => {} });
      const res = fakeRes();
      // Must not reject: a rejecting handler leaves the response unwritten and the
      // real webServer turns that into a 400 with an EMPTY body.
      await assert.doesNotReject(
        async () => routes.find(r => r.path === CONFIG_ROUTE).handler(postReq(body), res),
        `${label} made the handler reject`,
      );

      assert.ok(res.status >= 400, `${label} must be refused, got ${res.status}`);
      assert.equal(typeof res.body, 'string', `${label} must still write a body`);
      assert.doesNotThrow(() => JSON.parse(res.body), `${label} body must be JSON`);
      assert.equal(JSON.stringify(loadOverrides()), before, `${label} must not touch the stored overrides`);
    });
  }
});

test('a save carrying real values still works', async () => {
  await withEmptyHome(async () => {
    const { ctx, routes } = fakeWebCtx();
    let reloads = 0;
    registerRoutes(ctx, { reloadOverrides: () => { reloads += 1; } });
    const res = fakeRes();
    await routes.find(r => r.path === CONFIG_ROUTE)
      .handler(postReq(JSON.stringify({ values: { lowMax: 4, highMin: 5 } })), res);

    assert.equal(res.status, 200);
    assert.deepEqual(res.json().values, { lowMax: 4, highMin: 5 });
    assert.deepEqual(loadOverrides(), { lowMax: 4, highMin: 5 });
    assert.equal(reloads, 1);
  });
});

test('the settings route answers every malformed body with a JSON error, never a throw', async () => {
  await withEmptyHome(async () => {
    const { ctx, routes } = fakeWebCtx();
    registerRoutes(ctx);
    const route = routes.find(r => r.path === CONFIG_ROUTE);

    for (const body of ['{ not json', '', '[]', '5', 'null']) {
      const res = fakeRes();
      await assert.doesNotReject(
        async () => route.handler(postReq(body), res),
        `body ${JSON.stringify(body)} made the handler reject`,
      );
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be a 400`);
      assert.equal(typeof res.body, 'string', 'an error body must always be written');
      const parsed = res.json();
      assert.equal(parsed.ok, false);
      assert.equal(typeof parsed.error, 'string', 'the error must say what was wrong');
    }
  });
});

test('the settings route clears every override on a reset', async () => {
  await withEmptyHome(async () => {
    saveOverrides({ lowMax: 9 });
    assert.deepEqual(loadOverrides(), { lowMax: 9 });

    const { ctx, routes } = fakeWebCtx();
    let reloads = 0;
    registerRoutes(ctx, { reloadOverrides: () => { reloads += 1; } });
    const res = fakeRes();
    await routes.find(r => r.path === CONFIG_ROUTE)
      .handler(postReq(JSON.stringify({ reset: true })), res);

    assert.equal(res.status, 200);
    assert.equal(res.json().reset, true);
    assert.deepEqual(loadOverrides(), {}, 'the reset must remove the file');
    assert.equal(reloads, 1);
  });
});

test('a rejected registration unwinds the routes already bound', () => {
  // The real register() throws on a duplicate. Before the unwind, a collision on
  // a later route left the earlier ones bound with no disposer returned — so they
  // answered even after the plugin was disabled.
  //
  // Everything is derived from the ACTUAL registration order: an earlier version
  // hard-coded the expected set and silently stopped checking the real thing as
  // soon as a route was added.
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  const order = routes.map(r => r.path);
  assert.ok(order.length >= 2, 'need at least two routes to test an unwind');

  // Make the LAST registration fail, so every other route is already bound.
  const rejectPath = order[order.length - 1];
  const failing = fakeWebCtx(rejectPath);
  assert.throws(() => registerRoutes(failing.ctx), /duplicate route/);
  assert.equal(failing.routes.includes(rejectPath), false, 'the rejected route is not bound');
  assert.deepEqual(
    failing.disposed.sort(),
    order.filter(path => path !== rejectPath).sort(),
    'every route bound before the failure must be unregistered',
  );
});
