/**
 * Benchmark `sampleToolCalls` against session logs of growing length.
 *
 * WHY THIS EXISTS: the function runs inside the `agent/request` waterfall, so its
 * cost is on the critical path of every request. The review flagged that it walks
 * every event of the whole session and materialises a sample object for every
 * `tool/call` before slicing to the window. This measures the actual shape of
 * that cost so a change can be judged rather than assumed.
 *
 * Usage:  node tools/bench-sampling.mjs
 */
import { sampleToolCalls } from '../lib/session-events.js';

/**
 * A synthetic log: `turns` turns, each with `callsPerTurn` matched call/result
 * pairs. The last turn is the one being sampled, so the prefix is pure overhead.
 */
function build(turns, callsPerTurn) {
  const events = [];
  for (let t = 1; t <= turns; t += 1) {
    for (let c = 0; c < callsPerTurn; c += 1) {
      const callId = `c${t}_${c}`;
      events.push({
        type: 'tool/call',
        time: t * 1000 + c,
        data: { turn: t, step: c, callId, name: 'read', arguments: '{"path":"/a/b"}' },
      });
      events.push({
        type: 'tool/result',
        time: t * 1000 + c + 10,
        data: { turn: t, step: c, callId, message: { isError: false } },
      });
    }
  }
  return events;
}

const SHAPES = [
  [30, 3],
  [100, 5],
  [500, 10],
  [2000, 20],
];

console.log('turns  calls/turn   events     per call (ms)   window');
for (const [turns, callsPerTurn] of SHAPES) {
  const events = build(turns, callsPerTurn);
  for (let i = 0; i < 200; i += 1) sampleToolCalls(events, turns, 8);

  const iterations = 2000;
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) sampleToolCalls(events, turns, 8);
  const perCall = Number(process.hrtime.bigint() - started) / 1e6 / iterations;

  console.log(
    `${String(turns).padStart(5)}  ${String(callsPerTurn).padStart(9)}   `
    + `${String(events.length).padStart(7)}   ${perCall.toFixed(4).padStart(12)}   ${sampleToolCalls(events, turns, 8).length}`,
  );
}

// Correctness guard: the window must still return the NEWEST calls, joined with
// their outcomes, no matter how long the prefix is.
const events = build(50, 4);
const window = sampleToolCalls(events, 50, 3);
console.log('\nnewest-3 window sample:', JSON.stringify(window.map(s => s.durationMs)));
