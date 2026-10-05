/**
 * Host half of the level chip: the read-only route the client half reads.
 *
 * ARCHITECTURE (after the slot migration)
 * The chip is a CLIENT plugin (`lib/client.js`), registered into the
 * `conversation.input.right` slot through the documented Slot API. The host's
 * only job is to publish what it decided, which it does by writing a state file
 * (`lib/publish-state.js`) and serving it here.
 *
 * What this file used to do, and why it no longer does:
 *   - It pushed an inline `script` row into `webserver/index-inject` and served
 *     `lib/chip.js`. That script then ANCHORED THE CHIP BY SEARCHING THE COMPOSER
 *     DOM. The anchoring broke twice — silently, in one session layout but not
 *     another — and each time it had to be re-diagnosed by shipping instrumented
 *     probes into the page, because the host cannot see the page's DOM.
 *   - The slot API removes that entire class of failure: the slot owner decides
 *     placement, so no plugin code has to guess at markup, and a layout change
 *     cannot strand the chip.
 *
 * The inline-script knowledge is preserved here because it is the only injection
 * channel on the desktop shell, should something ever need it again: the shell
 * renders index.html from its install directory, so `webServer.tapIndex` never
 * runs there; `webserver/index-inject` is collected ONCE at host startup, so a row
 * registered after a service wait is lost with no error; and the row must be an
 * inline `script` row, never `script-src`, because the page-side interpreter
 * awaits `script-src` loads and a failure there rejects boot.
 */
import { readFileSync } from 'node:fs';

import { STATE_FILE, statePath } from './publish-state.js';

export const STATE_ROUTE = '/dsh-effort/state.json';

/**
 * Runtime evidence that the client half reached the page.
 *
 * Kept because the client half can fail just as silently: a bundle that does not
 * resolve, or a slot that is not present, renders nothing and reports nothing. A
 * report from the page tells "never loaded" apart from "loaded but found no seat".
 * Bounded counters only; nothing user-visible is stored.
 */
export const REPORT_ROUTE = '/dsh-effort/report.json';
export const STATUS_ROUTE = '/dsh-effort/status.json';

export const diagnostics = {
  /** How many times each route was requested. */
  routeHits: Object.create(null),
  /** How many times the client half announced itself. */
  reports: 0,
  /** Last client report: where it rendered. */
  lastReport: undefined,
};

/**
 * Loopback-only guard.
 *
 * Keys off the SOCKET address, never the `Host` header. The header is
 * client-supplied, so `Host: 127.0.0.1` from another machine would pass — and the
 * host can bind `0.0.0.0`, which would make the diagnostic route reachable
 * remotely while appearing protected.
 */
function isLoopback(req) {
  try {
    const addr = String(((req && req.socket) || {}).remoteAddress || '');
    if (addr === '127.0.0.1' || addr === '::1') return true;
    // IPv4-mapped IPv6, which is what a dual-stack listener usually reports.
    if (addr.startsWith('::ffff:')) {
      return addr.slice('::ffff:'.length) === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

/** Pull one query parameter out of a request, defensively. */
function queryParam(req, name) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://localhost');
    return url.searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function note(route) {
  diagnostics.routeHits[route] = (diagnostics.routeHits[route] ?? 0) + 1;
}

/**
 * Register the state route (and the client's report beacon).
 *
 * `webServer.register` is runtime and returns a disposer, so disabling the plugin
 * removes the routes too — no dangling address that 404s.
 *
 * Registration is ALL-OR-NOTHING. The real `register()` throws on a duplicate
 * `(kind, path)`; without the unwind below, an exception raised after some routes
 * were bound escaped before this function returned its disposer, so `apply()`
 * journalled one line and never installed a dispose handler — leaving those routes
 * answering forever, including after the plugin was disabled.
 */
export function registerRoutes(ctx) {
  const disposers = [];

  const add = (route) => {
    try {
      disposers.push(ctx.webServer.register(route));
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already gone */
        }
      }
      throw error;
    }
  };

  add({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: (req, res) => {
      // Guarded like the other two routes. The payload is only plugin-generated
      // (level, route, turn, scores) — no prompt text — but the host can bind
      // `0.0.0.0`, and leaving one route unguarded inside a file whose siblings
      // are guarded is how a leak survives review.
      if (!isLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      note(STATE_ROUTE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        const parsed = JSON.parse(readFileSync(statePath(), 'utf8'));
        // Pass through only what the chip needs; a corrupt file degrades to
        // `ok:false`, which the client renders as "nothing".
        res.end(JSON.stringify(parsed && typeof parsed === 'object' ? parsed : { ok: false }));
      } catch {
        // No decision published yet, or the file is mid-rename: not an error.
        res.end(JSON.stringify({ ok: false, file: STATE_FILE }));
      }
    },
  });

  // The client half announces itself and reports where it rendered, so "never
  // loaded" and "loaded but found no seat" stop looking identical from the host.
  add({
    kind: 'exact',
    path: REPORT_ROUTE,
    handler: (req, res) => {
      if (!isLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      note(REPORT_ROUTE);
      diagnostics.reports += 1;
      diagnostics.lastReport = { at: queryParam(req, 'at') ?? 'unknown', ts: queryParam(req, 't') };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  add({
    kind: 'exact',
    // Host-side view of the same counters, so a diagnostic run does not depend on
    // reading the page. Loopback only.
    path: STATUS_ROUTE,
    handler: (req, res) => {
      // The loopback check MUST come before writeHead: doing it after sent a 200
      // with the counters to a non-loopback caller, so the guard leaked exactly
      // what it was meant to protect.
      if (!isLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      note(STATUS_ROUTE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        reports: diagnostics.reports,
        lastReport: diagnostics.lastReport,
        routeHits: diagnostics.routeHits,
      }));
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
  };
}
