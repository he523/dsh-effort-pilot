/**
 * Publish the scheduler's current level for our OWN UI chip.
 *
 * WHY A FILE: the client half is a CLIENT PLUGIN rendering into a slot, so it
 * cannot read the host's state directly and the host cannot render. A file
 * written by the host and served back over a read-only route is the channel, and
 * it survives a page reload: the chip shows the last decision immediately instead
 * of waiting for a new one.
 *
 * This module is deliberately self-contained — it does NOT touch any other
 * plugin's state. (An earlier design published for the whale widget and had to
 * reach into that widget's files; this replaces it.)
 *
 * Writes are atomic (temp + rename) because the page polls once a second and
 * must never read a half-written file.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The published state file name, shared with the chip route. */
export const STATE_FILE = '.dsh-effort-state.json';

/**
 * Resolve the state file path.
 *
 * Read at call time rather than cached, so a test (or a user) can redirect
 * `DSH_HOME` after the module is loaded.
 */
export function statePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, STATE_FILE);
}

/**
 * Publish one decision.
 *
 * Never throws: a failed publish must not affect a request. Returns the outcome
 * so callers (and tests) can see whether it worked.
 *
 * @param {object} state
 * @param {string} state.level chosen level
 * @param {string} [state.provider]
 * @param {string} [state.model]
 * @param {number} [state.turn]
 * @param {number} [state.difficulty]
 * @param {number} [state.localScore]
 * @param {number} [state.semanticScore]
 * @param {string} [state.reason]
 * @returns {{ok: boolean, path: string, error?: string}}
 */
export function publish(state) {
  const path = statePath();
  const payload = {
    ok: true,
    // The chip compares `ts` to decide whether this is a new decision; it also
    // uses it to detect a stale publish. Milliseconds need no protocol.
    ts: Date.now(),
    level: String(state?.level ?? 'unknown'),
    provider: state?.provider === undefined ? undefined : String(state.provider),
    model: state?.model === undefined ? undefined : String(state.model),
    turn: Number.isFinite(state?.turn) ? Number(state.turn) : undefined,
    difficulty: Number.isFinite(state?.difficulty) ? Number(state.difficulty) : undefined,
    localScore: Number.isFinite(state?.localScore) ? Number(state.localScore) : undefined,
    semanticScore: Number.isFinite(state?.semanticScore) ? Number(state.semanticScore) : undefined,
    reason: state?.reason === undefined ? undefined : String(state.reason),
  };

  const body = `${JSON.stringify(payload)}\n`;
  const temp = `${path}.${process.pid}.tmp`;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, body, 'utf8');
    // Atomic on the same filesystem: the reader sees the old or the new file,
    // never a partial one.
    renameSync(temp, path);
    return { ok: true, path };
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp file may not exist; nothing to clean */
    }
    return { ok: false, path, error: String(error?.message ?? error) };
  }
}

/**
 * Remove the published state, so the chip hides and a later run starts clean.
 * Used when the plugin is disposed.
 */
export function clear() {
  try {
    rmSync(statePath(), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Should the publisher run? Enabled by default; `chip: false` turns it off. */
export function chipEnabled(config) {
  return config?.chip !== false;
}
