/**
 * Unit tests for the L2 semantic scorer's containment behaviour.
 *
 * The point of these tests is not that scoring is accurate …?it is that every
 * failure mode degrades to `undefined` instead of throwing inside the request
 * waterfall, and that the cost gates actually gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { latestUserText, SemanticScorer } from '../lib/scorer.js';

const baseConfig = {
  mode: 'hybrid',
  semantic: {
    enabled: true,
    provider: 'zhipu',
    model: 'glm-4-flash',
    timeoutMs: 500,
    maxInputChars: 200,
    ambiguousLow: 3,
    ambiguousHigh: 6,
    resampleDecisions: 12,
    maxCallsPerTurn: 1,
    maxCallsPerSession: 3,
    alwaysOnFirstTurn: true,
  },
};

/** A stream that yields the given chunks (or throws). */
function streamOf(chunks) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (chunk instanceof Error) throw chunk;
        yield chunk;
      }
    },
  });
}

function makeScorer({ chunks = [], config = baseConfig } = {}) {
  return new SemanticScorer({
    getConfig: () => config,
    stream: streamOf(chunks),
    now: () => 0,
  });
}

/* ---------------------------------------------------------------- *
 * Message extraction
 * ---------------------------------------------------------------- */

test('latestUserText: takes the newest user message', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ];
  assert.equal(latestUserText(messages), 'second');
});

test('latestUserText: accepts plain string content', () => {
  assert.equal(latestUserText([{ role: 'user', content: 'plain' }]), 'plain');
});

test('latestUserText: no user message yields undefined', () => {
  assert.equal(latestUserText([{ role: 'assistant', content: [] }]), undefined);
  assert.equal(latestUserText(undefined), undefined);
});

test('latestUserText: an image-only newest message does NOT fall back to a stale prompt', () => {
  // The bug this pins: the loop used to keep searching for a message that had
  // text, so an image-only turn was scored against the PREVIOUS prompt — and that
  // stale score drove the effort level.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: [{ type: 'image', source: {} }] },
  ];
  assert.equal(latestUserText(messages), '', 'the newest message is authoritative even when it has no text');
});

test('latestUserText: a user message with an unknown content shape is still authoritative', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'older' }] },
    { role: 'user', content: { unexpected: true } },
  ];
  assert.equal(latestUserText(messages), '');
});

/* ---------------------------------------------------------------- *
 * Cost gates
 * ---------------------------------------------------------------- */

test('gate: mode local never scores', () => {
  const scorer = makeScorer({ config: { ...baseConfig, mode: 'local' } });
  assert.equal(scorer.shouldScore({ localScore: 5, isFirstTurn: true, turn: 1, sessionId: 's', callsThisTurn: 0 }).score, false);
});

test('gate: the first turn is scored by default', () => {
  const scorer = makeScorer();
  const gate = scorer.shouldScore({ localScore: 0, isFirstTurn: true, turn: 1, sessionId: 's', callsThisTurn: 0 });
  assert.equal(gate.score, true);
  assert.equal(gate.reason, 'first-turn');
});

test('gate: an unambiguous low score is not scored again', () => {
  const scorer = makeScorer();
  // Simulate a recent sample, so the re-sample rule does not apply and the gate
  // is decided by the score band alone. The interval is counted in DECISIONS.
  scorer.lastSampleDecision.set('s', 10);
  const gate = scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 11, sessionId: 's', callsThisTurn: 0 });
  assert.equal(gate.score, false);
  assert.equal(gate.reason, 'not-ambiguous');
});

test('gate: a periodic re-sample fires once the interval has elapsed', () => {
  const scorer = makeScorer();
  scorer.lastSampleDecision.set('s', 1);
  const gate = scorer.shouldScore({
    localScore: 0,
    isFirstTurn: false,
    decisions: 1 + baseConfig.semantic.resampleDecisions,
    sessionId: 's',
    callsThisTurn: 0,
  });
  assert.equal(gate.score, true);
  assert.equal(gate.reason, 'periodic');
});

test('gate: the ambiguous band is scored', () => {
  const scorer = makeScorer();
  const gate = scorer.shouldScore({ localScore: 4.5, isFirstTurn: false, decisions: 2, sessionId: 's', callsThisTurn: 0 });
  assert.equal(gate.score, true);
  assert.equal(gate.reason, 'ambiguous-band');
});

test('gate: the INTERVAL wins over the ambiguous band', () => {
  // The precedence that matters, and the one that was untested: an ambiguous local
  // score INSIDE the interval is NOT scored. The check above passes only because
  // `last` is undefined there, which makes the periodic branch fire first.
  //
  // This was worth pinning: `tools/audit-gate.mjs` once carried an extra
  // `else if (ambiguous)` branch that scored anyway, and the resulting
  // over-reported coverage was used to justify the resample tuning. A test like
  // this one would have caught the divergence immediately.
  const scorer = makeScorer();
  const { resampleDecisions } = baseConfig.semantic;
  scorer.lastSampleDecision.set('s', 10);

  const inside = scorer.shouldScore({
    localScore: 4.5, // squarely in the ambiguous band
    isFirstTurn: false,
    decisions: 10 + resampleDecisions - 1,
    sessionId: 's',
    callsThisTurn: 0,
  });
  assert.equal(inside.score, false, 'an ambiguous score must not bypass the interval');
  assert.equal(inside.reason, 'not-ambiguous');

  const due = scorer.shouldScore({
    localScore: 4.5,
    isFirstTurn: false,
    decisions: 10 + resampleDecisions,
    sessionId: 's',
    callsThisTurn: 0,
  });
  assert.equal(due.score, true, 'once the interval elapses it is scored');
  assert.equal(due.reason, 'ambiguous-band', 'and the reason names the band, not the interval');
});

test('gate: an explicit per-turn cap is enforced when set', () => {
  // The cap now defaults to 0 (disabled); a positive value still works.
  const scorer = makeScorer({ config: { ...baseConfig, semantic: { ...baseConfig.semantic, maxCallsPerTurn: 1 } } });
  const gate = scorer.shouldScore({ localScore: 4.5, isFirstTurn: false, decisions: 2, sessionId: 's', callsThisTurn: 1 });
  assert.equal(gate.score, false);
  assert.equal(gate.reason, 'turn-budget');
});

test('gate: with the per-turn cap disabled, mid-turn requests still re-sample (regression)', () => {
  // The defect: a per-turn cap of 1 consumed the turn's only allowance on the
  // turn's FIRST request, so the re-sample check was unreachable for the other
  // 32 requests of a measured 33-request turn, and `turn-budget` absorbed them.
  const scorer = makeScorer({
    config: { ...baseConfig, semantic: { ...baseConfig.semantic, resampleDecisions: 3, maxCallsPerTurn: 0 } },
  });
  scorer.lastSampleDecision.set('s', 10);

  assert.equal(
    scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 11, sessionId: 's', callsThisTurn: 2 }).score,
    false,
  );
  assert.equal(
    scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 12, sessionId: 's', callsThisTurn: 3 }).score,
    false,
  );
  const third = scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 13, sessionId: 's', callsThisTurn: 4 });
  assert.equal(third.score, true, 'a mid-turn request must be able to trigger the re-sample');
  assert.equal(third.reason, 'periodic');
});

test('gate: a QUIET local score is still re-sampled after the interval', () => {
  // Regression for the defect the real-session audit found: a quiet local score
  // maps to `low`, so skipping the judge there meant proposing downgrades with
  // nothing verifying them. The re-sample must apply to the quiet case too, not
  // only to the ambiguous band.
  const scorer = makeScorer();
  scorer.lastSampleDecision.set('s', 20);

  const soon = scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 21, sessionId: 's', callsThisTurn: 0 });
  assert.equal(soon.score, false, 'inside the interval the quiet case is not re-sampled');

  const later = scorer.shouldScore({
    localScore: 0,
    isFirstTurn: false,
    decisions: 20 + baseConfig.semantic.resampleDecisions,
    sessionId: 's',
    callsThisTurn: 0,
  });
  assert.equal(later.score, true, 'once the interval elapses the quiet case must be re-sampled');
  assert.equal(later.reason, 'periodic');
});

test('gate: the interval is measured in DECISIONS, not turns', () => {
  // Regression for the unit error: one measured turn contained 33 step-requests,
  // so a turn-based interval could span ~100 requests and left the judge
  // consulted on 3 of 67 decisions. Decisions must drive the counter.
  const scorer = makeScorer({ config: { ...baseConfig, semantic: { ...baseConfig.semantic, resampleDecisions: 3 } } });
  scorer.lastSampleDecision.set('s', 10);

  // Same turn number throughout: only the decision counter moves.
  assert.equal(scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 11, sessionId: 's', callsThisTurn: 0 }).score, false);
  assert.equal(scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 12, sessionId: 's', callsThisTurn: 0 }).score, false);
  assert.equal(scorer.shouldScore({ localScore: 0, isFirstTurn: false, decisions: 13, sessionId: 's', callsThisTurn: 0 }).score, true);
});

test('onDecision counts per session and drives the interval', () => {
  const scorer = makeScorer({ config: { ...baseConfig, semantic: { ...baseConfig.semantic, resampleDecisions: 3 } } });
  assert.equal(scorer.onDecision('a'), 1);
  assert.equal(scorer.onDecision('a'), 2);
  assert.equal(scorer.onDecision('b'), 1, 'sessions count independently');
  assert.equal(scorer.onDecision('a'), 3);
  assert.equal(scorer.onDecision('a'), 4);
  scorer.forgetSession('a');
  assert.equal(scorer.onDecision('a'), 1, 'a forgotten session starts over');
});

test('gate: the session budget is PER SESSION, not a lifetime counter', async () => {
  // Regression: `sessionCalls` was one global counter and `resetSession` was
  // never called, so the cap behaved as a lifetime budget …?after ~20 calls the
  // judge stopped running for every future session.
  const scorer = makeScorer({ config: { ...baseConfig, semantic: { ...baseConfig.semantic, maxCallsPerSession: 2 } } });

  for (let i = 0; i < 2; i += 1) {
    await scorer.score({ text: `a${i}`, sessionId: 'session-a', turn: i });
  }
  const exhausted = scorer.shouldScore({ localScore: 0, isFirstTurn: false, turn: 99, sessionId: 'session-a', callsThisTurn: 0 });
  assert.equal(exhausted.reason, 'session-budget');

  // A different session has its own allowance.
  const fresh = scorer.shouldScore({ localScore: 0, isFirstTurn: false, turn: 99, sessionId: 'session-b', callsThisTurn: 0 });
  assert.equal(fresh.score, true, 'one exhausted session must not silence another');
  assert.equal(scorer.callsFor('session-b'), 0);
  assert.equal(scorer.totalCalls, 2);
});

test('forgetSession releases one session without touching the others', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'text-delta', text: '5' }, { type: 'finish', reason: { kind: 'stop' } }] });
  await scorer.score({ text: 'x', sessionId: 'keep', turn: 1 });
  await scorer.score({ text: 'y', sessionId: 'drop', turn: 1 });
  assert.equal(scorer.totalCalls, 2);

  scorer.forgetSession('drop');
  assert.equal(scorer.callsFor('drop'), 0);
  assert.equal(scorer.callsFor('keep'), 1, 'the live session keeps its accounting');
});

test('gate: session budget degrades to local-only', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'text-delta', text: '7' }, { type: 'finish', reason: { kind: 'stop' } }] });
  for (let i = 0; i < 3; i += 1) {
    await scorer.score({ text: `message ${i}`, sessionId: 's', turn: i });
  }
  const gate = scorer.shouldScore({ localScore: 4.5, isFirstTurn: false, turn: 9, sessionId: 's', callsThisTurn: 0 });
  assert.equal(gate.score, false);
  assert.equal(gate.reason, 'session-budget');
});

/* ---------------------------------------------------------------- *
 * Failure containment …?T-6 and T-7
 * ---------------------------------------------------------------- */

test('T-7: a well-formed answer is parsed', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'text-delta', text: '8' }, { type: 'finish', reason: { kind: 'stop' } }] });
  const result = await scorer.score({ text: 'do a hard thing', sessionId: 's', turn: 1 });
  assert.equal(result.score, 8);
  assert.equal(result.cached, false);
});

test('T-7b: surrounding prose is tolerated', async () => {
  const scorer = makeScorer({
    chunks: [{ type: 'text-delta', text: 'Difficulty: 6' }, { type: 'finish', reason: { kind: 'stop' } }],
  });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).score, 6);
});

test('T-7c: unparseable output yields undefined', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'text-delta', text: 'no idea' }, { type: 'finish', reason: { kind: 'stop' } }] });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).score, undefined);
});

test('T-7d: out-of-range values are clamped', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'text-delta', text: '42' }, { type: 'finish', reason: { kind: 'stop' } }] });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).score, 10);
});

test('T-6: an error finish reason yields undefined rather than throwing', async () => {
  // rc.2 delivers adapter failures as terminal chunks, not exceptions.
  const scorer = makeScorer({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }],
  });
  const result = await scorer.score({ text: 'x', sessionId: 's', turn: 1 });
  assert.equal(result.score, undefined);
});

test('T-6b: an aborted finish reason yields undefined', async () => {
  const scorer = makeScorer({ chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: {} } }] });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).score, undefined);
});

test('T-6c: a transport throw is contained', async () => {
  const scorer = makeScorer({ chunks: [new Error('socket hang up')] });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).score, undefined);
});

test('empty or missing message never calls the model', async () => {
  const scorer = makeScorer();
  assert.equal((await scorer.score({ text: '', sessionId: 's', turn: 1 })).cachedReason, 'empty-message');
  assert.equal((await scorer.score({ text: undefined, sessionId: 's', turn: 1 })).cachedReason, 'empty-message');
});

test('a missing route never calls the model', async () => {
  const scorer = makeScorer({ config: { ...baseConfig, semantic: { ...baseConfig.semantic, provider: '' } } });
  assert.equal((await scorer.score({ text: 'x', sessionId: 's', turn: 1 })).cachedReason, 'no-route');
});

/* ---------------------------------------------------------------- *
 * Caching and privacy
 * ---------------------------------------------------------------- */

test('T-8: an identical message is served from cache', async () => {
  let calls = 0;
  const scorer = new SemanticScorer({
    getConfig: () => baseConfig,
    stream: () => {
      calls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '5' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
    now: () => 0,
  });

  const first = await scorer.score({ text: 'identical', sessionId: 's', turn: 1 });
  const second = await scorer.score({ text: 'identical', sessionId: 's', turn: 2 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.score, 5);
  assert.equal(calls, 1, 'a repeated message must not be billed twice');
});

test('the prompt sent outbound is truncated to maxInputChars', async () => {
  let sent;
  const scorer = new SemanticScorer({
    getConfig: () => baseConfig,
    stream: (options) => {
      sent = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
    now: () => 0,
  });

  const long = 'x'.repeat(5000);
  await scorer.score({ text: long, sessionId: 's', turn: 1 });
  const text = sent.messages[0].content[0].text;
  assert.ok(text.length < long.length, 'the outbound prompt must be bounded');
  assert.ok(text.length <= baseConfig.semantic.maxInputChars + 32);
});

test('the scoring call carries no purpose marker', async () => {
  let sent;
  const scorer = new SemanticScorer({
    getConfig: () => baseConfig,
    stream: (options) => {
      sent = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
    now: () => 0,
  });
  await scorer.score({ text: 'x', sessionId: 's', turn: 1 });
  assert.equal(sent.purpose, undefined);
  assert.equal(sent.temperature, 0);
  assert.equal(sent.messages[0].role, 'user');
  // The budget must leave room for a reasoning model to finish thinking before
  // it emits the integer; a tiny budget makes the answer unusable.
  assert.ok(sent.maxTokens >= 32, `maxTokens too small: ${sent.maxTokens}`);
});
