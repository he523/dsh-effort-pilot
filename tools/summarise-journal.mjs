/**
 * Summarise the decision journal.
 *
 * The journal is the only durable record of what the scheduler did (DSH keeps no
 * runtime log). This turns it into the numbers needed to tune thresholds:
 * verdict distribution, how often the judge was consulted or skipped, how often
 * each level was chosen, and whether any budget was exhausted.
 *
 * Usage:  node tools/summarise-journal.mjs [path]
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
/** A numeric argv[2] is a window size, not a path. */
const numericArg = /^\d+$/.test(process.argv[2] ?? '');
const path = numericArg || process.argv[2] === undefined
  ? join(home, 'effort-pilot.log')
  : process.argv[2];

let text;
try {
  text = await readFile(path, 'utf8');
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(1);
}

const allLines = text.split('\n').filter(line => line.includes('[effort-pilot]'));

// The journal APPENDS across restarts, so LIFETIME totals hide whether a change
// took effect — and reading them as if they were current is exactly what made a
// working fix look broken. Reporting the newest window makes a change visible
// immediately after a restart, which is when it needs to be judged.
const WINDOW = Number(process.env.JOURNAL_WINDOW ?? (numericArg ? process.argv[2] : (process.argv[3] ?? 0)));
const lines = WINDOW > 0 ? allLines.slice(-WINDOW) : allLines;

console.log(`journal: ${path}`);
console.log(`decision lines: ${allLines.length}`);
if (WINDOW > 0) {
  console.log(`analysing the NEWEST ${lines.length} line(s) only`);
} else {
  const first = /^(\S+)/.exec(allLines[0])?.[1] ?? '?';
  const last = /^(\S+)/.exec(allLines[allLines.length - 1])?.[1] ?? '?';
  console.log(`spanning ${first} .. ${last}`);
  console.log('NOTE: these totals ACCUMULATE across restarts. After a restart pass a');
  console.log('      window (e.g. `... 40`) so a stale pre-restart tally cannot be');
  console.log('      mistaken for current behaviour.');
}
console.log('');

const verdicts = [];
const noteCounts = new Map();
const reasonCounts = new Map();
const levelCounts = new Map();
const semanticUsable = { yes: 0, no: 0 };
let manualLines = 0;

/**
 * Extract `semantic=<value>(<note>)`.
 *
 * Handles `semantic=3(periodic)` and the skipped `semantic=-(note)`. An earlier
 * version used a blanket regex that matched the `semantic=` label itself and so
 * reported every line as a usable score, which hid the real coverage (3 of 67).
 */
function parseSemantic(line) {
  const match = /semantic=(-?\d+|-)(?:\(([^)]*)\))?/.exec(line);
  if (match === null) return { value: undefined, note: 'absent' };
  if (match[1] === '-') return { value: undefined, note: match[2] ?? '?' };
  const value = Number(match[1]);
  return { value: Number.isFinite(value) ? value : undefined, note: match[2] ?? '?' };
}

for (const line of lines) {
  if (/manual=/.test(line)) {
    manualLines += 1;
    continue;
  }
  const { value, note } = parseSemantic(line);
  noteCounts.set(note, (noteCounts.get(note) ?? 0) + 1);
  if (value === undefined) {
    semanticUsable.no += 1;
  } else {
    semanticUsable.yes += 1;
    verdicts.push(value);
  }

  const level = /=>\s*level=(\S+)/.exec(line)?.[1];
  if (level !== undefined) levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);

  const reason = /\(([a-z-]+)(?:\/|\))/.exec(line.slice(line.indexOf('=> level=')))?.[1];
  if (reason !== undefined) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
}

console.log(`scheduled decisions : ${lines.length - manualLines}`);
console.log(`manual-pick lines   : ${manualLines}  (one per change, not per request)`);
console.log(`judge produced a score : ${semanticUsable.yes}   skipped/unusable : ${semanticUsable.no}`);

if (verdicts.length > 0) {
  const sorted = [...verdicts].sort((a, b) => a - b);
  const dist = new Map();
  for (const v of verdicts) dist.set(v, (dist.get(v) ?? 0) + 1);
  console.log(`\nverdict distribution (${verdicts.length} samples):`);
  for (const [value, count] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(value).padStart(2)} : ${'#'.repeat(count)} (${count})`);
  }
  console.log(`  range ${sorted[0]}..${sorted[sorted.length - 1]}   p50 ${sorted[Math.floor(sorted.length / 2)]}`);
  console.log('\nwhat those verdicts imply at the current thresholds (lowMax=2, highMin=6):');
  const low = verdicts.filter(v => v < 2).length;
  const high = verdicts.filter(v => v >= 2 && v <= 6).length;
  const max = verdicts.filter(v => v > 6).length;
  const pct = n => `${((n / verdicts.length) * 100).toFixed(0)}%`;
  console.log(`  would land low  : ${low} (${pct(low)})`);
  console.log(`  would land high : ${high} (${pct(high)})`);
  console.log(`  would land max  : ${max} (${pct(max)})`);
  console.log(`\n  lowMax=3 would make 'low' = ${pct(verdicts.filter(v => v < 3).length)}`);
  console.log(`  highMin=5 would make 'max' = ${pct(verdicts.filter(v => v > 5).length)}`);
} else {
  console.log('\nno usable verdicts recorded yet');
}

console.log('\ngate notes:', JSON.stringify(Object.fromEntries([...noteCounts.entries()].sort())));
console.log('levels chosen:', JSON.stringify(Object.fromEntries(levelCounts)));
console.log('reasons:', JSON.stringify(Object.fromEntries(reasonCounts)));

const budget = [...noteCounts.keys()].filter(note => note.includes('budget'));
if (budget.length > 0) {
  console.log(`\n⚠ budget-related notes present: ${budget.join(', ')}`);
  console.log('  `session-budget` means the judge stopped running for that session.');
}
