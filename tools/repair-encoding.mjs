/**
 * Repair the mojibake left by an earlier in-place PowerShell edit.
 *
 * Cause: a `-replace` pass was run through `Set-Content` with an encoding that
 * reinterpreted UTF-8 bytes as GBK, so an em dash (U+2014) became U+95C1/U+95C2
 * and U+2026 became U+9225. Ten occurrences, all inside comments — harmless to
 * the code, but it destroys the readability of the very comments that explain
 * the tricky decisions, so they are worth fixing.
 *
 * Only these three code points are mapped, and only in the affected files, so
 * this cannot silently rewrite genuine Chinese text.
 *
 * Usage:  node tools/repair-encoding.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** UTF-8 byte sequences misread as GBK, mapped back to what was intended. */
const REPAIRS = [
  { from: '\u95c1', to: '\u2014' }, // em dash variants
  { from: '\u95c2', to: '\u2014' },
  { from: '\u9225', to: '\u2026' }, // horizontal ellipsis
];

const FILES = ['lib/index.js', 'tests/scorer.test.js'];
const checkOnly = process.argv.includes('--check');

let total = 0;

for (const file of FILES) {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  let after = before;
  const counts = [];

  for (const { from, to } of REPAIRS) {
    const hits = after.split(from).length - 1;
    if (hits > 0) {
      counts.push(`${hits}x U+${from.codePointAt(0).toString(16)}`);
      after = after.split(from).join(to);
      total += hits;
    }
  }

  if (counts.length === 0) {
    console.log(`  ok   ${file} — clean`);
    continue;
  }
  if (checkOnly) {
    console.log(`  FAIL ${file} — ${counts.join(', ')}`);
    continue;
  }
  writeFileSync(path, after, 'utf8');
  console.log(`  fixed ${file} — ${counts.join(', ')}`);
}

if (checkOnly) {
  console.log(total === 0 ? 'no mojibake found' : `${total} mojibake character(s) present`);
  process.exit(total === 0 ? 0 : 1);
}
console.log(total === 0 ? 'nothing to repair' : `repaired ${total} character(s)`);
