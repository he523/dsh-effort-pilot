/**
 * Find a working configuration for the semantic scoring call.
 *
 * Measured fact that forced this probe: `glm-4.5-flash` is a REASONING model.
 * With the plugin's original `maxTokens: 8` it spent the whole budget inside
 * `reasoning_content`, returned an EMPTY `content` and `finish_reason: "length"`
 * — so the score was unusable 100% of the time and L2 silently degraded to L1.
 *
 * This sweeps models and token budgets to find the cheapest setting that
 * reliably yields a parseable integer.
 *
 * Usage:  node tools/probe-route.mjs
 */
const baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
const apiKey = process.env.DSH_ZHIPU_API_KEY
  ?? (await import('node:child_process')).execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'DSH_ZHIPU_API_KEY\',\'User\')"',
    { encoding: 'utf8' },
  ).trim();

if (!apiKey) {
  console.error('DSH_ZHIPU_API_KEY not found');
  process.exit(1);
}

const SYSTEM_PROMPT = [
  'You are a task-difficulty estimator for a coding agent.',
  'Judge only how much REASONING the user\'s latest request demands.',
  'Answer with a single integer 0-10 and nothing else.',
  '',
  '0-2  factual lookup, formatting, trivial rewrite',
  '3-4  routine coding or writing with an obvious path',
  '5-6  multi-step reasoning, cross-file change, real trade-offs',
  '7-8  architecture design, hard debugging, ambiguous requirements',
  '9-10 long-chain reasoning with global consistency demands',
].join('\n');

const SAMPLES = [
  '把这句话翻译成英文：今天天气不错。',
  '重构整个插件的信号层，要求保持向后兼容并且不引入新的运行时依赖。',
  '什么是 FNV-1a？',
];

/** One call; returns the raw shape we care about. */
async function call(model, maxTokens, text) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  const ms = Date.now() - started;
  if (!response.ok) {
    return { ok: false, note: `HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}`, ms };
  }
  const message = body?.choices?.[0]?.message ?? {};
  const content = String(message.content ?? '');
  const reasoning = String(message.reasoning_content ?? '');
  const match = /\d+/.exec(content);
  return {
    ok: match !== undefined,
    content,
    reasoningChars: reasoning.length,
    finish: body?.choices?.[0]?.finish_reason,
    completionTokens: body?.usage?.completion_tokens,
    score: match ? Number(match[0]) : undefined,
    ms,
  };
}

const MODELS = ['glm-4.5-flash', 'glm-4-flash', 'glm-4.5-air'];
const BUDGETS = [8, 64, 256, 1024];

for (const model of MODELS) {
  for (const budget of BUDGETS) {
    const results = [];
    for (const text of SAMPLES) {
      try {
        results.push(await call(model, budget, text));
      } catch (error) {
        results.push({ ok: false, note: error.message, ms: 0 });
      }
    }
    const usable = results.filter(r => r.ok).length;
    const latencies = results.map(r => r.ms).filter(ms => ms > 0).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const max = latencies[latencies.length - 1] ?? 0;
    const tokens = results.map(r => r.completionTokens ?? 0).join('/');
    const finishes = [...new Set(results.map(r => r.finish ?? r.note ?? '?'))].join(',');
    console.log(
      `${model.padEnd(14)} maxTokens=${String(budget).padStart(4)}`
      + ` usable=${usable}/3 scores=[${results.map(r => r.score ?? '-').join(',')}]`
      + ` completionTokens=${tokens} finish=${finishes} p50=${p50}ms max=${max}ms`,
    );
  }
}

console.log('\nRaw content of the last probe per model (budget 256):');
for (const model of MODELS) {
  const result = await call(model, 256, SAMPLES[1]);
  console.log(`  ${model.padEnd(14)} content=${JSON.stringify(result.content ?? result.note)}`
    + ` reasoning=${result.reasoningChars}ch finish=${result.finish} score=${result.score ?? '-'}`);
}
