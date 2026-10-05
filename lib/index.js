/**
 * dsh-effort-pilot —?a difficulty-driven reasoning-effort scheduler.
 *
 * Replaces the tool-name heuristic approach with two layered signals:
 *
 *   L1  local, free, every turn: retry chains, tool failures, re-reads,
 *       payload growth trend, tool diversity, context pressure.
 *   L2  semantic, sampled: a cheap model rates the user request 0-10.
 *   L3  hysteresis so the level does not oscillate.
 *   L4  capability guard so an unsupported effort is never sent.
 *
 * Design: DESIGN-dsh-effort-pilot.md. Verified host contracts are cited there.
 */
import z from '@deepseek-ai/schemastery';
import { registerRoutes } from './chip-server.js';
import { load as loadOverrides, merge as mergeOverrides } from './config-overrides.js';
import { journalEnabled, openJournal } from './journal.js';
import { chipEnabled, clear as clearPublishedState, publish as publishState } from './publish-state.js';
import {
  AUTO,
  clampToEfforts,
  extractSignals,
  fuse,
  mapLevel,
  scoreLocal,
  DEFAULT_WEIGHTS,
} from './decide.js';
import {
  contextPressure,
  countRetryEvents,
  currentTurn,
  isFirstTurn,
  readEvents,
  sampleToolCalls,
} from './session-events.js';
import { latestUserText, SemanticScorer } from './scorer.js';

const NAME = 'dsh-effort-pilot';

/** The selector entry injected into every reasoning-capable model. */
const AUTO_EFFORT = { id: AUTO, name: 'Auto', description: 'Schedule low/high/max from observed difficulty.' };

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const semanticSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
  provider: z.string().default('zhipu').volatile(),
  // `glm-4-flash`, NOT `glm-4.5-flash`. Measured (tools/probe-route.mjs): the
  // 4.5 family are reasoning models that burn 220-280 tokens (~5 s) before
  // emitting the integer, which blows through any sensible deadline; 4-flash
  // answers in 3-8 tokens in ~0.7 s with no reasoning phase.
  model: z.string().default('glm-4-flash').volatile(),
  timeoutMs: z.natural().default(2500).volatile(),
  maxInputChars: z.natural().default(2000).volatile(),
  /*
   * The band in which the local score alone cannot settle the question, so the
   * semantic judge is consulted. Widened from 3..6 to 2..7 to match the
   * recalibrated score range: real local scores land in 0..2, so a 3..6 band
   * meant the judge was almost never asked and the scheduler sat on `low`.
   */
  ambiguousLow: z.number().default(2).volatile(),
  ambiguousHigh: z.number().default(7).volatile(),
  /*
   * How many REQUESTS may pass before the judge is consulted again, regardless
   * of how quiet the local signals are. THIS IS THE MAIN QUALITY DIAL.
   *
   * Counted in requests, not turns —?measured twice, and the first unit was
   * wrong:
   *  - `tools/audit-gate.mjs` counted turns and found the judge consulted on 2 of
   *    16, while a quiet local score maps to `low`, so the scheduler proposed
   *    downgrades nothing had verified.
   *  - The live journal then showed why a turn-based interval barely helps: ONE
   *    turn contained **33** step-requests, and `maxCallsPerTurn: 1` caps a turn
   *    at a single sample. A "3 turn" interval therefore spanned up to ~99
   *    requests, and the judge ran on only 3 of 67 decisions (`turn-budget`
   *    blocked 31).
   *
   * 12 requests is roughly one sample per turn on a busy turn, and a handful per
   * turn on a quiet one. The cost is measured small: 3-8 completion tokens at a
   * p50 of ~0.5 s, with the message cache and the per-session ceiling bounding
   * the rest.
   */
  resampleDecisions: z.natural().default(12).volatile(),
  /*
   * Optional hard ceiling on scoring calls per turn. 0 (the default) means no
   * ceiling, and the re-sample interval governs.
   *
   * It was 1, which looked like a harmless anti-re-entry guard but was actually
   * the thing that defeated the interval above: the turn's single allowance was
   * consumed by the turn's FIRST request, leaving the re-sample check
   * unreachable for the other 32 requests of a measured 33-request turn. The
   * guard is unnecessary because the request message is identical within a turn,
   * so the message cache serves every repeat for free.
   */
  maxCallsPerTurn: z.natural().default(0).volatile(),
  /*
   * Per-session call ceiling, raised alongside `resampleDecisions`.
   *
   * A ceiling of 20 was sized for a 10-turn interval; at an interval of 3 a
   * long session would hit it and then silently drop to local-only for the
   * rest of its life —?the exact failure the tightened interval exists to
   * prevent. 100 calls is still a few hundred tokens in total.
   */
  maxCallsPerSession: z.natural().default(100).volatile(),
  alwaysOnFirstTurn: z.boolean().default(true).volatile(),
});

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** `local` never performs an outbound request. */
  mode: z.union(['local', 'hybrid']).default('hybrid').volatile(),
  /**
   * Difficulty below this schedules `low`.
   *
   * CALIBRATED against a real session: local scores clustered in 0..2, because
   * only `retryRatio`/`errorRatio` discriminate and both are usually zero. A
   * threshold of 3 therefore downgraded 10 of 11 turns. 2 keeps `low` for a
   * genuinely clean, low-pressure session.
   */
  lowMax: z.number().default(2).volatile(),
  /**
   * Difficulty above this schedules `max`.
   *
   * CALIBRATED against the judge's MEASURED output on real messages
   * (`tools/score-sample.mjs`, 11 samples from trivial to hard): verdicts spanned
   * 0..7 and never reached 8-10, so a threshold of 8 would leave `max`
   * unreachable —?the exact failure mode this plugin exists to fix. 6 is the
   * lowest value that separates the genuinely hard samples (6-7) from the
   * routine ones (2-3).
   */
  highMin: z.number().default(6).volatile(),
  confirmRounds: z.natural().default(2).volatile(),
  minDwellTurns: z.natural().default(1).volatile(),
  window: z.natural().default(8).volatile(),
  allowDowngrade: z.boolean().default(true).volatile(),
  allowUpgrade: z.boolean().default(true).volatile(),
  /** Never touch a level the user picked by hand. */
  respectManual: z.boolean().default(true).volatile(),
  /** Advertise `Auto` in the model selector. */
  advertiseAuto: z.boolean().default(true).volatile(),
  /**
   * Write the per-request decision trail to `$DSH_HOME/effort-pilot.log`.
   *
   * On by default: DSH keeps no runtime log file, so without this the scheduler
   * is unobservable after the fact and cannot be tuned from evidence.
   */
  journal: z.boolean().default(true).volatile(),
  /**
   * Publish each decision and serve the level chip.
   *
   * Off means: no state written, no routes registered, no injection row — the
   * plugin goes back to being invisible apart from the journal.
   */
  chip: z.boolean().default(true).volatile(),
  weights: z.object({
    retryRatio: z.number().default(DEFAULT_WEIGHTS.retryRatio),
    errorRatio: z.number().default(DEFAULT_WEIGHTS.errorRatio),
    rereadRatio: z.number().default(DEFAULT_WEIGHTS.rereadRatio),
    payloadTrend: z.number().default(DEFAULT_WEIGHTS.payloadTrend),
    toolDiversity: z.number().default(DEFAULT_WEIGHTS.toolDiversity),
    contextPressure: z.number().default(DEFAULT_WEIGHTS.contextPressure),
  }).default({}),
  semantic: semanticSchema.default({}),
});

/** Read a config field that may be a live volatile ref. */
function live(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const snapshot = value.get();
    return snapshot === undefined ? fallback : snapshot;
  }
  return value === undefined ? fallback : value;
}

/** Snapshot the live config, resolving every volatile ref. */
function readConfig(config) {
  const c = config ?? {};
  const semantic = c.semantic ?? {};
  const weights = c.weights ?? {};
  return {
    enabled: live(c.enabled, true),
    mode: live(c.mode, 'hybrid'),
    lowMax: live(c.lowMax, 2),
    highMin: live(c.highMin, 6),
    confirmRounds: live(c.confirmRounds, 2),
    minDwellTurns: live(c.minDwellTurns, 1),
    window: live(c.window, 8),
    allowDowngrade: live(c.allowDowngrade, true),
    allowUpgrade: live(c.allowUpgrade, true),
    respectManual: live(c.respectManual, true),
    advertiseAuto: live(c.advertiseAuto, true),
    journal: live(c.journal, true),
    chip: live(c.chip, true),
    weights: {
      retryRatio: live(weights.retryRatio, DEFAULT_WEIGHTS.retryRatio),
      errorRatio: live(weights.errorRatio, DEFAULT_WEIGHTS.errorRatio),
      rereadRatio: live(weights.rereadRatio, DEFAULT_WEIGHTS.rereadRatio),
      payloadTrend: live(weights.payloadTrend, DEFAULT_WEIGHTS.payloadTrend),
      toolDiversity: live(weights.toolDiversity, DEFAULT_WEIGHTS.toolDiversity),
      contextPressure: live(weights.contextPressure, DEFAULT_WEIGHTS.contextPressure),
    },
    semantic: {
      enabled: live(semantic.enabled, true),
      provider: live(semantic.provider, 'zhipu'),
      model: live(semantic.model, 'glm-4-flash'),
      timeoutMs: live(semantic.timeoutMs, 2500),
      maxInputChars: live(semantic.maxInputChars, 2000),
      ambiguousLow: live(semantic.ambiguousLow, 2),
      ambiguousHigh: live(semantic.ambiguousHigh, 7),
      resampleDecisions: live(semantic.resampleDecisions, 12),
      maxCallsPerTurn: live(semantic.maxCallsPerTurn, 0),
      maxCallsPerSession: live(semantic.maxCallsPerSession, 100),
      alwaysOnFirstTurn: live(semantic.alwaysOnFirstTurn, true),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Per-session scheduling state
 * ------------------------------------------------------------------ */

/** Current level, bounded observation log, and per-turn call accounting. */
function newState() {
  return { level: 'high', log: [], turn: undefined, callsThisTurn: 0 };
}

/* ------------------------------------------------------------------ *
 * L4 —?model capability resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve the reasoning capability of one route.
 *
 * Deliberately never throws: a failure means "unknown", and unknown means the
 * scheduler's result is stripped rather than sent, which is the safe direction
 * (`UNSUPPORTED_REASONING_EFFORT` is a per-request rejection).
 *
 * Note the host's `normalizeModelInfo` OMITS `reasoning` entirely when the
 * adapter declares none, so `efforts: []` is the single "cannot take an effort"
 * signal and is treated as unknown. The host also rejects an empty efforts
 * array as invalid metadata, so a real route can never reach us that way.
 *
 * @returns {Promise<{efforts: string[], contextWindow: number|undefined}>}
 */
async function resolveCapability(llm, provider, model, cache) {
  const key = `${provider}/${model}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let capability = { efforts: [], contextWindow: undefined };
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const efforts = info?.reasoning?.efforts;
    if (Array.isArray(efforts) && efforts.length > 0) {
      capability = {
        efforts: efforts.map(effort => String(effort?.id ?? effort)).filter(Boolean),
        contextWindow: Number.isFinite(info?.context?.contextWindow) ? info.context.contextWindow : undefined,
      };
    }
  } catch {
    capability = { efforts: [], contextWindow: undefined };
  }
  cache.set(key, capability);
  return capability;
}

/* ------------------------------------------------------------------ *
 * L4b —?advertise the Auto mask in the model selector
 * ------------------------------------------------------------------ */

/**
 * Wrap every registered adapter's `resolveModel` so the returned
 * `reasoning.efforts` carry the `Auto` entry.
 *
 * Idempotent per adapter: the wrapper is tagged so a second registration pass
 * cannot stack a second copy. Adapters may register after this plugin's apply,
 * so this also runs on `llm/adapters-updated`.
 */
function advertiseAutoMask(llm, getConfig) {
  if (llm === undefined || llm === null) return;
  let registrations;
  try {
    registrations = llm.adapters?.values?.();
  } catch {
    return;
  }
  if (registrations === undefined) return;

  for (const registration of registrations) {
    const adapter = registration?.adapter;
    if (adapter === undefined || typeof adapter.resolveModel !== 'function') continue;
    if (adapter.resolveModel.__effortPilot === true) continue;

    const original = adapter.resolveModel.bind(adapter);
    const wrapped = async (provider, model, signal) => {
      const info = await original(provider, model, signal);
      if (info === null || typeof info !== 'object') return info;
      if (!getConfig().advertiseAuto) return info;
      const reasoning = info.reasoning;
      // No reasoning metadata: the route is not effort-capable at all, and the
      // selector must stay untouched (a mask here would promise what the
      // provider rejects).
      if (reasoning === undefined || reasoning === null) return info;
      const efforts = Array.isArray(reasoning.efforts) ? [...reasoning.efforts] : [];
      // An EMPTY efforts list is normally INVALID_MODEL_REASONING — a route that
      // declares reasoning but offers nothing. Appending the sentinel to it would
      // turn that invalid route into a "valid" one whose only choice is the mask,
      // so leave an empty list empty.
      if (efforts.length === 0) return info;
      if (!efforts.some(effort => String(effort?.id) === AUTO)) efforts.push(AUTO_EFFORT);
      return { ...info, reasoning: { ...reasoning, efforts } };
    };
    wrapped.__effortPilot = true;
    adapter.resolveModel = wrapped;
  }
}

/* ------------------------------------------------------------------ *
 * Plugin body
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx host context
 * @param {object} config validated plugin config
 */
export function apply(ctx, config) {
  const states = new Map();
  const capabilityCache = new Map();
  const log = (message) => ctx.logger?.info?.(message);

  /**
   * Effective configuration = profile-declared values, then stored overrides.
   *
   * The overrides come from the settings card (see lib/config-overrides.js). They
   * are re-read on every call rather than captured, so a card edit applies to the
   * very next request without a restart — and an unreadable or nonsensical
   * overrides file degrades to the profile's values instead of breaking the
   * scheduler. `readConfig` still supplies every schema default, so a partially
   * specified override group cannot leave a field undefined.
   */
  let overrides = loadOverrides();
  const getConfig = () => readConfig(mergeOverrides(config, overrides));

  /** Newest published decision, for the settings card. */
  let lastDecision;
  /** Recent semantic verdicts, bounded, for the settings card's histogram. */
  const verdicts = [];
  /** Which levels were published, for the card's distribution. */
  const stateLevelHistory = [];

  // The host keeps no runtime log, so the decision trail is written to a file
  // the user can actually read. Enabled by default; `journal: false` turns it
  // off. A journal failure disables it rather than affecting any request.
  //
  // Declared before the chip setup ON PURPOSE: chip failures reported through
  // `log()` alone were invisible, because DSH keeps no stdout log file. Every
  // failure below goes through `record` so it lands somewhere readable.
  //
  // `record` is a function declaration rather than a const so it is hoisted: the
  // decision path below is long, and a temporal-dead-zone ReferenceError inside
  // the `agent/request` waterfall would surface as a request failure.
  //
  // The journal is opened LAZILY and re-evaluated on every write, because the
  // settings card can toggle it and a value captured once here would make that
  // control a lie: the card would report "saved" while nothing changed.
  let journal;
  function record(message) {
    log(message);
    try {
      if (!journalEnabled(getConfig())) return;
      journal ??= openJournal();
      journal?.write(`${new Date().toISOString()} ${message}`);
    } catch {
      // Logging must never be able to fail a request.
    }
  }

  // ---- UI chip ----
  // The chip itself is the CLIENT half (lib/client.js), registered into the
  // composer's `conversation.input.right` slot. The host does not inject anything
  // into the page any more: it only publishes the decision (see `publishLevel`)
  // and serves it on STATE_ROUTE. The routes are registered at the END of apply()
  // — nothing here depends on the startup-time injection table.
  if (!chipEnabled(getConfig())) record('[effort-pilot] chip: disabled by config');

  /**
   * Publish a level for the UI chip, reporting failure rather than hiding it.
   *
   * Shared by BOTH decision paths on purpose: the manual-pick branch returns
   * early, so when it did not call this, the chip went stale for exactly the
   * case where the user had just touched the selector — the case where feedback
   * matters most.
   */
  function publishLevel(cfg, state) {
    // Remember the newest decision and the recent semantic verdicts. The settings
    // card needs both: a threshold is only worth moving against the distribution
    // of what the judge actually returns, not against a guess.
    lastDecision = { ...state, ts: Date.now() };
    if (Number.isFinite(state?.semanticScore)) {
      verdicts.push(Number(state.semanticScore));
      if (verdicts.length > 200) verdicts.shift();
    }
    stateLevelHistory.push(String(state?.level ?? 'unknown'));
    if (stateLevelHistory.length > 200) stateLevelHistory.shift();

    if (!chipEnabled(cfg)) return;
    const published = publishState(state);
    if (!published.ok) {
      // A silent failure would look like "the chip feature is broken".
      record(`[effort-pilot] chip publish failed: ${published.error}`);
    }
  }

  /** Load the overrides file into the closure `getConfig` reads. */
  function reloadOverrides() {
    overrides = loadOverrides();
  }

  /** Read-only snapshot for the settings card. */
  function configurationSnapshot() {
    const effective = getConfig();
    const histogram = {};
    for (const value of verdicts) histogram[value] = (histogram[value] ?? 0) + 1;
    const levels = {};
    for (const entry of stateLevelHistory) levels[entry] = (levels[entry] ?? 0) + 1;
    return {
      lastDecision,
      verdicts: {
        samples: verdicts.length,
        histogram,
        min: verdicts.length > 0 ? Math.min(...verdicts) : undefined,
        max: verdicts.length > 0 ? Math.max(...verdicts) : undefined,
      },
      levels,
      lowMax: effective.lowMax,
      highMin: effective.highMin,
    };
  }

  const scorer = new SemanticScorer({
    getConfig,
    log,
    stream: (options) => {
      const llm = ctx.get('llm');
      if (llm === undefined || llm === null) throw new Error('llm service unavailable');
      return llm.stream(options);
    },
  });

  const stateOf = (sessionId) => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = newState();
      states.set(sessionId, state);
    }
    return state;
  };

  // Capability metadata moves when the provider topology changes.
  ctx.on('llm/adapters-updated', () => {
    capabilityCache.clear();
    try {
      advertiseAutoMask(ctx.get('llm'), getConfig);
    } catch (error) {
      record(`[effort-pilot] auto mask failed: ${String(error?.message ?? error)}`);
    }
  });

  ctx.on('dispose', () => states.clear());

  // Wrapped because a throw here (a frozen/stubbed adapter, a non-writable
  // `resolveModel`) would abort plugin activation entirely — the same call inside
  // the listener above is contained by the host, so only this one needed it.
  try {
    advertiseAutoMask(ctx.get('llm'), getConfig);
  } catch (error) {
    record(`[effort-pilot] auto mask failed at activation: ${String(error?.message ?? error)}`);
  }

  ctx.on('agent/request', async (payload, next) => {
    // The built-in behaviour resolves the persisted request header. Not calling
    // it would veto the chain and force this plugin's route on every request.
    const seed = await next();

    const cfg = getConfig();
    if (!cfg.enabled) return seed;

    const agent = payload?.agent;
    const sessionId = String(agent?.id ?? 'unknown');
    const state = stateOf(sessionId);
    const llm = ctx.get('llm');
    if (llm === undefined || llm === null) return seed;

    const capability = await resolveCapability(llm, seed.provider, seed.model, capabilityCache);

    const seedEffort = seed.reasoningEffort === undefined ? undefined : String(seed.reasoningEffort);

    // A manual pick is the user asking for that exact level. `auto` is our own
    // mask and `undefined` means "no selection" —?both are ours to schedule.
    const manual = seedEffort !== undefined && seedEffort !== AUTO && seedEffort !== 'auto';
    if (manual && cfg.respectManual) {
      // Respecting a manual pick does NOT mean forwarding an impossible one:
      // the model's own rejection (`UNSUPPORTED_REASONING_EFFORT`) would fail
      // the request. An advertised level passes through untouched; one the
      // model cannot take is stripped rather than silently swapped, because the
      // user asked for that exact level.
      const kept = clampToEfforts(seedEffort, capability.efforts, true);
      state.level = kept ?? 'high';
      state.log = [];

      // Journal the manual pick ONCE per change, not once per request. The
      // scheduler did not choose this level, but "the plugin saw Auto was
      // replaced by a hand pick and stayed out of the way" is exactly the kind
      // of fact that is otherwise invisible; the previous version recorded
      // nothing here at all, so a session sitting on a manual level produced an
      // empty journal and looked like the plugin was dead.
      if (state.lastManual !== seedEffort) {
        state.lastManual = seedEffort;
        record(
          `[effort-pilot] model=${seed.provider}/${seed.model} manual=${seedEffort}`
          + ` => ${kept === undefined ? 'stripped (not advertised)' : `level=${kept} (respected)`}`,
        );
      }

      // Publish on the manual path too, so the widget reflects EVERY decision —
      // including the one the user just made by hand.
      publishLevel(cfg, {
        level: kept === undefined ? 'stripped' : kept,
        provider: seed.provider,
        model: seed.model,
        turn: payload?.turn,
        reason: kept === undefined ? 'manual-stripped' : 'manual-respected',
      });

      if (kept === undefined) {
        const stripped = { ...seed };
        delete stripped.reasoningEffort;
        return stripped;
      }
      return seed;
    }

    // Any hand pick just gave way to scheduling, so a later manual pick is a
    // fresh change worth recording.
    state.lastManual = undefined;

    const events = readEvents(agent);
    const turn = currentTurn(events, payload?.turn);
    const firstTurn = isFirstTurn(agent, events);

    if (state.turn !== turn) {
      state.turn = turn;
      state.callsThisTurn = 0;
    }

    const calls = sampleToolCalls(events, turn, cfg.window);
    const retryEvents = countRetryEvents(events, turn);
    const pressure = contextPressure(events, capability.contextWindow);
    const signals = extractSignals(calls, {
      contextPressure: pressure,
      retryEvents,
    });
    let localScore = scoreLocal(signals, cfg.weights);

    // ---- L2 ----
    // The decision counter advances on EVERY request, before any budget check, so
    // the re-sample interval really is counted in requests. Counting it inside
    // the capability branch made it a turn counter in disguise (one increment per
    // turn), which is the unit error this replaced.
    const decision = scorer.onDecision(sessionId);

    // Only worth paying for on a route that can actually take an effort: the
    // scheduler's answer would be stripped anyway.
    let semanticScore;
    let semanticNote = 'skipped';
    if (capability.efforts.length > 0) {
      const gate = scorer.shouldScore({
        localScore,
        isFirstTurn: firstTurn,
        decisions: decision,
        sessionId,
        callsThisTurn: state.callsThisTurn,
      });
      if (gate.score) {
        // The request being assembled is not yet in the payload (the waterfall
        // cannot change messages), so read the committed conversation. This is
        // exactly what the loop hands the model: `session.deriveMessages()`.
        let text;
        try {
          text = latestUserText(agent?.session?.deriveMessages?.());
        } catch {
          text = undefined;
        }
        state.callsThisTurn += 1;
        const result = await scorer.score({ text, sessionId, turn });
        semanticScore = result.score;
        semanticNote = result.score === undefined
          ? `${gate.reason}:unusable`
          : `${gate.reason}${result.cached ? ':cached' : ''}`;
      } else {
        semanticNote = gate.reason;
      }
    } else {
      semanticNote = 'no-capability';
    }

    const { difficulty, usedSemantic } = fuse(localScore, semanticScore, firstTurn);

    // ---- L3 ----
    const mapped = mapLevel({
      difficulty,
      currentLevel: state.level,
      turn,
      log: state.log,
      isFirstTurn: firstTurn,
      config: cfg,
    });
    state.log = mapped.nextLog;
    const level = mapped.level;
    state.level = level;

    // ---- L4 ----
    // `clampToEfforts` returns undefined both for a route that advertises no
    // effort at all and for one that only advertises `off`; either way the
    // field is stripped rather than risking a per-request rejection.
    const clamped = clampToEfforts(level, capability.efforts, false);
    if (clamped === undefined) {
      const stripped = { ...seed };
      delete stripped.reasoningEffort;
      record(`[effort-pilot] model=${seed.provider}/${seed.model} takes no reasoning effort; stripped`);
      return stripped;
    }

    record(
      `[effort-pilot] turn=${turn} model=${seed.provider}/${seed.model}`
      + ` calls=${signals.sampleCount} retry=${signals.retryRatio} err=${signals.errorRatio}`
      + ` reread=${signals.rereadRatio} trend=${signals.payloadTrend} div=${signals.toolDiversity}`
      + ` ctx=${signals.contextPressure}`
      + ` local=${localScore} semantic=${semanticScore === undefined ? '-' : semanticScore}(${semanticNote})`
      + ` difficulty=${difficulty} first=${firstTurn} from=${seedEffort ?? 'none'}`
      + ` => level=${clamped} (${mapped.reason}${mapped.switched ? '/switched' : ''}${usedSemantic ? '/fused' : ''})`,
    );

    // Publish for the UI chip. Only the level actually SENT is published, so the
    // chip can never show a level that the provider was not asked for.
    publishLevel(cfg, {
      level: clamped,
      provider: seed.provider,
      model: seed.model,
      turn,
      difficulty,
      localScore,
      semanticScore,
      reason: `${mapped.reason}${usedSemantic ? '/fused' : ''}`,
    });

    return { ...seed, reasoningEffort: clamped };
  }, { prepend: true });

  // Drop per-session scheduling state when the host retires the session, so the
  // map stays bounded by the number of live sessions rather than by every
  // session ever seen.
  ctx.on('session/disposed', (session) => {
    const id = String(session?.id ?? '');
    if (id.length === 0) return;
    states.delete(id);
    scorer.forgetSession(id);
  });

  // Leaving a stale level published would keep the chip showing a decision from
  // a plugin that is no longer running.
  ctx.on('dispose', () => {
    if (chipEnabled(getConfig())) clearPublishedState();
  });

  // ---- UI chip: the read-only routes ----
  // The client half polls STATE_ROUTE, so these are the plugin's only outward
  // surface. A missing `webServer` (a non-web host) simply means no chip — but
  // say so in the journal, because a silently absent route looks identical to a
  // client half that never loaded.
  if (chipEnabled(getConfig())) {
    try {
      const webServer = ctx.get('webServer');
      if (!webServer?.register) {
        record(
          `[effort-pilot] chip: no webServer service`
          + ` (got ${webServer === undefined ? 'undefined' : typeof webServer}); routes NOT registered`,
        );
      } else {
        const disposeRoutes = registerRoutes({ webServer }, {
          readConfig: getConfig,
          // The profile's declared values, so the card can distinguish "changed
          // here" from "declared in the patch" and offer a reset.
          declaredConfig: () => readConfig(config),
          reloadOverrides,
          observe: configurationSnapshot,
        });
        record('[effort-pilot] chip: routes registered');
        ctx.on('dispose', () => {
          try {
            disposeRoutes();
          } catch {
            /* already gone */
          }
        });
      }
    } catch (error) {
      // `registerRoutes` unwinds its own partial registrations before throwing,
      // so nothing is left bound here.
      record(`[effort-pilot] chip routes failed: ${String(error?.message ?? error)}`);
    }
  }
}

export { NAME as name };
// `webServer` is a real dependency of the chip routes, so it is declared instead
// of looked up optionally: an optional lookup that quietly returns undefined is
// exactly how the routes went missing without a single error.
export const inject = ['llm', 'webServer'];
