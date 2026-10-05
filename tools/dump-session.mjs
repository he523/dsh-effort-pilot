/** Dump the structure of a session log so the replayer can target it. */
import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const text = zstdDecompressSync(await readFile(path)).toString('utf8');
const lines = text.split('\n').filter(line => line.trim().length > 0);
console.log(`lines: ${lines.length}`);

for (const [index, line] of lines.slice(0, 3).entries()) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    console.log(`line ${index}: unparseable (${error.message})`);
    continue;
  }
  console.log(`\n--- line ${index} (${line.length} chars) ---`);
  console.log('top-level keys:', Array.isArray(value) ? `ARRAY(${value.length})` : Object.keys(value).sort().join(', '));
  const preview = JSON.stringify(value);
  console.log('preview:', preview.slice(0, 1200));
}
