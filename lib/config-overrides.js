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
  chip: { type: 'boolean' },
  journal: { type: 'boolean' },
  window: { type: 'number', min: 1, max: 64, integer: true },
  confirmRounds: { type: 'number', min: 1, max: 32, integer: true },
  minDwellTurns: { type: 'number', min: 0, max: 100, integer: true },
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

/** Validate one value against its spec. Returns the coerced value, or undefined. */
function coerce(value, spec) {
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (spec.type === 'enum') {
    return spec.values.includes(value) ? value : undefined;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.slice(0, spec.maxLength ?? 256);
  }
  // number
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (spec.integer && !Number.isInteger(n)) return undefined;
  if (spec.min !== undefined && n < spec.min) return undefined;
  if (spec.max !== undefined && n > spec.max) return undefined;
  return n;
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
    const spec = ALLOWED[key];
    if (spec) {
      const coerced = coerce(value, spec);
      if (coerced === undefined) rejected.push(key);
      else clean[key] = coerced;
      continue;
    }
    const nested = ALLOWED_NESTED[key];
    if (nested && value && typeof value === 'object') {
      const out = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        const innerSpec = nested[innerKey];
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
    return {};
  }
}

/**
 * Write the overrides atomically.
 *
 * @returns {{ok: boolean, rejected?: string[], error?: string}}
 */
export function save(input) {
  const { clean, rejected, ignored } = sanitise(input);
  const path = overridesPath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
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
