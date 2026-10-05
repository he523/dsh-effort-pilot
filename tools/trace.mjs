/** Trace the reasoning-less strip path. */
import { homedir } from 'node:os';
import { join } from 'node:path';

const profile = join(homedir(), '.dsh', 'profiles', 'desktop');
const mod = await import(`file://${join(profile, 'node_modules', 'dsh-effort-pilot', 'lib', 'index.js').replace(/\\/g, '/')}`);

const adapter = {
  resolveModel: async (provider, model) => {
    if (model === 'plain') return { provider, id: model, name: model, context: { contextWindow: 128000 } };
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
    };
  },
};
const adapters = new Map([['p', { adapter }]]);
const llm = {
  adapters,
  resolveModelInfo: async (provider, model) => {
    const raw = await adapter.resolveModel(provider, model, undefined);
    console.log('  raw from adapter:', JSON.stringify(raw));
    return raw;
  },
  stream: () => ({ async *[Symbol.asyncIterator]() {} }),
};

const listeners = new Map();
const ctx = {
  logger: { info: m => console.log('  log:', m), warn: () => {}, debug: () => {} },
  get: key => (key === 'llm' ? llm : undefined),
  on: (name, handler) => {
    listeners.set(name, handler);
    return () => {};
  },
};

const value = mod.Config['~standard'].validate({}).value;
mod.apply(ctx, value);

console.log('calling waterfall with model=plain, seed effort=high');
const result = await listeners.get('agent/request')(
  { agent: { id: 's1', session: { snapshotEvents: () => [] } }, turn: 1, step: 1 },
  async () => ({ provider: 'p', model: 'plain', messages: [], reasoningEffort: 'high' }),
);
console.log('result:', JSON.stringify(result));
console.log('reasoningEffort:', String(result.reasoningEffort));
