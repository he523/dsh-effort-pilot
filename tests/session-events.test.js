/**
 * Unit tests for the session-log sampling layer.
 *
 * The shapes below mirror the rc.2 host log exactly:
 *   tool/call   -> { turn, step, callId, name, arguments }  (arguments = JSON text)
 *   tool/result -> { turn, step, message, error? }
 * There is no `session.events`: the log is read through `snapshotEvents()`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextPressure,
  countRetryEvents,
  currentTurn,
  isFirstTurn,
  readEvents,
  sampleToolCalls,
  TOOL_SAMPLE_WINDOW,
} from '../lib/session-events.js';

/** A fake agent exposing only the documented accessor. */
function agentWith(events, extra = {}) {
  return {
    id: 'session-1',
    session: {
      snapshotEvents: () => events,
      ...extra,
    },
  };
}

test('readEvents: uses snapshotEvents, never session.events', () => {
  const events = [{ type: 'turn/start', data: { turn: 1 } }];
  assert.equal(readEvents(agentWith(events)).length, 1);

  // The predecessor's bug: a session that only has `.events` yields nothing.
  const legacy = { id: 's', session: { events } };
  assert.deepEqual(readEvents(legacy), []);
});

test('readEvents: survives a malformed agent without throwing', () => {
  assert.deepEqual(readEvents(undefined), []);
  assert.deepEqual(readEvents({}), []);
  assert.deepEqual(readEvents({ session: null }), []);
  assert.deepEqual(readEvents({ session: { snapshotEvents: () => { throw new Error('boom'); } } }), []);
  assert.deepEqual(readEvents({ session: { snapshotEvents: () => 'not-an-array' } }), []);
});

test('currentTurn: prefers the leaf turn/start boundary', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
  ];
  assert.equal(currentTurn(events, 1), 2);
  assert.equal(currentTurn([], 7), 7);
  assert.equal(currentTurn([], undefined), 0);
});

test('sampleToolCalls: joins a call with its result by callId', () => {
  const events = [
    { type: 'turn/start', data: { turn: 3 } },
    {
      type: 'tool/call',
      time: 1000,
      data: { turn: 3, step: 1, callId: 'c1', name: 'read', arguments: '{"file":"a.txt"}' },
    },
    {
      type: 'tool/result',
      time: 1250,
      data: { turn: 3, step: 1, callId: 'c1', message: { isError: false } },
    },
  ];
  const calls = sampleToolCalls(events, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].argsSize, '{"file":"a.txt"}'.length);
  assert.equal(calls[0].error, false);
  assert.equal(calls[0].durationMs, 250);
});

test('sampleToolCalls: detects failure from message.isError and from error', () => {
  const events = [
    { type: 'tool/call', time: 0, data: { turn: 1, callId: 'a', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', time: 1, data: { turn: 1, callId: 'a', message: { isError: true } } },
    { type: 'tool/call', time: 2, data: { turn: 1, callId: 'b', name: 'edit', arguments: '{}' } },
    { type: 'tool/result', time: 3, data: { turn: 1, callId: 'b', error: { name: 'E', code: 'X' } } },
  ];
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].error, true);
  assert.equal(calls[1].error, true);
});

test('sampleToolCalls: results without callId are attributed to the oldest unresolved call', () => {
  const events = [
    { type: 'tool/call', time: 0, data: { turn: 1, name: 'read', arguments: '{"a":1}' } },
    { type: 'tool/call', time: 1, data: { turn: 1, name: 'grep', arguments: '{"b":2}' } },
    { type: 'tool/result', time: 2, data: { turn: 1, message: { isError: true } } },
  ];
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].error, true);
  assert.equal(calls[1].name, 'grep');
  assert.equal(calls[1].error, false);
});

test('sampleToolCalls: ignores other turns and unknown event types', () => {
  const events = [
    { type: 'tool/call', time: 0, data: { turn: 1, name: 'read', arguments: '{}' } },
    { type: 'tool/call', time: 1, data: { turn: 2, name: 'write', arguments: '{}' } },
    { type: 'assistant/message', time: 2, data: { turn: 1 } },
  ];
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
});

test('sampleToolCalls: tolerates malformed JSON arguments', () => {
  const events = [
    { type: 'tool/call', time: 0, data: { turn: 1, name: 'bash', arguments: '{not json' } },
  ];
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keys, []);
  assert.ok(calls[0].fingerprint.length > 0);
});

test('sampleToolCalls: identical calls share a fingerprint, different args do not', () => {
  const events = [
    { type: 'tool/call', time: 0, data: { turn: 1, name: 'read', arguments: '{"f":"a"}' } },
    { type: 'tool/call', time: 1, data: { turn: 1, name: 'read', arguments: '{"f":"a"}' } },
    { type: 'tool/call', time: 2, data: { turn: 1, name: 'read', arguments: '{"f":"b"}' } },
  ];
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls[0].fingerprint, calls[1].fingerprint);
  assert.notEqual(calls[1].fingerprint, calls[2].fingerprint);
});

test('sampleToolCalls: window is bounded', () => {
  const events = [];
  for (let i = 0; i < TOOL_SAMPLE_WINDOW + 10; i += 1) {
    events.push({ type: 'tool/call', time: i, data: { turn: 1, name: `t${i}`, arguments: '{}' } });
  }
  const calls = sampleToolCalls(events, 1);
  assert.equal(calls.length, TOOL_SAMPLE_WINDOW);
  // Oldest first: the retained samples are the newest ones.
  assert.equal(calls[calls.length - 1].name, `t${TOOL_SAMPLE_WINDOW + 9}`);
});

test('sampleToolCalls: an explicit window overrides the default', () => {
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push({ type: 'tool/call', time: i, data: { turn: 1, name: `t${i}`, arguments: '{}' } });
  }
  assert.equal(sampleToolCalls(events, 1, 3).length, 3);
  assert.equal(sampleToolCalls(events, 1, 3)[2].name, 't9');
  // A nonsensical window falls back to the default rather than yielding nothing.
  assert.equal(sampleToolCalls(events, 1, 0).length, TOOL_SAMPLE_WINDOW);
  assert.equal(sampleToolCalls(events, 1, -5).length, TOOL_SAMPLE_WINDOW);
  assert.equal(sampleToolCalls(events, 1, undefined).length, TOOL_SAMPLE_WINDOW);
});

test('countRetryEvents: counts model-request retries in the turn only', () => {
  const events = [
    { type: 'llm/retry', data: { turn: 1 } },
    { type: 'llm/retry', data: { turn: 1 } },
    { type: 'llm/retry', data: { turn: 2 } },
    { type: 'llm/retry-started', data: { turn: 1 } },
  ];
  assert.equal(countRetryEvents(events, 1), 2);
});

test('isFirstTurn: true until a request header exists', () => {
  assert.equal(isFirstTurn(agentWith([]), []), true);
  assert.equal(
    isFirstTurn(agentWith([{ type: 'request/header', data: {} }]), [{ type: 'request/header' }]),
    false,
  );

  // Header exposed only through the session method.
  const withHeader = agentWith([], { requestHeader: () => ({ provider: 'x' }) });
  assert.equal(isFirstTurn(withHeader, []), false);
});

test('contextPressure: derives a ratio from the newest usage record', () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 100 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 64000 } } },
  ];
  assert.equal(contextPressure(events, 128000), 0.5);
});

test('contextPressure: unknown window or usage yields zero, never a fabricated signal', () => {
  assert.equal(contextPressure([{ type: 'assistant/message', data: { usage: { inputTokens: 900 } } }], undefined), 0);
  assert.equal(contextPressure([], 1000), 0);
  assert.equal(contextPressure([{ type: 'assistant/message', data: {} }], 1000), 0);
});

test('contextPressure: clamps above the window', () => {
  const events = [{ type: 'assistant/message', data: { usage: { inputTokens: 5000 } } }];
  assert.equal(contextPressure(events, 1000), 1);
});
