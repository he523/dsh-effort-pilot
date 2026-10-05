/**
 * Resolution probe: can a plugin living in `~/.dsh/local-plugins/` actually
 * import the host packages it depends on (`@deepseek-ai/dsh-llm`,
 * `@deepseek-ai/schemastery`), and can those be reached through a resolver
 * rooted at the *profile* directory?
 *
 * Run:  node probe.mjs
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop');

const localRequire = createRequire(import.meta.url);
const profileRequire = createRequire(join(profileDir, 'package.json'));

const targets = ['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery', '@deepseek-ai/cordis'];

for (const target of targets) {
  for (const [label, req] of [['local  ', localRequire], ['profile', profileRequire]]) {
    try {
      console.log(`OK   ${label} ${target} -> ${req.resolve(target)}`);
    } catch (error) {
      console.log(`FAIL ${label} ${target} -> ${error.code ?? error.message}`);
    }
  }
}

try {
  const llm = profileRequire('@deepseek-ai/dsh-llm');
  console.log('dsh-llm createUserMessage:', typeof llm.createUserMessage);
  const message = llm.createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  });
  console.log('message:', JSON.stringify(message));
  console.log('frozen:', Object.isFrozen(message));
} catch (error) {
  console.log('createUserMessage probe FAILED:', error.message);
}

try {
  const z = profileRequire('@deepseek-ai/schemastery').default ?? profileRequire('@deepseek-ai/schemastery');
  const schema = z.object({ a: z.number().default(1).volatile() });
  const validated = schema['~standard'].validate({});
  console.log('schemastery validate:', JSON.stringify(validated));
  console.log('volatile ref:', typeof validated.value.a?.get);
} catch (error) {
  console.log('schemastery probe FAILED:', error.message);
}

