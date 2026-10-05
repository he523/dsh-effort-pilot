/** Compare the source tree against the installed copy: hash, size, link count. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const source = join(homedir(), '.dsh', 'local-plugins', 'dsh-effort-pilot');
const target = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-effort-pilot');

const FILES = [
  'lib/index.js',
  'lib/decide.js',
  'lib/scorer.js',
  'lib/session-events.js',
  'package.json',
  'cordis.patch.yml',
];

for (const file of FILES) {
  const row = { file };
  for (const [label, root] of [['src', source], ['inst', target]]) {
    try {
      const path = join(root, file);
      const info = await stat(path);
      const hash = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 12);
      row[label] = `${info.size}b nlink=${info.nlink} ${hash}`;
    } catch (error) {
      row[label] = `MISSING (${error.code})`;
    }
  }
  const same = row.src === row.inst;
  row.verdict = same ? 'IDENTICAL' : 'DIFFERENT';
  console.log(`${row.file.padEnd(24)} ${row.verdict}`);
  console.log(`   src : ${row.src}`);
  console.log(`   inst: ${row.inst}`);
}

const dirInfo = await stat(target);
console.log('\ntarget is symlink:', dirInfo.isSymbolicLink?.() ?? false);
