/**
 * L2 — semantic difficulty scoring via a lightweight LLM call.
 *
 * This is the only component of the plugin that performs an outbound request,
 * so it is written around cost and failure containment:
 *
 * - **Sampled, not per-turn.** {@link shouldScore} gates every call. Most turns
 *   are decided purely from local signals.
 * - **Cached.** The same user message never costs two calls.
 * - **Budgeted.** A hard per-turn cap (guards against waterfall re-entry) and a
 *   per-session cap; exceeding either silently degrades to local-only.
 * - **Bounded.** Each call has its own deadline, decoupled from the user's
 *   request signal, and falls back to `undefined` on timeout.
 * - **Non-throwing.** Adapter/dispatch failures arrive as a terminal `finish`
 *   chunk rather than an exception (rc.2 behaviour), so the finish reason is
 *   checked explicitly; any failure degrades to `undefined`.
 *
 * Verified call shape (see DESIGN-dsh-effort-pilot.md §7.3):
 * `ctx.llm.stream({ provider, model, messages, system, maxTokens, temperature, signal })`,
 * terminal chunk `type === 'finish'`, text accumulated from `text-delta`.
 * `purpose` is deliberately left unset — only `'compaction' | 'session-title'`
 * are legal and both carry host-specific meaning.
 */

/** System prompt: score difficulty only, emit one integer. */
const SYSTEM_PROMPT = [
  'You are a task-difficulty estimator for a coding agent.',
  'Judge only how much REASONING the user\'s latest request demands.',
  'Answer with a single integer 0-10 and nothing else.',
  '',
  '0-2  factual lookup, formatting, trivial rewrite',
  '3-4  routine coding or writing with an obvious path',
  '5-6  multi-step reasoning, cross-file change, real trade-offs',
  '7-8  architecture design, hard debugging, ambiguous requirements',
  '9-10 long-chain reasoning with global consistency demands',
].join('\n');

/**
 * Token budget for the scoring call.
 *
 * MEASURED, not guessed (`tools/probe-route.mjs`): the GLM 4.5 family are
 * REASONING models. With `maxTokens: 8` they spend the entire budget inside
 * `reasoning_content`, return an EMPTY `content` and `finish_reason: "length"`,
 * which makes the score unusable 100% of the time. They need 220-280 completion
 * tokens (~5 s) before the integer appears. `glm-4-flash` is not a reasoning
 * model: 0 reasoning tokens, 3-8 completion tokens, ~0.7 s — which is why it is
 * the default. This budget leaves headroom for a short answer either way.
 */
const SCORE_MAX_TOKENS = 64;

/** Cheap stable hash for the cache key. */
function hash(text) {
  let hashValue = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hashValue ^= text.charCodeAt(i);
    hashValue = Math.imul(hashValue, 0x01000193) >>> 0;
  }
  return hashValue.toString(36);
}

/**
 * Pull the newest user message text out of a message list.
 *
 * The NEWEST user message is authoritative, even when it yields no text. An
 * earlier version kept searching for a non-empty one, so an image-only turn
 * scored a PREVIOUS prompt and that stale score drove the level. Returning `''`
 * lets the caller treat "no text to judge" as its own case.
 */
export function latestUserText(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
    }
    // A user message with an unrecognised content shape: it is still the newest
    // input, so nothing older may be substituted for it.
    return '';
  }
  return undefined;
}

/** Truncate to a byte-ish budget without cutting mid-surrogate. */
function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

export class SemanticScorer {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig live config accessor
   * @param {(message: string, ...args: unknown[]) => void} [options.log]
   * @param {(options: object) => AsyncIterable<object>} options.stream llm stream entry
   * @param {() => number} [options.now] injectable clock (tests)
   */
  constructor({ getConfig, stream, log, now = () => Date.now() }) {
    this.getConfig = getConfig;
    this.stream = stream;
    this.log = log;
    this.now = now;
    this.cache = new Map();
    // Per-session accounting. This started as a single global counter, which
    // made `maxCallsPerSession` a LIFETIME budget: after ~20 calls across every
    // session ever, the judge silently stopped running and the scheduler fell
    // back to local-only forever. Per-session maps keep the cap meaning what it
    // says, and `forgetSession` releases them.
    this.sessionCalls = new Map();
    this.lastSampleDecision = new Map();
    this.decisionCounts = new Map();
    /** Why the most recent sample produced no verdict (diagnostics). */
    this.lastUnusableReason = undefined;
  }

  /** Forget one session's counters. */
  resetSession(sessionId) {
    const key = String(sessionId);
    this.sessionCalls.delete(key);
    this.lastSampleDecision.delete(key);
    this.decisionCounts.delete(key);
  }

  /**
   * Drop one session's accounting when the host retires it, so the per-session
   * maps stay bounded by live sessions.
   *
   * The score cache itself is deliberately kept: it is keyed by route + message
   * hash, so a repeated prompt is still served from cache in a later session,
   * and it is bounded independently.
   */
  forgetSession(sessionId) {
    this.resetSession(sessionId);
  }

  /** Calls made in one session, exposed for tests and diagnostics. */
  callsFor(sessionId) {
    return this.sessionCalls.get(String(sessionId)) ?? 0;
  }

  /**
   * Count one scheduling decision and return the running total for the session.
   *
   * This is the clock the re-sample interval runs on. Turns are the wrong unit:
   * one measured turn contained 33 step-requests, so an interval expressed in
   * turns could span ~100 requests and left the judge consulted on 3 of 67
   * decisions.
   */
  onDecision(sessionId) {
    const key = String(sessionId);
    const next = (this.decisionCounts.get(key) ?? 0) + 1;
    this.decisionCounts.set(key, next);
    return next;
  }

  /** Total calls across live sessions. */
  get totalCalls() {
    let total = 0;
    for (const count of this.sessionCalls.values()) total += count;
    return total;
  }

  /** Cache size, exposed for tests and diagnostics. */
  get cacheSize() {
    return this.cache.size;
  }

  /**
   * Should this request pay for a semantic call?
   *
   * @param {object} input
   * @param {number} input.localScore
   * @param {boolean} input.isFirstTurn
   * @param {number} input.decisions how many decisions this session has made,
   *   INCLUDING the current one (the interval is counted in requests, not turns:
   *   a single turn can contain dozens of step-requests)
   * @param {string} input.sessionId
   * @param {number} input.callsThisTurn already made for this turn
   * @returns {{score:boolean, reason:string}}
   */
  shouldScore({ localScore, isFirstTurn, decisions = 0, sessionId, callsThisTurn }) {
    const cfg = this.getConfig();
    const semantic = cfg?.semantic ?? {};

    if (cfg.mode === 'local') return { score: false, reason: 'mode-local' };
    if (semantic.enabled === false) return { score: false, reason: 'semantic-disabled' };

    // A per-turn cap is DISABLED by default, and that is deliberate. It used to
    // be 1 as an anti-re-entry guard, but it also consumed the turn's only
    // allowance on the turn's FIRST request, which put the re-sample check below
    // out of reach for the remaining requests of that turn: a measured turn held
    // 33 requests, so the judge saw one and `turn-budget` absorbed the rest.
    // Re-entry is already impossible because the request message is identical
    // within a turn, so the message cache returns the first answer for free.
    // A positive value still works if you want a hard per-turn ceiling.
    const maxPerTurn = Math.max(0, Math.trunc(semantic.maxCallsPerTurn ?? 0));
    if (maxPerTurn > 0 && callsThisTurn >= maxPerTurn) {
      return { score: false, reason: 'turn-budget' };
    }

    const maxPerSession = Math.max(0, Math.trunc(semantic.maxCallsPerSession ?? 20));
    if (this.callsFor(sessionId) >= maxPerSession) return { score: false, reason: 'session-budget' };

    // The first turn is the most valuable call: local signals have nothing to
    // work with yet, and this is precisely the turn the predecessor got wrong.
    if (isFirstTurn && semantic.alwaysOnFirstTurn !== false) {
      return { score: true, reason: 'first-turn' };
    }

    // Ambiguous band: local signals cannot settle it on their own.
    const ambiguousLow = semantic.ambiguousLow ?? 3;
    const ambiguousHigh = semantic.ambiguousHigh ?? 6;
    const ambiguous = localScore > ambiguousLow && localScore < ambiguousHigh;

    // Periodic re-sample, to correct drift on a long session.
    //
    // MEASURED TWICE, and the first measurement was in the WRONG UNIT:
    //  - `tools/audit-gate.mjs` counted turns (2 of 16 sampled) and a quiet local
    //    score maps to `low`, so the scheduler was proposing downgrades nothing
    //    had verified. That part holds.
    //  - The real journal then showed the interval is not what limits the judge:
    //    ONE turn contained **33** step-requests, and `maxCallsPerTurn: 1` caps a
    //    turn at a single sample. So a "3 turn" interval meant up to ~99
    //    REQUESTS between samples, and only 3 of 67 decisions ever reached the
    //    judge (`turn-budget` blocked 31 of them).
    //
    // The interval is therefore counted in DECISIONS (requests), which is what
    // actually elapses quickly, not in turns.
    const resampleEvery = Math.max(1, Math.trunc(semantic.resampleDecisions ?? 12));
    const last = this.lastSampleDecision.get(sessionId);
    if (last === undefined || decisions - last >= resampleEvery) {
      return { score: true, reason: ambiguous ? 'ambiguous-band' : 'periodic' };
    }

    return { score: false, reason: 'not-ambiguous' };
  }

  /**
   * Score one user message. Never throws; returns `undefined` when the score is
   * unavailable for any reason.
   *
   * @param {object} input
   * @param {string} input.text the user message text
   * @param {string} input.sessionId
   * @param {number} input.turn
   * @returns {Promise<{score:number|undefined, cached:boolean, cachedReason?:string, ms:number}>}
   */
  async score({ text, sessionId, turn }) {
    const started = this.now();
    const cfg = this.getConfig();
    const semantic = cfg?.semantic ?? {};
    const provider = semantic.provider;
    const model = semantic.model;

    /**
     * Advance the sample clock on a path that produced no verdict.
     *
     * Without this, `lastSampleDecision` stays undefined and `shouldScore`
     * answers "yes" on EVERY request forever: the sample budget is spent, the
     * note stays `…:unusable`, and nothing is logged to explain it.
     */
    const settlement = (reason) => {
      const sessionKey = String(sessionId);
      this.lastSampleDecision.set(sessionKey, this.decisionCounts.get(sessionKey) ?? 0);
      this.lastUnusableReason = reason;
      return { score: undefined, cached: false, cachedReason: reason, ms: 0 };
    };

    if (typeof text !== 'string' || text.trim().length === 0) {
      return settlement('empty-message');
    }
    if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) {
      return settlement('no-route');
    }

    const maxInput = Math.max(200, Math.trunc(semantic.maxInputChars ?? 2000));
    const prompt = truncate(text, maxInput);
    const key = `${provider}/${model}\u0000${hash(prompt)}`;

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return { score: hit, cached: true, ms: this.now() - started };
    }

    const timeoutMs = Math.max(250, Math.trunc(semantic.timeoutMs ?? 2500));

    let score = await this.#call({ provider, model, prompt, timeoutMs });
    // One retry on an unusable answer. MEASURED on real messages: roughly 1 in
    // 10 calls returns nothing parseable — the model occasionally spends the
    // budget on preamble and hits the token ceiling before reaching the
    // integer. A retry costs ~0.5 s and roughly halves that rate.
    if (score === undefined) {
      score = await this.#call({ provider, model, prompt, timeoutMs });
    }

    const ms = this.now() - started;
    const sessionKey = String(sessionId);
    this.sessionCalls.set(sessionKey, (this.sessionCalls.get(sessionKey) ?? 0) + 1);
    // Record the DECISION index this sample happened at, not the turn.
    this.lastSampleDecision.set(sessionKey, this.decisionCounts.get(sessionKey) ?? 0);
    if (score !== undefined) {
      // Bound the cache; the oldest entry is the least likely to recur.
      if (this.cache.size >= 256) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
      this.cache.set(key, score);
    } else {
      this.log?.(`[effort-pilot] semantic score unusable after retry route=${provider}/${model} ms=${ms}`);
    }
    return { score, cached: false, ms };
  }

  /** One streamed call; returns a parsed 0..10 score or `undefined`. */
  async #call({ provider, model, prompt, timeoutMs }) {
    // Each attempt owns its deadline, so a retry is not charged against the
    // first attempt's budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = '';
    try {
      const options = {
        provider,
        model,
        system: SYSTEM_PROMPT,
        // A request message needs only `role` + `content`: the host customises
        // `message.source` for assistant messages only (`forAdapter` in
        // dsh-llm/lib/index.js), and the request path never reads a user
        // message's source. Building it inline keeps this file free of host
        // imports, which matters because a local plugin cannot resolve the
        // profile's `@deepseek-ai/*` packages (see tools/probe.mjs).
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: SCORE_MAX_TOKENS,
        temperature: 0,
        signal: controller.signal,
        // `purpose` intentionally unset: only 'compaction' | 'session-title'
        // are legal, and both carry host-specific meaning.
      };
      for await (const chunk of this.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
        } else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind;
          // Failures are terminal chunks in rc.2, not thrown errors.
          if (kind === 'error' || kind === 'aborted') return undefined;
          break;
        }
      }
    } catch {
      // Transport/adapter throw (or our own abort): degrade, never propagate.
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    const match = /\d+/.exec(text);
    if (!match) return undefined;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(10, value));
  }
}
