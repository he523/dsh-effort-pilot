/**
 * Append-only decision journal.
 *
 * WHY THIS EXISTS: DSH keeps no runtime log file — `%APPDATA%\@deepseek-ai\
 * dsh-desktop\logs\` holds only `crash-*-host.log`. The plugin's per-request
 * decision line therefore goes to the host's stdout and is lost, which makes the
 * scheduler's behaviour impossible to review after the fact and impossible to
 * tune from evidence. This records the same line to a small file the user can
 * read.
 *
 * WRITES ARE SYNCHRONOUS ON PURPOSE. An earlier queue-based version buffered
 * through promises and silently dropped every line unless a caller flushed it —
 * and `apply()` deliberately exposes no handle to flush, so in practice the
 * journal was empty. These are sub-100-byte appends once per request on a local
 * file; the synchronous write is cheaper than the bookkeeping needed to make an
 * asynchronous one reliable, and it survives an abrupt process exit.
 *
 * Failure-tolerant by construction: journaling must never break a request, so
 * every error is swallowed and the journal disables itself after the first
 * failure instead of retrying on each request.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Rotate once the journal passes this size, keeping one previous file. */
const MAX_BYTES = 1_000_000;

/**
 * Open a journal at `$DSH_HOME/effort-pilot.log`.
 *
 * @param {string} [path] override, mainly for tests
 * @returns {{write: (line: string) => void, flush: () => void, path: string}}
 */
export function openJournal(path) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const target = path ?? join(home, 'effort-pilot.log');

  let disabled = false;
  let ready = false;
  /** Bytes appended since the last size check, so rotation is not once-only. */
  let sinceCheck = 0;

  const prepare = () => {
    if (ready) return true;
    try {
      mkdirSync(dirname(target), { recursive: true });
      try {
        if (statSync(target).size > MAX_BYTES) renameSync(target, `${target}.1`);
      } catch {
        // No file yet: nothing to rotate.
      }
      ready = true;
      return true;
    } catch {
      disabled = true;
      return false;
    }
  };

  /**
   * Rotate when the journal has grown past the cap.
   *
   * Checked every `CHECK_EVERY` bytes rather than on every write: `statSync` per
   * request is waste, and batching keeps the check amortised. Doing this inside
   * `prepare()` was a defect — `prepare()` returns early once ready, so rotation
   * ran only on the first write of the process and a long-lived host appended
   * past the cap forever.
   */
  const CHECK_EVERY = 64 * 1024;
  const maybeRotate = (added) => {
    sinceCheck += added;
    if (sinceCheck < CHECK_EVERY) return;
    sinceCheck = 0;
    try {
      if (statSync(target).size > MAX_BYTES) renameSync(target, `${target}.1`);
    } catch {
      // The file vanished or is locked: keep appending rather than disabling.
    }
  };

  return {
    path: target,
    write(line) {
      if (disabled) return;
      if (!prepare()) return;
      const text = `${line}\n`;
      try {
        appendFileSync(target, text, 'utf8');
        maybeRotate(Buffer.byteLength(text, 'utf8'));
      } catch {
        // Never propagate: disable and carry on.
        disabled = true;
      }
    },
    /** No-op kept so callers can express "and make sure it is on disk". */
    flush() {},
  };
}

/**
 * Should journaling be on?
 *
 * Defaults to on, because the plugin is otherwise unobservable; `config.journal`
 * turns it off for users who do not want the file.
 */
export function journalEnabled(config) {
  return config?.journal !== false;
}
