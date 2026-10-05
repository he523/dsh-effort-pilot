/**
 * Measure the scoring layer's real failure rate and latency percentiles.
 *
 * `timeoutMs` and the retry policy should come from measurement, not guesswork.
 * This runs a batch of messages through the plugin's own scorer and reports the
 * unusable rate, latency percentiles, and the verdict spread.
 *
 * Costs a small number of real requests (batch size x 1-2 calls).
 *
 * Usage:  node tools/measure-latency.mjs [batchSize]
 */
import { execSync } from 'node:child_process';

import { SemanticScorer } from '../lib/scorer.js';

if (!process.env.DSH_ZHIPU_API_KEY) {
  const fromUser = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'DSH_ZHIPU_API_KEY\',\'User\')"',
    { encoding: 'utf8' },
  ).trim();
  if (fromUser) process.env.DSH_ZHIPU_API_KEY = fromUser;
}
if (!process.env.DSH_ZHIPU_API_KEY) {
  console.error('DSH_ZHIPU_API_KEY not available');
  process.exit(1);
}

const batch = Number(process.argv[2] ?? 20);

const config = {
  mode: 'hybrid',
  semantic: {
    enabled: true,
    provider: 'zhipu',
    model: 'glm-4-flash',
    timeoutMs: 2500,
    maxInputChars: 2000,
    ambiguousLow: 2,
    ambiguousHigh: 7,
    maxCallsPerTurn: 1,
    maxCallsPerSession: 1000,
    alwaysOnFirstTurn: true,
  },
};

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

/** A pool of distinct messages, so the cache never short-circuits a sample. */
const BASE = [
  '今天星期几', '什么是 FNVa', '这个函数干什么的', '读一下这个文件', '列出目录内容',
  '把这段翻译成英文', '加一个默认值 false 的字段', '给这个工具加一条单测', '改一下这个变量的名字',
  '解释这段正则', '为什么这里要加锁', '这个报错是什么意思', '帮我写个正则匹配邮箱', '这段 SQL 有什么问题',
  '重构信号层并保持向后兼容', '设计一套跨会话调度方案', '定位线上偶发超时的根因', '把仓库从 CJK 迁到 UTF',
  '给整个模块补齐文档与示例', '梳理这个状态机所有分支', '评估这次改动的风险面', '把这段逻辑抽成纯函数',
];

const scorer = new SemanticScorer({ getConfig: () => config, stream });
const latencies = [];
let unusable = 0;
const verdicts = [];

for (let i = 0; i < batch; i += 1) {
  const text = `${BASE[i % BASE.length]}（样本 ${i}）`;
  const result = await scorer.score({ text, sessionId: 'measure', turn: i });
  if (result.score === undefined) {
    unusable += 1;
    process.stdout.write('x');
  } else {
    verdicts.push(result.score);
    process.stdout.write(String(result.score));
  }
  latencies.push(result.ms);
}
console.log('\n');

const sorted = [...latencies].sort((a, b) => a - b);
const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
console.log(`samples        : ${batch}`);
console.log(`unusable       : ${unusable} (${((unusable / batch) * 100).toFixed(1)}%)  <-- each of these fell back to L1`);
console.log(`latency p50    : ${pick(0.5)} ms`);
console.log(`latency p90    : ${pick(0.9)} ms`);
console.log(`latency p95    : ${pick(0.95)} ms`);
console.log(`latency max    : ${sorted[sorted.length - 1]} ms   (timeout is ${config.semantic.timeoutMs} ms)`);
if (verdicts.length > 0) {
  const dist = new Map();
  for (const v of verdicts) dist.set(v, (dist.get(v) ?? 0) + 1);
  const histogram = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${v}:${n}`).join('  ');
  console.log(`verdicts       : ${histogram}`);
  console.log(`verdict range  : ${Math.min(...verdicts)} .. ${Math.max(...verdicts)}`);
  console.log(`verdict p50    : ${[...verdicts].sort((a, b) => a - b)[Math.floor(verdicts.length / 2)]}`);
}
console.log(`\ncache entries  : ${scorer.cacheSize}`);
