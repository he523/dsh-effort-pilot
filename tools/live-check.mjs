/**
 * Live check: is the plugin actually shaping requests, and with what levels?
 *
 * Reads a decoded session JSONL and reports every trace of a reasoning effort
 * plus the model-selection / request-header records that carry it, then replays
 * the same turns through the plugin's own decision path so the observed value
 * can be compared with the expected one.
 *
 * Usage:  node tools/live-check.mjs <decoded.jsonl>
 */
import { readFile } from 'node:fs/promises';

import { fuse, mapLevel, scoreLocal, extractSignals } from '../lib/decide.js';
import {
  contextPressure,
  countRetryEvents,
  currentTurn,
  isFirstTurn,
  readEvents,
  sampleToolCalls,
} from '../lib/session-events.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node tools/live-check.mjs <decoded.jsonl>');
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

console.log(`events: ${events.length}`);

const turns = [...new Set(
  events.filter(event => event?.type === 'turn/start').map(event => event.data?.turn),
)].filter(Number.isFinite).sort((a, b) => a - b);
console.log(`turns: ${turns.length} (${turns[0]}..${turns[turns.length - 1]})`);

/* ---- any trace of an effort in the log ---- */
const EFFORT_RE = /"reasoningEffort"\s*:\s*"([^"]+)"/g;
const mentions = events.filter(event => JSON.stringify(event).includes('reasoningEffort'));
console.log(`\nevents mentioning reasoningEffort: ${mentions.length}`);
const byType = new Map();
const values = new Map();
for (const event of mentions) {
  byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  const text = JSON.stringify(event);
  for (const match of text.matchAll(EFFORT_RE)) {
    values.set(match[1], (values.get(match[1]) ?? 0) + 1);
  }
}
console.log('  by event type:', JSON.stringify(Object.fromEntries(byType)));
console.log('  values seen  :', values.size === 0 ? '(none)' : JSON.stringify(Object.fromEntries(values)));

/* ---- model selection and request header carry the persisted choice ---- */
for (const type of ['model/selection', 'request/context', 'request/header']) {
  const found = events.filter(event => event?.type === type);
  if (found.length === 0) continue;
  const last = found[found.length - 1];
  const preview = JSON.stringify(last.data);
  console.log(`\nlast ${type} (${found.length} total):`, preview.slice(0, 300));
}

/* ---- replay through the plugin's own path ---- */
const agent = { id: 'live', session: { snapshotEvents: () => events } };
const contextEvent = [...events].reverse().find(event => event?.type === 'request/context');
const contextWindow = Number.isFinite(contextEvent?.data?.contextWindow) ? contextEvent.data.contextWindow : undefined;
console.log(`\ncontextWindow: ${contextWindow ?? 'unknown'}`);
console.log(`currentTurn(): ${currentTurn(events, undefined)}   isFirstTurn(): ${isFirstTurn(agent, events)}`);

console.log('\n  turn  calls  local  retry   err   ctx   localLevel');
const observed = [];
for (const turn of turns.slice(-14)) {
  const samples = sampleToolCalls(events, turn);
  const signals = extractSignals(samples, {
    contextPressure: contextPressure(events, contextWindow),
    retryEvents: countRetryEvents(events, turn),
  });
  const local = scoreLocal(signals);
  const mapped = mapLevel({
    difficulty: local,
    currentLevel: 'high',
    turn,
    log: [],
    isFirstTurn: false,
    config: { lowMax: 2, highMin: 7, confirmRounds: 1, minDwellTurns: 0 },
  });
  observed.push({ turn, local, level: mapped.level });
  console.log(
    `  ${String(turn).padStart(4)}  ${String(samples.length).padStart(5)}  ${String(local).padStart(5)}`
    + `  ${String(signals.retryRatio).padStart(5)}  ${String(signals.errorRatio).padStart(4)}`
    + `  ${String(signals.contextPressure).padStart(4)}   ${mapped.level}`,
  );
}

/* ---- what the judge's verdict would have to be to move the needle ---- */
console.log('\nwhat a semantic verdict would produce (local assumed quiet, i.e. 0.5):');
for (const verdict of [1, 3, 5, 7, 9]) {
  const fused = fuse(0.5, verdict, false);
  const level = fused.difficulty < 2 ? 'low' : fused.difficulty > 7 ? 'max' : 'high';
  console.log(`  verdict ${String(verdict).padStart(2)} -> difficulty ${String(fused.difficulty).padStart(4)} -> ${level}`);
}
