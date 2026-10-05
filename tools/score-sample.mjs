/**
 * Run the plugin's OWN scorer against a set of real messages.
 *
 * This is the strongest available check on L2: the decision log only reaches the
 * host's stdout (DSH keeps no runtime log file, only crash logs), so the
 * semantic score is otherwise invisible. Replaying messages through
 * `SemanticScorer` shows whether the judge is reachable, what verdicts it
 * produces, and how long it takes on this machine — which is what the level
 * thresholds are calibrated against.
 *
 * Requires DSH_ZHIPU_API_KEY. Reads it from the environment, falling back to the
 * user scope, and never prints it.
 *
 * Usage:  node tools/score-sample.mjs ["message text" ...]
 */
import { execSync } from 'node:child_process';

import { fuse } from '../lib/decide.js';
import { SemanticScorer } from '../lib/scorer.js';

if (!process.env.DSH_ZHIPU_API_KEY) {
  const fromUser = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'DSH_ZHIPU_API_KEY\',\'User\')"',
    { encoding: 'utf8' },
  ).trim();
  if (fromUser) process.env.DSH_ZHIPU_API_KEY = fromUser;
}
if (!process.env.DSH_ZHIPU_API_KEY) {
  console.error('DSH_ZHIPU_API_KEY not available (environment and user scope both empty)');
  process.exit(1);
}
console.log(`key present (${process.env.DSH_ZHIPU_API_KEY.length} chars)\n`);

/** Keep in step with the schema defaults in lib/index.js. */
const config = {
  mode: 'hybrid',
  lowMax: 2,
  highMin: 6,
  semantic: {
    enabled: true,
    provider: 'zhipu',
    model: 'glm-4-flash',
    timeoutMs: 2500,
    maxInputChars: 2000,
    ambiguousLow: 2,
    ambiguousHigh: 7,
    resampleDecisions: 12,
    maxCallsPerTurn: 0,
    maxCallsPerSession: 100,
    alwaysOnFirstTurn: true,
  },
};

/** The real endpoint the host's zhipu adapter calls. */
function stream(options) {
  const apiKey = process.env.DSH_ZHIPU_API_KEY;
  return {
    async *[Symbol.asyncIterator]() {
      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.messages[0].content[0].text },
          ],
          max_tokens: options.maxTokens,
          temperature: options.temperature,
        }),
        signal: options.signal,
      });
      const body = await response.json();
      if (!response.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `HTTP ${response.status}` } } };
        return;
      }
      const text = String(body?.choices?.[0]?.message?.content ?? '');
      if (text) yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const DEFAULT_SAMPLES = [
  // Ordered roughly from trivial to genuinely hard, so the verdict spread reads
  // as a calibration curve rather than a set of anecdotes.
  '今天星期几？',
  '什么是 FNV-1a？',
  '把这句话翻译成英文：今天天气不错。',
  '并决定是否要打开 allowUpgrade，否则 max 等于白给。这段话是什么意思',
  '这个函数是干什么的？',
  '帮我在这份配置里加一个字段，默认值 false。',
  '给这个工具加一条单元测试。',
  '重构整个插件的信号层，要求保持向后兼容、不引入新的运行时依赖，并保证 70 条单测全部通过。',
  '设计一套跨会话的难度调度方案，需要权衡成本、延迟与质量，并给出可验证的验收标准。',
  '线上偶发超时，日志看不出规律，需要定位根因并给出修复方案与回滚策略。',
  '把整个仓库从 CommonJS 迁移到 ESM，同时保持对外 API 不变，并补上迁移测试。',
];

const SAMPLES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SAMPLES;

const scorer = new SemanticScorer({
  getConfig: () => config,
  stream,
  log: message => console.log(`  [log] ${message}`),
});

console.log('  message                                        verdict  difficulty  level   ms');
for (const text of SAMPLES) {
  const result = await scorer.score({ text, sessionId: 'probe', turn: 1 });
  const local = 0.5; // a quiet local score, as measured on real turns
  const fused = result.score === undefined ? undefined : fuse(local, result.score, true);
  const difficulty = fused?.difficulty ?? local;
  const level = difficulty < config.lowMax ? 'low' : difficulty > config.highMin ? 'max' : 'high';
  const label = text.length > 44 ? `${text.slice(0, 44)}…` : text;
  console.log(
    `  ${label.padEnd(46)} ${String(result.score ?? 'FAIL').padStart(7)}`
    + `  ${String(difficulty).padStart(10)}  ${level.padEnd(6)} ${result.ms}`
    + `${result.cachedReason ? ` (${result.cachedReason})` : ''}`,
  );
}

console.log(`\ncache entries: ${scorer.cacheSize}   calls this session: ${scorer.callsFor('probe')}`);
console.log(
  `interpretation (lowMax=${config.lowMax}, highMin=${config.highMin}):`
  + ` verdict < ${config.lowMax} -> low, <= ${config.highMin} -> high, above -> max`,
);
