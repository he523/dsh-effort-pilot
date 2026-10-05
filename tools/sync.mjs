/**
 * Make the profile's installed copy match this source tree.
 *
 * Why this exists: pnpm installs a `file:` dependency with `nodeLinker: hoisted`
 * by HARD-LINKING the source files (link count 2). An in-place write keeps the
 * link, but an editor that writes a temp file and renames breaks it — so the
 * installed copy silently goes stale. Comparing content and re-copying is the
 * only reliable way to know the host will load what you just edited.
 *
 * Usage:
 *   node tools/sync.mjs          copy changed files
 *   node tools/sync.mjs --check  report staleness only (exit 1 when stale)
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..');
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const target = join(profile, 'node_modules', 'dsh-effort-pilot');

const FILES = ['package.json', 'cordis.patch.yml', 'README.md'];
// `tests` is mirrored as well so the integration test (which must run from the
// installed copy, where the host packages resolve) is always present and current.
const DIRS = ['lib', 'tools', 'tests'];

const checkOnly = process.argv.includes('--check');

/** sha256 of a file, or undefined when it does not exist. */
async function hashOf(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Every file under `root`, as paths relative to it. */
async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)).map(child => join(entry.name, child)));
    else found.push(entry.name);
  }
  return found;
}

try {
  await stat(target);
} catch {
  console.error(`not installed: ${target}`);
  console.error('add the dependency to the profile and run pnpm install first.');
  process.exit(1);
}

const relativeFiles = [...FILES];
for (const dir of DIRS) {
  try {
    for (const file of await walk(join(source, dir))) relativeFiles.push(join(dir, file));
  } catch {
    /* directory absent in the source: nothing to sync */
  }
}

let stale = 0;
let synced = 0;
let pruned = 0;

for (const file of relativeFiles) {
  const from = join(source, file);
  const to = join(target, file);
  const [sourceHash, targetHash] = [await hashOf(from), await hashOf(to)];
  if (sourceHash === targetHash) continue;
  stale += 1;
  if (checkOnly) {
    console.log(`stale: ${file}`);
    continue;
  }
  await mkdir(dirname(to), { recursive: true });
  // Remove first: a stale hard-linked target would otherwise make `copyFile`
  // overwrite in place and keep pointing at the old inode.
  await rm(to, { force: true });
  await copyFile(from, to);
  synced += 1;
  console.log(`synced: ${file}`);
}

// Prune orphans. A file DELETED from the source would otherwise live on in the
// installed copy forever, and the host would keep loading it — a deleted debug
// script or a superseded module keeps running with nobody noticing. Only the
// mirrored directories are considered, so package-manager files are untouched.
const sourced = new Set(relativeFiles.map(file => file.split('\\').join('/')));
for (const dir of DIRS) {
  let candidates;
  try {
    candidates = await walk(join(target, dir));
  } catch {
    continue; // not present in the installed copy: nothing to prune
  }
  for (const file of candidates) {
    const relativePath = join(dir, file);
    if (sourced.has(relativePath.split('\\').join('/'))) continue;
    pruned += 1;
    if (checkOnly) {
      console.log(`orphan: ${relativePath}`);
      continue;
    }
    await rm(join(target, relativePath), { force: true });
    console.log(`pruned: ${relativePath}`);
  }
}

if (stale === 0 && pruned === 0) {
  console.log('installed copy matches the source');
} else if (checkOnly) {
  console.error(`${stale} stale, ${pruned} orphan(s) — run without --check, then restart the app`);
  process.exit(1);
} else {
  console.log(`${synced} file(s) synced, ${pruned} orphan(s) pruned — restart the app to load them`);
}
