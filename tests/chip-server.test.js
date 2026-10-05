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
  REPORT_ROUTE, STATE_ROUTE, STATUS_ROUTE, diagnostics, registerRoutes,
} from '../lib/chip-server.js';

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
const loopbackReq = (url = '/') => ({ url, socket: { remoteAddress: '127.0.0.1' } });

/** A request from another machine. */
const remoteReq = (url = '/') => ({ url, socket: { remoteAddress: '203.0.113.9' } });

/** A dual-stack listener reports IPv4 peers in IPv4-mapped form. */
const mappedReq = (url = '/') => ({ url, socket: { remoteAddress: '::ffff:127.0.0.1' } });

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
  };
  return res;
}

test('every route registers as an exact path', () => {
  const { ctx, routes } = fakeWebCtx();
  registerRoutes(ctx);
  assert.deepEqual(
    routes.map(r => r.path).sort(),
    [REPORT_ROUTE, STATE_ROUTE, STATUS_ROUTE].sort(),
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
    [REPORT_ROUTE, STATE_ROUTE, STATUS_ROUTE].sort(),
  );
});

test('a rejected registration unwinds the routes already bound', () => {
  // The real register() throws on a duplicate. Before the unwind, a collision on
  // a later route left the earlier ones bound with no disposer returned — so they
  // answered even after the plugin was disabled.
  const { ctx, disposed, routes } = fakeWebCtx(STATUS_ROUTE);
  assert.throws(() => registerRoutes(ctx), /duplicate route/);
  assert.equal(routes.includes(STATUS_ROUTE), false, 'the rejected route is not bound');
  assert.deepEqual(
    disposed.sort(),
    [REPORT_ROUTE, STATE_ROUTE].sort(),
    'every route bound before the failure must be unregistered',
  );
});
