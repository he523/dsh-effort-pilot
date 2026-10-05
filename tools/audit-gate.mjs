/**
 * Audit: where can the scheduler go wrong, and how often does it actually run?
 *
 * Answers questions the journal cannot, because the journal only holds decisions
 * the scheduler made — not the ones it skipped.
 *
 * Usage:  node tools/audit-gate.mjs <decoded.jsonl> [resampleTurns]
 */
import { readFile } from 'node:fs/promises';

import { extractSignals, scoreLocal, fuse, mapLevel } from '../lib/decide.js';
import { contextPressure, countRetryEvents, isFirstTurn, sampleToolCalls } from '../lib/session-events.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node tools/audit-gate.mjs <decoded.jsonl>');
  process.exit(1);
}

const events = (await readFile(path, 'utf8'))
  .split('\n')
  .filter(line => line.trim().length > 0)
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const turns = [...new Set(
  events.filter(e => e?.type === 'turn/start').map(e => e.data?.turn),
)].filter(Number.isFinite).sort((a, b) => a - b);

const contextEvent = [...events].reverse().find(e => e?.type === 'request/context');
const contextWindow = Number.isFinite(contextEvent?.data?.contextWindow) ? contextEvent.data.contextWindow : undefined;

const LOW_MAX = 2;
const HIGH_MIN = 6;
const AMBIGUOUS_LOW = 2;
const AMBIGUOUS_HIGH = 7;
/** Compare cadences by passing a value: `node tools/audit-gate.mjs log.jsonl 10`. */
const RESAMPLE = Number(process.argv[3] ?? 12);

console.log(`turns: ${turns.length}   contextWindow: ${contextWindow ?? 'unknown'}   resampleDecisions: ${RESAMPLE}\n`);

let wouldScore = 0;
let lastSample = undefined;
let decision = 0;
const gateReasons = new Map();
const scores = [];

console.log('  turn  calls  local  ctx    gate            reason');
for (const turn of turns) {
  const samples = sampleToolCalls(events, turn);
  const signals = extractSignals(samples, {
    contextPressure: contextPressure(events, contextWindow),
    retryEvents: countRetryEvents(events, turn),
  });
  const local = scoreLocal(signals);

  // Mirror the scorer's gate EXACTLY (lib/scorer.js:187-242).
  //
  // TWO things this must get right, both learned the hard way:
  //
  //  1. The scorer has TWO outcomes, not three. Inside the interval it returns
  //     `not-ambiguous` no matter how ambiguous the local score looks; the
  //     ambiguous band only chooses the REASON once the interval has elapsed. An
  //     earlier version added an `else if (ambiguous)` branch that scored anyway,
  //     which OVER-REPORTED judge coverage — and that inflated reading is what the
  //     resample tuning was originally justified with.
  //
  //  2. The first-turn short-circuit comes FIRST and names itself. The first turn
  //     is the most valuable sample: local signals have nothing to work with yet.
  //
  // `tools/check-gate-parity.mjs` asserts both against the real scorer, so this
  // file cannot drift from it again unnoticed.
  const firstTurn = decision === 0;
  const ambiguous = local > AMBIGUOUS_LOW && local < AMBIGUOUS_HIGH;
  decision += 1;
  const due = lastSample === undefined || decision - lastSample >= RESAMPLE;
  const gate = firstTurn || due;
  const reason = firstTurn
    ? 'first-turn'
    : (due ? (ambiguous ? 'ambiguous-band' : 'periodic') : 'not-ambiguous');
  if (gate) {
    wouldScore += 1;
    lastSample = decision;
  }
  gateReasons.set(reason, (gateReasons.get(reason) ?? 0) + 1);
  scores.push(local);

  console.log(
    `  ${String(turn).padStart(4)}  ${String(samples.length).padStart(5)}  ${String(local).padStart(5)}`
    + `  ${String(signals.contextPressure).padStart(4)}   ${gate ? 'SCORE' : 'skip '}`
    + `           ${reason}`,
  );
}

console.log(`\nwould call the judge on ${wouldScore}/${turns.length} turns`);
console.log('gate reasons:', JSON.stringify(Object.fromEntries(gateReasons)));

console.log('\n⚠ LIMITATION: this replay models ONE decision per turn, but a real turn can');
console.log('  hold dozens of step-requests (one measured turn had 33). A request-level');
console.log('  interval therefore looks far looser here than it is live. Trust the ACTUAL');
console.log('  journal (`node tools/summarise-journal.mjs`) for real cadence; use this tool');
console.log('  for the local-score distribution and the ambiguous-band question only.');

console.log('\n--- the structural problem ---');
const quiet = scores.filter(s => s <= 1).length;
console.log(`local score <= 1 on ${quiet}/${turns.length} turns`);

// When the local score is quiet, what does the scheduler do with no verdict?
let wouldDowngrade = 0;
for (const turn of turns) {
  const mapped = mapLevel({
    difficulty: 0.5,
    currentLevel: 'high',
    turn,
    log: [],
    isFirstTurn: false,
    config: { lowMax: LOW_MAX, highMin: HIGH_MIN, confirmRounds: 1, minDwellTurns: 0 },
  });
  if (mapped.level === 'low') wouldDowngrade += 1;
}
console.log(
  `with a QUIET local score (0.5) the scheduler would pick 'low' on ${wouldDowngrade}/${turns.length} turns`,
);
console.log('Those downgrades rest on local evidence alone whenever the gate says skip.');
console.log('A downgrade justified by a score of ~0.5 is a guess, not a measurement.');
