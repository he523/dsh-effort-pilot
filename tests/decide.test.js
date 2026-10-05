/**
 * Unit tests for the pure decision engine.
 *
 * Covers the acceptance criteria in DESIGN-dsh-effort-pilot.md §10.1. Run:
 *   node --test tests/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampToEfforts,
  extractSignals,
  fuse,
  mapLevel,
  rank,
  scoreLocal,
  DEFAULT_WEIGHTS,
} from '../lib/decide.js';

/** Build a tool-call sample the way session-events.js would. */
function call(name, argsSize = 10, error = false, fingerprint) {
  return {
    name,
    argsSize,
    error,
    durationMs: 5,
    fingerprint: fingerprint ?? `${name}\u0000${argsSize}`,
  };
}

/* ---------------------------------------------------------------- *
 * L1 signals
 * ---------------------------------------------------------------- */

test('extractSignals: no calls yields no positive evidence', () => {
  const signals = extractSignals([]);
  assert.equal(signals.sampleCount, 0);
  assert.equal(signals.retryRatio, 0);
  assert.equal(signals.errorRatio, 0);
  assert.equal(signals.rereadRatio, 0);
  assert.equal(signals.payloadTrend, 0);
  assert.equal(signals.toolDiversity, 0);
});

test('extractSignals: repeated identical call is a retry chain', () => {
  const signals = extractSignals([
    call('read', 100, false, 'read\u0000100\u0000aaa'),
    call('read', 100, false, 'read\u0000100\u0000aaa'),
    call('read', 100, false, 'read\u0000100\u0000aaa'),
    call('grep', 20, false, 'grep\u000020\u0000bbb'),
  ]);
  // 2 of 4 calls repeat an earlier fingerprint.
  assert.equal(signals.retryRatio, 0.5);
});

test('extractSignals: distinct targets of the same tool are not retries', () => {
  const signals = extractSignals([
    call('read', 100, false, 'read\u0000100\u0000a'),
    call('read', 100, false, 'read\u0000100\u0000b'),
    call('read', 100, false, 'read\u0000100\u0000c'),
  ]);
  assert.equal(signals.retryRatio, 0);
});

test('extractSignals: failure ratio counts error results', () => {
  const signals = extractSignals([
    call('bash', 100, true),
    call('read', 100, false),
    call('edit', 100, false),
    call('bash', 100, true),
  ]);
  assert.equal(signals.errorRatio, 0.5);
});

test('extractSignals: payload trend is growth, not absolute size', () => {
  const growing = extractSignals([call('read', 100), call('read', 300), call('read', 900)]);
  assert.equal(growing.payloadTrend, 1);

  const shrinking = extractSignals([call('read', 900), call('read', 300), call('read', 100)]);
  assert.equal(shrinking.payloadTrend, 0);
});

test('extractSignals: a single huge call alone is not a "growth" signal', () => {
  // This is the old plugin's mistake: absolute size was treated as difficulty.
  const signals = extractSignals([call('write', 8000)]);
  assert.equal(signals.payloadTrend, 0);
  assert.equal(signals.retryRatio, 0);
  assert.equal(signals.errorRatio, 0);
});

test('extractSignals: repeated same tool raises reread ratio', () => {
  const signals = extractSignals([
    call('read', 10, false, 'a'),
    call('grep', 10, false, 'b'),
    call('read', 10, false, 'c'),
  ]);
  // One revisit out of (n-1)=2 opportunities.
  assert.equal(signals.rereadRatio, 0.5);
});

/* ---------------------------------------------------------------- *
 * Scoring
 * ---------------------------------------------------------------- */

test('scoreLocal: all-zero signals score zero', () => {
  const score = scoreLocal(extractSignals([]));
  assert.equal(score, 0);
});

test('scoreLocal: repeated failures saturate the scale', () => {
  const signals = extractSignals([call('bash', 10, true), call('bash', 10, true)]);
  const score = scoreLocal(signals);
  assert.ok(score > 5, `expected a high score, got ${score}`);
});

test('scoreLocal: disabling a weight rescales rather than silently dropping it', () => {
  const signals = extractSignals([call('bash', 10, true), call('bash', 10, true)]);
  const weights = { ...DEFAULT_WEIGHTS, errorRatio: 0, retryRatio: 0 };
  const score = scoreLocal(signals, weights);
  assert.ok(score >= 0 && score <= 10);
  assert.ok(score < scoreLocal(signals));
});

test('scoreLocal: model-request retries add a bump', () => {
  const base = extractSignals([call('read', 10)]);
  const withRetry = extractSignals([call('read', 10)], { retryEvents: 2 });
  assert.ok(scoreLocal(withRetry) > scoreLocal(base));
});

test('fuse: no semantic score falls back to local', () => {
  const result = fuse(4, undefined, false);
  assert.equal(result.difficulty, 4);
  assert.equal(result.usedSemantic, false);
});

test('fuse: a quiet local score leaves the judge verdict untouched', () => {
  // Local score at the neutral point (2) must not shift the verdict at all.
  assert.equal(fuse(2, 8, false).difficulty, 8);
  assert.equal(fuse(2, 2, false).difficulty, 2);
});

test('fuse: a hard verdict survives a quiet local score (regression)', () => {
  // The original 50/50 average turned a "9 - hardest" verdict into 4.5, which
  // mapped to `high`, so the judge could never reach `max` on its own and the
  // scheduler could only ever downgrade.
  const verdict = fuse(0, 9, false);
  assert.ok(verdict.difficulty >= 7, `a hard verdict must stay hard, got ${verdict.difficulty}`);
  assert.equal(verdict.usedSemantic, true);
});

test('fuse: local evidence modulates within a bounded band', () => {
  // The modulation is at most +/-2 around the verdict, and asymmetric in
  // practice: the neutral point is local=2, so local=0 sits 0.8 below it
  // (-1.6) while local=10 saturates the +2 cap. The contract worth pinning is
  // the BOUND and the direction, not a symmetric swing.
  const verdict = 5;
  const quiet = fuse(0, verdict, false).difficulty;
  const neutral = fuse(2, verdict, false).difficulty;
  const loud = fuse(10, verdict, false).difficulty;

  assert.equal(neutral, verdict, 'a neutral local score must not move the verdict');
  assert.ok(quiet < verdict, 'a clean turn must pull the verdict down');
  assert.ok(loud > verdict, 'a bad turn must push the verdict up');
  for (const [label, value] of [['quiet', quiet], ['loud', loud]]) {
    assert.ok(Math.abs(value - verdict) <= 2, `${label} modulation exceeded +/-2: ${value}`);
  }

  // And it must never invert the verdict across two bands: strong local
  // evidence cannot turn a hard request into a cheap one.
  assert.ok(fuse(10, 2, false).difficulty <= 4);
  assert.ok(fuse(10, 2, false).difficulty > 2);
});

test('fuse: the first turn halves local influence', () => {
  // Same inputs, less local authority before any tool history exists.
  const first = fuse(10, 5, true).difficulty;
  const later = fuse(10, 5, false).difficulty;
  assert.ok(first < later);
});

test('fuse: clamps out-of-range semantic scores', () => {
  assert.equal(fuse(2, 99, false).difficulty, 10);
  assert.equal(fuse(2, -5, false).difficulty, 0);
});

/* ---------------------------------------------------------------- *
 * L3 hysteresis — the acceptance criteria
 * ---------------------------------------------------------------- */

const cfg = { lowMax: 3, highMin: 6, confirmRounds: 2, minDwellTurns: 1 };

test('T-1 regression: the first turn must never downgrade', () => {
  // The predecessor returned `low` here because there was no tool history.
  const result = mapLevel({
    difficulty: 1,
    currentLevel: 'high',
    turn: 1,
    log: [],
    isFirstTurn: true,
    config: cfg,
  });
  assert.notEqual(result.level, 'low');
  assert.equal(result.level, 'high');
  assert.equal(result.reason, 'first-turn-no-downgrade');
});

test('T-1b: the first turn may still upgrade', () => {
  const result = mapLevel({
    difficulty: 9,
    currentLevel: 'high',
    turn: 1,
    log: [],
    isFirstTurn: true,
    config: cfg,
  });
  assert.equal(result.reason, 'confirm-pending');
});

test('T-1c: a first turn with no difficulty evidence holds at high', () => {
  const result = mapLevel({
    difficulty: 0,
    currentLevel: 'high',
    turn: 1,
    log: [],
    isFirstTurn: true,
    config: cfg,
  });
  assert.equal(result.level, 'high');
});

test('T-2: sustained low difficulty eventually downgrades', () => {
  let log = [];
  let level = 'high';
  let switched = false;
  for (let turn = 1; turn <= 4; turn += 1) {
    const result = mapLevel({ difficulty: 1, currentLevel: level, turn, log, config: cfg });
    log = result.nextLog;
    level = result.level;
    if (result.switched) switched = true;
  }
  assert.ok(switched, 'expected a downgrade after sustained evidence');
  assert.equal(level, 'low');
});

test('T-3: sustained high difficulty plus upgrade allowed reaches max', () => {
  let log = [];
  let level = 'high';
  for (let turn = 1; turn <= 4; turn += 1) {
    const result = mapLevel({
      difficulty: 9,
      currentLevel: level,
      turn,
      log,
      config: { ...cfg, allowUpgrade: true },
    });
    log = result.nextLog;
    level = result.level;
  }
  assert.equal(level, 'max', 'max must be reachable — the predecessor could never get here');
});

test('T-4: a single odd round does not cause a switch (hysteresis)', () => {
  const first = mapLevel({ difficulty: 9, currentLevel: 'high', turn: 5, log: [], config: cfg });
  assert.equal(first.level, 'high');
  assert.equal(first.reason, 'confirm-pending');

  // Second consecutive high round: now the switch is confirmed.
  const second = mapLevel({
    difficulty: 9,
    currentLevel: 'high',
    turn: 6,
    log: first.nextLog,
    config: cfg,
  });
  assert.equal(second.level, 'max');
  assert.equal(second.reason, 'switch');

  // A single contradicting round must NOT move it back.
  const third = mapLevel({
    difficulty: 1,
    currentLevel: 'max',
    turn: 7,
    log: second.nextLog,
    config: cfg,
  });
  assert.equal(third.level, 'max');
  assert.equal(third.desired, 'low');
  assert.equal(third.reason, 'confirm-pending');
});

test('T-4b: min dwell blocks an immediate reversal', () => {
  // Establish max at turn 2, then immediately want low at turn 3.
  const up = mapLevel({
    difficulty: 9,
    currentLevel: 'high',
    turn: 1,
    log: [{ difficulty: 9, level: 'max', turn: 0, injected: false }],
    config: { ...cfg, confirmRounds: 1 },
  });
  assert.equal(up.level, 'max');

  const down = mapLevel({
    difficulty: 1,
    currentLevel: 'max',
    turn: 2,
    log: up.nextLog,
    config: { ...cfg, confirmRounds: 1, minDwellTurns: 3 },
  });
  assert.equal(down.level, 'max');
  assert.equal(down.reason, 'min-dwell');
});

test('budget: allowDowngrade=false floors the scheduler at high', () => {
  let log = [];
  let level = 'high';
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = mapLevel({
      difficulty: 0,
      currentLevel: level,
      turn,
      log,
      config: { ...cfg, allowDowngrade: false },
    });
    log = result.nextLog;
    level = result.level;
  }
  assert.equal(level, 'high');
});

test('budget: allowUpgrade=false caps the scheduler at high', () => {
  let log = [];
  let level = 'high';
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = mapLevel({
      difficulty: 10,
      currentLevel: level,
      turn,
      log,
      config: { ...cfg, allowUpgrade: false },
    });
    log = result.nextLog;
    level = result.level;
  }
  assert.equal(level, 'high');
});

test('state consistency: the reported level always matches the injected one', () => {
  let log = [];
  let level = 'high';
  for (let turn = 1; turn <= 12; turn += 1) {
    const difficulty = [0, 2, 5, 8, 10, 1][turn % 6];
    const result = mapLevel({ difficulty, currentLevel: level, turn, log, config: cfg });
    assert.ok(['low', 'high', 'max'].includes(result.level));
    log = result.nextLog;
    level = result.level;
  }
  assert.ok(log.length <= 32, 'the log must stay bounded');
});

test('rank orders levels by cost', () => {
  assert.ok(rank('low') < rank('high'));
  assert.ok(rank('high') < rank('max'));
});

/* ---------------------------------------------------------------- *
 * L4 capability guard
 * ---------------------------------------------------------------- */

test('clampToEfforts: an advertised level passes through', () => {
  assert.equal(clampToEfforts('max', ['off', 'high', 'max']), 'max');
});

test('clampToEfforts: an unsupported scheduled level lifts to the highest thinking level', () => {
  // A toggle-only model advertising off/high cannot take a scheduled low.
  assert.equal(clampToEfforts('low', ['off', 'high']), 'high');
});

test('clampToEfforts: a model with no thinking level yields nothing', () => {
  assert.equal(clampToEfforts('high', []), undefined);
  assert.equal(clampToEfforts('high', ['off']), undefined);
});

test('clampToEfforts: a manual pick is stripped rather than clamped', () => {
  // The user asked for that exact level; silently changing it would lie.
  assert.equal(clampToEfforts('max', ['off', 'high'], true), undefined);
  assert.equal(clampToEfforts('high', ['off', 'high'], true), 'high');
});
