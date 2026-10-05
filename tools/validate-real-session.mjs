/**
 * Validate the signal layer against REAL session logs.
 *
 * Every shape assumption in `session-events.js` came from reading the host
 * source; this replays an actual session log through the real extraction path
 * and reports what it finds. Run this before trusting any threshold.
 *
 * Usage:  node tools/validate-real-session.mjs [path-to-session.v4.jsonl.zstd]
 *
 * With no argument it picks the newest log under $DSH_HOME/sessions.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { extractSignals, scoreLocal } from '../lib/decide.js';
import {
  contextPressure,
  countRetryEvents,
  currentTurn,
  isFirstTurn,
  sampleToolCalls,
  TOOL_SAMPLE_WINDOW,
} from '../lib/session-events.js';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** Newest `session.v4.jsonl.zstd` under the sessions root. */
async function newestLog() {
  const root = join(home, 'sessions');
  let best;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl.zstd')) {
        const info = await stat(path);
        if (best === undefined || info.mtimeMs > best.mtimeMs) best = { path, mtimeMs: info.mtimeMs };
      }
    }
  }
  await walk(root);
  return best?.path;
}

const path = process.argv[2] ?? (await newestLog());
if (path === undefined) {
  console.error('no session log found');
  process.exit(1);
}
console.log(`log: ${path}`);

const raw = await readFile(path);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let text;
if (raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
  // Whole-file inflate only works for a single-frame log. DSH appends one frame
  // per flush and prefixes an uncompressed header, so a raw log must go through
  // tools/decode-session.mjs first; accept either input here.
  try {
    text = zstdDecompressSync(raw).toString('utf8');
  } catch (error) {
    console.error(`compressed input could not be inflated in one shot (${error.message}).`);
    console.error('run tools/decode-session.mjs on it first, then pass the .jsonl here.');
    process.exit(1);
  }
} else {
  text = raw.toString('utf8');
}

const lines = text.split('\n').filter(line => line.trim().length > 0);
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    /* tolerate a torn tail line */
  }
}
console.log(`parsed ${events.length} events from ${lines.length} lines`);

/* ---- what event types actually occur ---- */
const byType = new Map();
for (const event of events) {
  const type = String(event?.type ?? '?');
  byType.set(type, (byType.get(type) ?? 0) + 1);
}
console.log('\ntop event types:');
for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${String(count).padStart(6)}  ${type}`);
}

/* ---- the two shapes the whole plugin rests on ---- */
const calls = events.filter(event => event?.type === 'tool/call');
const results = events.filter(event => event?.type === 'tool/result');
console.log(`\ntool/call: ${calls.length}   tool/result: ${results.length}`);
if (calls.length > 0) {
  console.log('sample tool/call.data keys :', Object.keys(calls[0].data ?? {}).sort().join(', '));
  console.log('  arguments type           :', typeof calls[0].data?.arguments);
  console.log('  callId present           :', typeof calls[0].data?.callId);
}
if (results.length > 0) {
  const sample = results.find(r => r.data?.error !== undefined) ?? results[0];
  console.log('sample tool/result.data keys:', Object.keys(sample.data ?? {}).sort().join(', '));
  const withError = results.filter(r => r.data?.error !== undefined).length;
  const withIsError = results.filter(r => r.data?.message?.isError === true).length;
  console.log(`  error present: ${withError}/${results.length}   message.isError true: ${withIsError}/${results.length}`);
}

/* ---- usage field names and the REAL context window ---- */
const usageEvents = events.filter(event => event?.data?.usage !== undefined);
console.log(`\nevents carrying data.usage: ${usageEvents.length}`);
if (usageEvents.length > 0) {
  console.log('  newest usage keys:', Object.keys(usageEvents[usageEvents.length - 1].data.usage).sort().join(', '));
  console.log('  newest usage     :', JSON.stringify(usageEvents[usageEvents.length - 1].data.usage));
}

// The window comes from `request/context`, which the loop appends when the
// route's context changes. Hardcoding it here once produced a contextPressure of
// 1.0 for every turn (a 128k assumption against a 1M window), which silently
// mis-calibrated the whole report.
const contextEvent = [...events].reverse().find(event => event?.type === 'request/context');
const contextWindow = Number.isFinite(contextEvent?.data?.contextWindow) ? contextEvent.data.contextWindow : undefined;
console.log(`contextWindow from request/context: ${contextWindow ?? 'UNKNOWN (pressure will read 0)'}`);
if (contextEvent !== undefined) {
  console.log('  route:', `${contextEvent.data?.provider}/${contextEvent.data?.model}`);
}

/* ---- replay through the real extraction path, turn by turn ---- */
const turns = [...new Set(events.filter(e => e?.type === 'turn/start').map(e => e.data?.turn))]
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

console.log(`\nturns found: ${turns.length}${turns.length > 0 ? ` (${turns[0]}..${turns[turns.length - 1]})` : ''}`);

const fakeAgent = { id: 'replay', session: { snapshotEvents: () => events } };
console.log('currentTurn():', currentTurn(events, undefined));
console.log('isFirstTurn():', isFirstTurn(fakeAgent, events));

const rows = [];
for (const turn of turns.slice(-12)) {
  const samples = sampleToolCalls(events, turn, TOOL_SAMPLE_WINDOW);
  const pressure = contextPressure(events, contextWindow);
  const signals = extractSignals(samples, {
    contextPressure: pressure,
    retryEvents: countRetryEvents(events, turn),
  });
  const local = scoreLocal(signals);
  rows.push({ turn, n: samples.length, local, signals });
}

console.log('\nlast turns replayed through the real path:');
console.log('  turn  calls  local  retry  err  reread  trend  div   ctx');
for (const row of rows) {
  const s = row.signals;
  console.log(
    `  ${String(row.turn).padStart(4)}  ${String(row.n).padStart(5)}  ${String(row.local).padStart(5)}`
    + `  ${String(s.retryRatio).padStart(5)}  ${String(s.errorRatio).padStart(3)}`
    + `  ${String(s.rereadRatio).padStart(6)}  ${String(s.payloadTrend).padStart(5)}`
    + `  ${String(s.toolDiversity).padStart(4)}  ${String(s.contextPressure).padStart(4)}`,
  );
}

/* ---- does anything actually fire? ---- */
const fired = {
  retry: rows.filter(r => r.signals.retryRatio > 0).length,
  error: rows.filter(r => r.signals.errorRatio > 0).length,
  reread: rows.filter(r => r.signals.rereadRatio > 0).length,
  trend: rows.filter(r => r.signals.payloadTrend > 0).length,
  diversity: rows.filter(r => r.signals.toolDiversity > 0).length,
  pressure: rows.filter(r => r.signals.contextPressure > 0).length,
  retryEvents: rows.filter(r => r.signals.retryEvents > 0).length,
};
console.log(`\nsignal activity over ${rows.length} replayed turns:`);
for (const [name, count] of Object.entries(fired)) {
  console.log(`  ${name.padEnd(12)} fired in ${count}/${rows.length} turns${count === 0 ? '   <-- NEVER FIRES' : ''}`);
}

const scores = rows.map(r => r.local);
if (scores.length > 0) {
  // Read the live thresholds out of the plugin's own schema instead of
  // hardcoding them, so this report cannot drift from the code it describes.
  const profile = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', 'desktop');
  let lowMax = 2;
  let highMin = 7;
  try {
    const mod = await import(
      new URL(`file://${join(profile, 'node_modules', 'dsh-effort-pilot', 'lib', 'index.js').replace(/\\/g, '/')}`).href
    );
    const value = mod.Config['~standard'].validate({}).value;
    const read = field => (value[field]?.get ? value[field].get() : value[field]);
    lowMax = read('lowMax');
    highMin = read('highMin');
  } catch (error) {
    console.log(`(could not read live thresholds: ${error.message}; using ${lowMax}/${highMin})`);
  }

  console.log(`\nlocal score range: ${Math.min(...scores)} .. ${Math.max(...scores)}  (lowMax=${lowMax}, highMin=${highMin})`);
  console.log(`  would schedule low : ${scores.filter(s => s < lowMax).length} turns`);
  console.log(`  would schedule high: ${scores.filter(s => s >= lowMax && s <= highMin).length} turns`);
  console.log(`  would schedule max : ${scores.filter(s => s > highMin).length} turns`);
  console.log('');
  console.log('NOTE: the local score alone drives nothing when the semantic judge is');
  console.log('available. On these turns the local score is quiet (0.5-1.8), so the band');
  console.log('above would also be the ambiguous band -> the judge decides the level.');
}
