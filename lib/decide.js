/**
 * Pure decision engine for dsh-effort-pilot.
 *
 * Deliberately dependency-free and side-effect-free so the whole policy is
 * unit-testable in isolation: inputs are a signal bundle, a log of past
 * observations, the live config and the model's advertised effort list; the
 * output is the level to inject plus the next log.
 *
 * DESIGN CONTRACT (see DESIGN-dsh-effort-pilot.md):
 * - P1 difficulty is NOT "cheapness". Tool names are never a difficulty input.
 * - P2 absence of information is NOT evidence of simplicity: a first turn never
 *   downgrades.
 * - P3 the defaults must not be a no-op: `max` must be reachable by default.
 * - P4 every decision is explainable: `desired`/`reason` are returned alongside
 *   the level.
 */

/** Levels this plugin understands, ordered from cheapest to most expensive. */
export const LEVELS = ['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Sentinel advertised in the model selector; never sent to a provider. */
export const AUTO = 'auto';

/**
 * How many recent decisions the state machine keeps.
 *
 * The confirmation window is bounded by it: a `confirmRounds` larger than this
 * could never be satisfied, so `mapLevel` clamps to it.
 */
const LOG_CAP = 32;

/** Coerce anything into a finite number, defaulting when it is not one. */
function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp `value` into [lo, hi]. */
export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Round to `digits` decimals, avoiding float dust in logs. */
function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/* ------------------------------------------------------------------ *
 * L1 - local signal extraction
 * ------------------------------------------------------------------ */

/**
 * Derive the L1 signal bundle from one step's tool-call samples plus context
 * pressure.
 *
 * Every signal is normalised to [0, 1] so weights compose predictably.
 *
 * @param {Array<{name?: string, argsSize?: number, error?: boolean, durationMs?: number, fingerprint?: string}>} calls
 *   tool calls of the step being scheduled, oldest first.
 * @param {{contextPressure?: number, retryEvents?: number}} [extra]
 */
export function extractSignals(calls = [], extra = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const n = list.length;

  // S1 retry chain: a repeated (tool, args) fingerprint means the previous
  // attempt did not settle the question. Only the repeat is counted, so a step
  // that legitimately calls the same tool on different targets is not
  // penalised.
  let repeats = 0;
  const seen = new Set();
  for (const call of list) {
    const key = call.fingerprint ?? `${call.name ?? 'tool'}:${call.argsSize ?? 0}`;
    if (seen.has(key)) repeats += 1;
    else seen.add(key);
  }
  const retryRatio = n === 0 ? 0 : repeats / n;

  // S2 failure rate.
  const failures = list.filter(call => call.error === true).length;
  const errorRatio = n === 0 ? 0 : failures / n;

  // S3 re-read: repeated use of the same tool but not necessarily the same
  // arguments (revisiting something after other work). Distinct from S1.
  let revisits = 0;
  const visited = new Map();
  for (const call of list) {
    const name = call.name ?? 'tool';
    const count = visited.get(name) ?? 0;
    if (count > 0) revisits += 1;
    visited.set(name, count + 1);
  }
  const rereadRatio = n <= 1 ? 0 : revisits / (n - 1);

  // S4 payload growth TREND (not absolute size). A monotonically growing
  // payload means the task is expanding and has not converged, which is a
  // difficulty signal. An absolute threshold only measures "this command is
  // long", which is why the predecessor's `heaviest >= 3200` was misleading.
  let payloadTrend = 0;
  if (n >= 2) {
    const sizes = list.map(call => num(call.argsSize, 0));
    const increasing = sizes.slice(1).filter((size, i) => size > sizes[i]).length;
    payloadTrend = increasing / (n - 1);
  }

  // S5 tool diversity (normalised Shannon entropy).
  let toolDiversity = 0;
  if (n >= 2) {
    const counts = new Map();
    for (const call of list) {
      const name = call.name ?? 'tool';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / n;
      entropy -= p * Math.log(p);
    }
    const maxEntropy = Math.log(counts.size);
    toolDiversity = maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  // S6 context pressure: reasoning degrades under it, which is also why it
  // suppresses downgrades.
  const contextPressure = clamp(num(extra.contextPressure, 0), 0, 1);

  // Model-request retries in this step (`llm/retry`), a "this round is not
  // going well" hint independent of tool outcomes.
  const retryEvents = Math.max(0, num(extra.retryEvents, 0));

  return {
    retryRatio: round(retryRatio),
    errorRatio: round(errorRatio),
    rereadRatio: round(rereadRatio),
    payloadTrend: round(payloadTrend),
    toolDiversity: round(toolDiversity),
    contextPressure: round(contextPressure),
    retryEvents,
    sampleCount: n,
  };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/**
 * Default weights.
 *
 * CALIBRATED AGAINST A REAL SESSION, not guessed. Replaying this machine's
 * actual log through the extraction path (`tools/validate-real-session.mjs`,
 * 11 turns / 274 tool calls) showed that only two signals discriminate:
 * `retryRatio` fired in 1/11 turns and `errorRatio` in 1/11, while
 * `rereadRatio` fired in 8/11 and `payloadTrend` in 9/11 — because re-visiting a
 * tool and growing argument sizes are NORMAL in agentic work, not symptoms of
 * difficulty. Weighted as difficulty they pushed nearly every turn to the
 * `lowMax` boundary, i.e. the plugin would have downgraded a long, careful
 * engineering session almost everywhere.
 *
 * So the two evidence-bearing signals carry the score, and the three noisy ones
 * default to 0: still computed and reported in the log (they are useful
 * diagnostics, and raising a weight re-enables them without a code change), but
 * they no longer decide the level.
 *
 * `contextPressure` is not a weighted term: it is applied as a degradation
 * penalty that can only raise the score (see {@link scoreLocal}).
 */
export const DEFAULT_WEIGHTS = {
  retryRatio: 6.0,
  errorRatio: 6.0,
  rereadRatio: 0,
  payloadTrend: 0,
  toolDiversity: 0,
  contextPressure: 0,
};

/** How much full context can add to the score, at pressure 1. */
const PRESSURE_PENALTY = 2.0;

/** The local score at which the judge's verdict is taken at face value. */
const LOCAL_NEUTRAL = 2.0;

/** Most the local evidence may shift a semantic verdict, in score points. */
const LOCAL_MODULATION = 2.0;

/**
 * Turn the L1 signal bundle into a 0..10 local difficulty score.
 *
 * Weighted sum normalised by the total weight of the *available* signals, so
 * zeroing a weight rescales the score instead of silently shrinking it.
 *
 * Context pressure is added as a penalty rather than averaged in: a nearly
 * empty window is not evidence that a task is hard, but a full one is evidence
 * that reasoning is about to degrade.
 */
export function scoreLocal(signals, weights = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  let weighted = 0;
  let total = 0;

  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    if (key === 'contextPressure') continue;
    const weight = num(w[key], 0);
    if (weight <= 0) continue;
    const value = clamp(num(signals?.[key], 0), 0, 1);
    weighted += weight * value;
    total += weight;
  }

  // A model-request retry is a step-level fact rather than a ratio: each one
  // adds a fixed bump on top of the normalised score.
  const retryBump = Math.min(num(signals?.retryEvents, 0), 2) * 0.75;

  // Context degradation, always active: no config can turn it off, because a
  // full window is a fact about the request rather than a preference.
  const pressure = clamp(num(signals?.contextPressure, 0), 0, 1);
  const pressurePenalty = pressure * PRESSURE_PENALTY;

  const base = total === 0 ? 0 : (weighted / total) * 10;
  return round(clamp(base + retryBump + pressurePenalty, 0, 10));
}

/**
 * Fuse the local score with the optional semantic score.
 *
 * ORDERING MATTERS, and this is deliberately NOT a plain 50/50 average. The two
 * inputs are not on the same scale: the semantic judge rates the request 0-10
 * with a documented ladder, while the local score is built from retry/error
 * ratios that are zero in ordinary work and only reach ~2-4 on a bad turn.
 * Averaging them let a semantic "9 (hardest)" be dragged down to ~5 and land on
 * `high`, so the judge could never reach `max` on its own — the scheduler could
 * only ever downgrade.
 *
 * So the JUDGE decides and the local evidence modulates it: strong local
 * evidence may move the verdict by at most {@link LOCAL_MODULATION} points,
 * which is enough to flip one band but never enough to override the judge.
 * When there is no verdict, the local score stands alone (local-only mode).
 *
 * @param {number} localScore 0..10
 * @param {number|undefined} semanticScore 0..10, or undefined when unavailable
 * @param {boolean} isFirstTurn
 */
export function fuse(localScore, semanticScore, isFirstTurn) {
  const local = clamp(num(localScore, 0), 0, 10);
  if (semanticScore === undefined || semanticScore === null) {
    return { difficulty: round(local), usedSemantic: false };
  }
  const semantic = clamp(num(semanticScore, 0), 0, 10);

  // Local evidence nudges within +/- 2; on a first turn there is no tool
  // history yet, so its influence is halved rather than trusted.
  const scale = isFirstTurn ? 0.5 : 1;
  const modulation = clamp((local - LOCAL_NEUTRAL) / 2.5, -1, 1) * LOCAL_MODULATION * scale;

  return {
    difficulty: round(clamp(semantic + modulation, 0, 10)),
    usedSemantic: true,
  };
}

/* ------------------------------------------------------------------ *
 * Level mapping with hysteresis
 * ------------------------------------------------------------------ */

/**
 * Map a difficulty score to a level, honouring the dead zone, the dwell time
 * and the confirm-round requirement.
 *
 * The log is a bounded array of past observations:
 * `{ difficulty, level, desired, turn, injected }`, oldest first. `level` is
 * the level in force after that observation (truthful history), `desired` is
 * what the score asked for (what confirmation counts), and `injected` marks the
 * observations where the level actually changed.
 */
export function mapLevel(input) {
  const {
    difficulty,
    currentLevel,
    turn,
    log = [],
    isFirstTurn = false,
    config = {},
  } = input;

  const lowMax = num(config.lowMax, 3);
  const highMin = num(config.highMin, 6);
  const confirmRounds = Math.max(1, Math.trunc(num(config.confirmRounds, 2)));
  const minDwellTurns = Math.max(0, Math.trunc(num(config.minDwellTurns, 1)));

  // Desired level from the score.
  let desired;
  if (difficulty < lowMax) desired = 'low';
  else if (difficulty > highMin) desired = 'max';
  else desired = 'high';

  // Bounded by the user's budget switches. Done here (rather than fixed up
  // afterwards) so the state log and the injected level cannot disagree.
  let floor = 'low';
  let ceiling = 'max';
  if (config.allowDowngrade === false) floor = 'high';
  if (config.allowUpgrade === false) ceiling = 'high';
  // A floor above the ceiling is meaningless; the ceiling wins.
  if (rank(floor) > rank(ceiling)) floor = ceiling;
  desired = LEVELS[clamp(rank(desired), rank(floor), rank(ceiling))];

  const record = (level, wanted, injected) => ({
    difficulty,
    level,
    desired: wanted,
    turn,
    injected,
  });
  const push = (entries, entry) => [...entries, entry].slice(-LOG_CAP);

  const switchAt = (entries) => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].injected === true) return num(entries[i].turn, turn);
    }
    return undefined;
  };

  // P2: absence of information is not evidence of simplicity. On the first turn
  // the level may only rise, never fall.
  if (isFirstTurn && rank(desired) < rank(currentLevel)) {
    return {
      level: currentLevel,
      nextLog: push(log, record(currentLevel, desired, false)),
      switched: false,
      reason: 'first-turn-no-downgrade',
      desired,
    };
  }

  // Already where we want to be. Recorded as non-injected: the dwell timer
  // measures time since the level was last *established*, not since it was last
  // asked for, otherwise a long stay in `high` would keep re-arming it.
  if (desired === currentLevel) {
    return {
      level: currentLevel,
      nextLog: push(log, record(currentLevel, desired, false)),
      switched: false,
      reason: 'hold',
      desired,
    };
  }

  // Minimum dwell: do not switch again immediately after a switch.
  const lastSwitchTurn = switchAt(log);
  if (lastSwitchTurn !== undefined && turn - lastSwitchTurn < minDwellTurns) {
    return {
      level: currentLevel,
      nextLog: push(log, record(currentLevel, desired, false)),
      switched: false,
      reason: 'min-dwell',
      desired,
    };
  }

  // Require `confirmRounds` consecutive observations asking for the same new
  // level before actually switching. Counting `desired` (not the level in
  // force) is what makes sustained pressure accumulate: while we hold, every
  // entry still records what the score wanted.
  if (confirmRounds > 1) {
    // The log is capped at LOG_CAP entries, so a larger requirement could never be
    // satisfied and the level would sit at 'confirm-pending' forever. Clamp to
    // what the history can actually hold.
    const wanted = Math.min(confirmRounds - 1, LOG_CAP);
    const tail = log.slice(-wanted);
    const tailAgrees =
      tail.length === wanted &&
      tail.every(entry => entry.desired === desired);
    if (!tailAgrees) {
      return {
        level: currentLevel,
        nextLog: push(log, record(currentLevel, desired, false)),
        switched: false,
        reason: 'confirm-pending',
        desired,
      };
    }
  }

  return {
    level: desired,
    nextLog: push(log, record(desired, desired, true)),
    switched: true,
    reason: 'switch',
    desired,
  };
}

/** Rank a level so upgrades/downgrades are comparable. */
export function rank(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? 3 : index;
}

/* ------------------------------------------------------------------ *
 * Model capability guard
 * ------------------------------------------------------------------ */

/**
 * Clamp a scheduled level to what the model actually advertises.
 *
 * An unsupported scheduled level is lifted to the model's highest thinking
 * level, and a model advertising no thinking level at all gets nothing (the
 * call is stripped). A manual pick is NOT clamped: an explicit user choice the
 * model cannot take is stripped instead, because silently changing it would lie
 * about what was asked for.
 */
export function clampToEfforts(level, efforts, manual = false) {
  const list = Array.isArray(efforts) ? efforts : [];
  const thinking = list.filter(id => id !== 'off' && id !== AUTO);

  if (manual) return list.includes(level) ? level : undefined;

  if (list.includes(level)) return level;
  if (thinking.length === 0) return undefined;

  // Fall back to the HIGHEST advertised level by rank, not by list position.
  // The shipped adapter lists efforts ascending, so `thinking[length - 1]` happened
  // to work — but a third-party adapter listing them descending would have been
  // given its LOWEST level when the scheduler asked for `max`.
  //
  // The tie-break takes the LATER element (`rank(next) >= rank(best)`), because
  // `rank()` maps every id outside `LEVELS` to the same value: with a custom id
  // set (`quick`/`deep`/`standard`) all candidates tie, and a strict `>` would
  // leave `thinking[0]` — the lowest-positioned entry — which is the very bug this
  // replaced. Ties resolve to the last candidate, so the ascending convention is
  // preserved for unknown vocabularies.
  const highest = thinking.reduce(
    (best, id) => (rank(id) >= rank(best) ? id : best),
    thinking[0],
  );
  return highest;
}
