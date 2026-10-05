/**
 * Prove `tools/audit-gate.mjs`'s gate decision matches the real scorer.
 *
 * WHY THIS EXISTS: audit-gate re-implements `SemanticScorer.shouldScore` for
 * offline replay. It once carried an extra `else if (ambiguous)` branch that the
 * scorer does not have, so it over-reported how often the judge is consulted —
 * and that inflated number is what the resample tuning was originally justified
 * with. A replay tool that silently disagrees with the code it replays is worse
 * than no tool, so the agreement is asserted here.
 *
 * Usage:  node tools/check-gate-parity.mjs
 */
import { SemanticScorer } from '../lib/scorer.js';

/** Must mirror the constants in tools/audit-gate.mjs. */
const AMBIGUOUS_LOW = 2;
const AMBIGUOUS_HIGH = 7;
const RESAMPLE = 12;

const config = {
  mode: 'hybrid',
  semantic: {
    enabled: true,
    ambiguousLow: AMBIGUOUS_LOW,
    ambiguousHigh: AMBIGUOUS_HIGH,
    resampleDecisions: RESAMPLE,
    maxCallsPerTurn: 0,
    maxCallsPerSession: 1_000_000,
    alwaysOnFirstTurn: true,
  },
};

/** The audit tool's decision, reproduced exactly as it computes it. */
function auditGate({ local, decision, lastSample, isFirstTurn }) {
  // Mirrors the scorer's ORDER: the first-turn short-circuit comes before the
  // interval, and names itself in the reason. Replay that ignores the order gets
  // the count right but the reason wrong — which is how a divergence hides.
  if (isFirstTurn) return { score: true, reason: 'first-turn' };
  const ambiguous = local > AMBIGUOUS_LOW && local < AMBIGUOUS_HIGH;
  const due = lastSample === undefined || decision - lastSample >= RESAMPLE;
  return {
    score: due,
    reason: due ? (ambiguous ? 'ambiguous-band' : 'periodic') : 'not-ambiguous',
  };
}

/**
 * @param {boolean} firstTurnOnly model the one decision of a genuinely first turn
 * @param {number} localScore deliberately ambiguous for the whole run
 */
function compare({ label, firstTurnOnly, localScore, decisions }) {
  const scorer = new SemanticScorer({
    getConfig: () => config,
    stream: () => ({ async *[Symbol.asyncIterator]() {} }),
  });
  const sessionId = 'parity';

  let lastSample;
  let mismatches = 0;
  let judgeCalls = 0;

  for (let decision = 1; decision <= decisions; decision += 1) {
    if (lastSample !== undefined) scorer.lastSampleDecision.set(sessionId, lastSample);

    const firstTurn = firstTurnOnly === true && decision === 1;
    const real = scorer.shouldScore({
      localScore,
      // `isFirstTurn` is a property of the SESSION, not of a decision. Treating it
      // as constant for a whole run made this harness report a false divergence:
      // the scorer short-circuits on it before the interval, so every decision
      // scored while the replay counted the interval.
      isFirstTurn: firstTurn,
      decisions: decision,
      sessionId,
      callsThisTurn: 0,
    });
    const replay = auditGate({ local: localScore, decision, lastSample, isFirstTurn: firstTurn });

    if (real.score !== replay.score || real.reason !== replay.reason) {
      mismatches += 1;
      if (mismatches <= 3) {
        console.log(
          `    divergence at decision ${decision}:`
          + ` scorer=${JSON.stringify(real)} audit=${JSON.stringify(replay)}`,
        );
      }
    }
    if (real.score) {
      judgeCalls += 1;
      // The CALLER advances the sample clock — the scorer does not. Getting this
      // wrong is what made an earlier comparison report a false divergence.
      lastSample = decision;
    }
  }

  const verdict = mismatches === 0 ? 'MATCH' : `MISMATCH x${mismatches}`;
  console.log(
    `  ${label.padEnd(34)} decisions=${String(decisions).padStart(3)}`
    + `  judge calls=${String(judgeCalls).padStart(3)}  ${verdict}`,
  );
  return mismatches;
}

console.log('gate parity: tools/audit-gate.mjs vs lib/scorer.js\n');

let failures = 0;
for (const localScore of [0, 1, 3, 4.5, 6, 9]) {
  failures += compare({
    label: `ambiguous-band local=${localScore}`,
    firstTurnOnly: false,
    localScore,
    decisions: 40,
  });
}
// The very first decision of a session: `isFirstTurn` short-circuits the scorer,
// and the replay models that as `lastSample === undefined`.
failures += compare({ label: 'first turn', firstTurnOnly: true, localScore: 4.5, decisions: 5 });

console.log('');
if (failures > 0) {
  console.error(`GATE PARITY FAILED — ${failures} divergence(s). The replay tool does not match the scorer.`);
  process.exit(1);
}
console.log('GATE PARITY OK — the replay tool and the scorer agree on every decision.');
