/**
 * Session-log sampling for dsh-effort-pilot.
 *
 * Reads the *current turn's* tool activity out of the live session log.
 *
 * rc.2 FACTS (verified against the shipped host source, see
 * DESIGN-dsh-effort-pilot.md §7.4):
 * - The log is NOT `session.events` (that property does not exist — reading it
 *   silently yields `undefined`, which is exactly how the predecessor plugin's
 *   heuristic became dead code). It is `session.snapshotEvents()`.
 * - `tool/call.data` = `{ turn, step, callId, name, arguments }` where
 *   `arguments` is an already-JSON-serialised string.
 * - `tool/result.data` = `{ turn, step, message, error?, meta? }`; failure is
 *   `data.error` or `data.message.isError`.
 * - There is no duration field; duration is `result.time - call.time`.
 * - There is no tool-level retry event: `llm/retry` / `llm/retry-started` are
 *   model-request level.
 *
 * Every accessor is defensive: a host-side shape drift must degrade to "no
 * signal", never throw inside the request waterfall.
 */

/** How many of the current turn's tool calls to consider. */
export const TOOL_SAMPLE_WINDOW = 8;

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Read the live session event log off an agent, tolerating an absent method.
 *
 * @param {unknown} agent the `payload.agent` from the `agent/request` waterfall
 * @returns {readonly object[]} oldest first, or `[]` when unavailable
 */
export function readEvents(agent) {
  if (!isRecord(agent)) return [];
  const session = agent.session;
  if (!isRecord(session)) return [];
  // The documented accessor. Never `session.events` — see the module header.
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents();
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolve the turn currently being assembled.
 *
 * Prefers the leaf `turn/start` boundary in the log (authoritative, works even
 * when the payload's `turn` is stale by one step); falls back to the payload.
 *
 * @param {readonly object[]} events
 * @param {number|undefined} fallbackTurn
 * @returns {number}
 */
export function currentTurn(events, fallbackTurn) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      const turn = events[i]?.data?.turn;
      if (Number.isFinite(turn)) return turn;
    }
  }
  return Number.isFinite(fallbackTurn) ? fallbackTurn : 0;
}

/** Parse tool arguments as JSON, tolerating malformed model output. */
function parseArgs(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build a stable fingerprint for "the same tool doing the same thing".
 *
 * Prefers `callId`-independent content: tool name plus a canonical rendering of
 * the arguments. Falls back to name plus raw size when the arguments cannot be
 * parsed, which still catches the common "same call twice" case.
 */
function fingerprintOf(name, argsText) {
  const size = typeof argsText === 'string' ? argsText.length : 0;
  if (size === 0) return `${name}\u0000empty`;
  return `${name}\u0000${size}\u0000${hashString(argsText)}`;
}

/** Cheap non-cryptographic string hash (FNV-1a), for fingerprints only. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Sample the current turn's tool calls, joined with their outcomes.
 *
 * @param {readonly object[]} events result of {@link readEvents}
 * @param {number} turn the turn to sample
 * @param {number} [window] how many of the newest calls to keep; defaults to
 *   {@link TOOL_SAMPLE_WINDOW}. Comes from config so the sampling horizon is
 *   tunable rather than frozen in the code.
 * @returns {Array<{name:string, argsSize:number, error:boolean, durationMs:number|undefined, fingerprint:string, keys:string[]}>}
 */
export function sampleToolCalls(events, turn, window = TOOL_SAMPLE_WINDOW) {
  const limit = Number.isFinite(window) && window > 0 ? Math.trunc(window) : TOOL_SAMPLE_WINDOW;
  /** @type {Array<object>} calls awaiting a result, in production order */
  const pending = [];
  /**
   * Samples already produced.
   *
   * Bounded to `limit` as we go, instead of building one object per `tool/call` in
   * the whole turn and slicing at the end. The window is what the caller consumes,
   * so the extra allocations were pure garbage — on the request path, once per
   * request. Trimming here keeps the array at window size; the samples are still
   * the NEWEST ones, and `pending` keeps every call so result attribution (which
   * may reference a call older than the window) is unchanged.
   */
  const samples = [];

  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue;
    const data = event.data;
    if (Number.isFinite(data.turn) && data.turn !== turn) continue;

    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'tool';
      const argsText = typeof data.arguments === 'string' ? data.arguments : '';
      const parsed = parseArgs(argsText);
      const sample = {
        callId: typeof data.callId === 'string' ? data.callId : undefined,
        name,
        argsSize: argsText.length,
        error: false,
        durationMs: undefined,
        fingerprint: fingerprintOf(name, argsText),
        keys: isRecord(parsed) ? Object.keys(parsed).sort() : [],
        startedAt: Number.isFinite(event.time) ? event.time : undefined,
        resolved: false,
      };
      pending.push(sample);
      samples.push(sample);
      if (samples.length > limit) samples.shift();
      continue;
    }

    if (event.type === 'tool/result') {
      // Match by callId when the log carries one; otherwise attribute the
      // result to the oldest still-unresolved call, which is the order the
      // results were produced in. A resolved sample is flagged rather than
      // removed by key, because a call may legitimately arrive without a
      // callId and keying on `undefined` would then mis-attribute later
      // results.
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      let target;
      if (callId !== undefined) {
        target = pending.find(candidate => candidate.callId === callId && candidate.resolved !== true);
      }
      if (target === undefined) {
        target = pending.find(candidate => candidate.resolved !== true);
      }
      if (target === undefined) continue;
      target.resolved = true;

      const error =
        isRecord(data.error) ||
        (isRecord(data.message) && data.message.isError === true);
      target.error = error;
      if (Number.isFinite(event.time) && target.startedAt !== undefined) {
        target.durationMs = Math.max(0, event.time - target.startedAt);
      }
    }
  }

  // `samples` is already trimmed to `limit`, so only the projection is left.
  return samples.map(({ name, argsSize, error, durationMs, fingerprint, keys }) => ({
    name,
      argsSize,
      error,
      durationMs,
      fingerprint,
      keys,
    }));
}

/**
 * Model-request retries recorded in the current turn (`llm/retry`).
 *
 * A step-level "this is not going well" hint, independent of tool outcomes.
 */
export function countRetryEvents(events, turn) {
  let count = 0;
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue;
    if (event.type !== 'llm/retry') continue;
    if (Number.isFinite(event.data.turn) && event.data.turn !== turn) continue;
    count += 1;
  }
  return count;
}

/**
 * Whether the current turn is the session's first request.
 *
 * Anchored on the request header rather than on a turn counter: the header is
 * absent exactly until the first request has been committed, which is the
 * condition we care about.
 *
 * @param {unknown} agent
 * @param {readonly object[]} events
 */
export function isFirstTurn(agent, events) {
  for (const event of events) {
    if (event?.type === 'request/header') return false;
  }
  const session = isRecord(agent) ? agent.session : undefined;
  if (isRecord(session) && typeof session.requestHeader === 'function') {
    try {
      if (session.requestHeader() !== undefined) return false;
    } catch {
      /* fall through to the event-log verdict */
    }
  }
  return true;
}

/**
 * Context pressure in 0..1: how full the model's context window is.
 *
 * MEASURED against a real session log (`tools/validate-real-session.mjs`): the
 * `data.usage` record carries `inputTokens`, `outputTokens`, `cacheReadTokens`,
 * `cacheWriteTokens` and `totalTokens`. The cache counters DOMINATE — a live
 * session reported `inputTokens: 193` alongside `cacheReadTokens: 270080`, so
 * counting only prompt tokens made this signal read ~0.0015 and never fire in
 * practice. The cached prefix is exactly the context occupying the window, so
 * it must be included.
 *
 * `totalTokens` is deliberately NOT used: it mixes in the completion, which is
 * not part of the window the next request has to fit into.
 *
 * @param {readonly object[]} events
 * @param {number|undefined} contextWindow
 */
export function contextPressure(events, contextWindow) {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
  if (window === undefined) return 0;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.data?.usage;
    if (!isRecord(usage)) continue;
    const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
    const known = parts.filter(value => Number.isFinite(value));
    if (known.length === 0) continue;
    const used = known.reduce((sum, value) => sum + value, 0);
    return Math.max(0, Math.min(1, used / window));
  }
  return 0;
}
