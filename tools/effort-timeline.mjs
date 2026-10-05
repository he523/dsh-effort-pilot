/**
 * Timeline of effort values in a session log.
 *
 * Answers the operational questions a replay cannot: did the user pick a level
 * by hand, did the Auto mask appear, and did anything downgrade afterwards.
 *
 * Usage:  node tools/effort-timeline.mjs <decoded.jsonl>
 */
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node tools/effort-timeline.mjs <decoded.jsonl>');
  process.exit(1);
}

const events = (await readFile(path, 'utf8'))
  .split('\n')
  .filter(line => line.trim().length > 0)
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const EFFORT_RE = /"reasoningEffort"\s*:\s*"([^"]+)"/;
const rows = [];

for (const [index, event] of events.entries()) {
  const type = String(event?.type ?? '?');
  if (!['model/selection', 'request/header', 'request/context'].includes(type)) continue;
  const text = JSON.stringify(event.data ?? {});
  const match = EFFORT_RE.exec(text);
  const turn = event.data?.turn;
  rows.push({
    index,
    type,
    turn: Number.isFinite(turn) ? turn : undefined,
    effort: match ? match[1] : '(none)',
  });
}

console.log('effort-related records in order:');
console.log('  idx  type              turn  effort');
for (const row of rows) {
  console.log(`  ${String(row.index).padStart(4)}  ${row.type.padEnd(17)} ${String(row.turn ?? '-').padStart(4)}  ${row.effort}`);
}

/* ---- request/header is the authoritative record of what was actually sent ---- */
const headers = rows.filter(row => row.type === 'request/header');
console.log(`\nrequest/header sequence (${headers.length}): ${headers.map(row => row.effort).join(' -> ')}`);

const selections = rows.filter(row => row.type === 'model/selection');
console.log(`model/selection sequence (${selections.length}): ${selections.map(row => row.effort).join(' -> ')}`);

const counts = new Map();
for (const row of headers) counts.set(row.effort, (counts.get(row.effort) ?? 0) + 1);
console.log('request/header effort histogram:', JSON.stringify(Object.fromEntries(counts)));

if (headers.some(row => row.effort === 'max')) {
  console.log('\nNOTE: `max` appears in a persisted request header.');
  console.log('A persisted header records the SEED config, so this is either a manual');
  console.log('selection (which the plugin deliberately leaves alone) or an injection');
  console.log('that was then committed. Local signals alone never reach `max` here,');
  console.log('so a semantic verdict of ~9 would be required to produce it.');
}
