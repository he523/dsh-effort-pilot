/**
 * Runtime configuration overrides.
 *
 * WHY A SEPARATE FILE, and not the profile's `cordis.patch.yml`:
 * that file belongs to DSH. Parsing and rewriting it to persist UI edits would
 * risk destroying its comments and formatting, and there is no host service for
 * it — every installed plugin keeps its own state file instead. So the effective
 * configuration is layered:
 *
 *   1. the schema defaults (lib/index.js `Config`)
 *   2. the profile patch            — the user's declared baseline
 *   3. THIS FILE                    — edits made from the settings card
 *
 * Layer 3 wins, so the card can change thresholds live without touching the
 * profile, and deleting this file returns the plugin to exactly what the profile
 * declares. That property is the point: an override layer must be droppable.
 *
 * Only keys in `ALLOWED` are accepted, and each is checked for type and range
 * here as well as in the route that calls this — a corrupted overrides file must
 * never be able to push a nonsensical threshold into the scheduler.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OVERRIDES_FILE = '.dsh-effort-pilot.config.json';

/**
 * Keys the settings card may change, with their validator.
 *
 * Anything absent from this table is ignored on load and rejected on save. The
 * table is deliberately small: exposing every field invites the user to set a
 * value that a later release renames.
 */
export const ALLOWED = {
  enabled: { type: 'boolean' },
  mode: { type: 'enum', values: ['local', 'hybrid'] },
  lowMax: { type: 'number', min: 0, max: 10, integer: true },
  highMin: { type: 'number', min: 0, max: 10, integer: true },
  allowDowngrade: { type: 'boolean' },
  allowUpgrade: { type: 'boolean' },
  respectManual: { type: 'boolean' },
  advertiseAuto: { type: 'boolean' },
  journal: { type: 'boolean' },
  window: { type: 'number', min: 1, max: 64, integer: true },
  confirmRounds: { type: 'number', min: 1, max: 32, integer: true },
  minDwellTurns: { type: 'number', min: 0, max: 100, integer: true },
  // `chip` is deliberately ABSENT. It gates route registration, which happens once
  // at activation, so writing `chip: false` from the card removes the card's own
  // route on the next start: the card 404s forever, its reset button is
  // unreachable, and this override layer outranks `cordis.patch.yml`, so the
  // profile patch cannot undo it either. Recovery would be hand-editing this file.
  // A control that can lock the user out of the UI that controls it does not belong
  // in that UI — set it in the profile patch instead.
};

/** Nested keys the card may change, under `semantic` / `weights`. */
export const ALLOWED_NESTED = {
  semantic: {
    enabled: { type: 'boolean' },
    model: { type: 'string', maxLength: 64 },
    resampleDecisions: { type: 'number', min: 1, max: 1000, integer: true },
    timeoutMs: { type: 'number', min: 250, max: 30000, integer: true },
    maxCallsPerSession: { type: 'number', min: 0, max: 100000, integer: true },
    ambiguousLow: { type: 'number', min: 0, max: 10, integer: true },
    ambiguousHigh: { type: 'number', min: 0, max: 10, integer: true },
  },
};

/** Resolve the overrides path. Read at call time so tests can redirect DSH_HOME. */
export function overridesPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, OVERRIDES_FILE);
}

/**
 * Validate one value against its spec. Returns the coerced value, or undefined.
 *
 * MUST NOT THROW, and must not accept a value of the wrong TYPE.
 *
 * `Number(value)` was neither: `Number({toString: 1})` runs ToPrimitive on a
 * non-callable `toString` and raises a TypeError, and that call happened OUTSIDE
 * `save()`'s try — so a hostile body made the write route reject with no response
 * at all. `Number(null)`/`Number('')`/`Number(true)`/`Number([5])` were also
 * silently accepted as 0/0/1/5, so a request could set a threshold with a value
 * that was never a number.
 */
function coerce(value, spec) {
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (spec.type === 'enum') {
    return typeof value === 'string' && spec.values.includes(value) ? value : undefined;
  }
  if (spec.type === 'string') {
    // Accept only a real string. Coercing anything else would let an object with
    // a `toString` become the model name.
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.slice(0, spec.maxLength ?? 256);
  }
  // number: a real finite number only — no strings, no booleans, no null, no arrays.
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (spec.integer && !Number.isInteger(value)) return undefined;
  if (spec.min !== undefined && value < spec.min) return undefined;
  if (spec.max !== undefined && value > spec.max) return undefined;
  return value;
}

/**
 * Filter an arbitrary object down to the allowed keys, coercing each.
 *
 * Returns TWO lists, because "I refused this value" and "I do not manage this
 * key" are different facts and only one of them is the caller's problem:
 *
 *  - `rejected` — the key IS editable but its VALUE failed validation. A real
 *    mistake, worth showing the user.
 *  - `ignored`  — the key is not editable at all. A caller that posts the whole
 *    live config (which contains a group this card does not own) would otherwise
 *    receive a list of "rejected keys" on every SUCCESSFUL save, which trains the
 *    user to ignore the warning that actually matters.
 *
 * @returns {{clean: object, rejected: string[], ignored: string[]}}
 */
export function sanitise(input) {
  const clean = {};
  const rejected = [];
  const ignored = [];
  const source = input && typeof input === 'object' ? input : {};

  for (const [key, value] of Object.entries(source)) {
    // `Object.hasOwn`, NOT `ALLOWED[key]`. An unguarded lookup walks the
    // prototype chain, so `constructor`, `valueOf`, `toString`, `hasOwnProperty`
    // and friends each resolved to a real function and were therefore treated as
    // valid specs — specs with no `type`, no bounds and no integer check. That let
    // keys the whitelist forbids reach the stored file and the live config.
    const spec = Object.hasOwn(ALLOWED, key) ? ALLOWED[key] : undefined;
    if (spec) {
      const coerced = coerce(value, spec);
      if (coerced === undefined) rejected.push(key);
      else clean[key] = coerced;
      continue;
    }
    const nested = Object.hasOwn(ALLOWED_NESTED, key) ? ALLOWED_NESTED[key] : undefined;
    if (nested && value && typeof value === 'object' && !Array.isArray(value)) {
      const out = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        const innerSpec = Object.hasOwn(nested, innerKey) ? nested[innerKey] : undefined;
        if (!innerSpec) {
          ignored.push(`${key}.${innerKey}`);
          continue;
        }
        const coerced = coerce(innerValue, innerSpec);
        if (coerced === undefined) rejected.push(`${key}.${innerKey}`);
        else out[innerKey] = coerced;
      }
      if (Object.keys(out).length > 0) clean[key] = out;
      continue;
    }
    ignored.push(key);
  }

  return { clean, rejected, ignored };
}

/** The stored overrides, or `{}` when the file is absent or unusable. */
export function load() {
  try {
    const parsed = JSON.parse(readFileSync(overridesPath(), 'utf8'));
    // Re-sanitise on LOAD as well: the file is user-writable, and a hand-edited
    // nonsense value must not reach the scheduler.
    return sanitise(parsed).clean;
  } catch {
    // Total by construction: a missing file, invalid JSON, and a value that makes
    // sanitise itself raise all degrade to "no overrides" rather than propagating
    // into a request path.
    return {};
  }
}

/**
 * Write the overrides atomically.
 *
 * NEVER THROWS. The `sanitise` call is inside the try on purpose: it used to sit
 * outside, so a value that made validation itself raise escaped this module's
 * error contract and the caller's async handler rejected with no response.
 * Anything that goes wrong becomes `{ok: false, error}`.
 *
 * @returns {{ok: boolean, rejected?: string[], ignored?: string[], values?: object, error?: string}}
 */
export function save(input) {
  const path = overridesPath();
  const temp = `${path}.${process.pid}.tmp`;
  let rejected = [];
  let ignored = [];
  try {
    const sanitised = sanitise(input);
    rejected = sanitised.rejected;
    ignored = sanitised.ignored;
    const clean = sanitised.clean;

    // Nothing survived validation, so there is nothing to persist. `ok: false`
    // rather than writing `{}`: `save` REPLACES the file, so an empty result would
    // silently discard every stored override. The caller decides whether an empty
    // set is meaningful (this route refuses it; a test may not care).
    if (Object.keys(clean).length === 0) {
      return { ok: false, empty: true, rejected, ignored, values: {} };
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
    return { ok: true, rejected, ignored, values: clean };
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, error: String(error?.message ?? error), rejected, ignored };
  }
}

/** Remove the overrides, returning the plugin to the profile's declared values. */
export function clear() {
  try {
    rmSync(overridesPath(), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Merge `base` (profile-declared) under `overrides`.
 *
 * Nested groups are merged one level deep so setting only `semantic.timeoutMs`
 * does not wipe the other `semantic` fields.
 */
export function merge(base, overrides) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(out[key] ?? {}), ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}
