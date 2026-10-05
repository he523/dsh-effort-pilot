/**
 * Decode a DSH session log that mixes plain JSONL with zstd frames.
 *
 * Shape observed on this machine: the file starts with a plain (uncompressed)
 * `{"type":"session",...}` header line, followed by one or more zstd frames.
 * Feeding the whole file to any single decompressor fails — `createZstdDecompress`
 * dies with "Unknown frame descriptor" once it reaches the plain prefix.
 * So: walk the buffer, cut at each zstd magic number, and inflate the segments.
 *
 * Usage:  node tools/decode-session.mjs <log> [out.jsonl]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const input = process.argv[2];
const output = process.argv[3] ?? `${input}.jsonl`;
if (input === undefined) {
  console.error('usage: node tools/decode-session.mjs <log> [out.jsonl]');
  process.exit(1);
}

const buffer = await readFile(input);
console.log(`input: ${buffer.length} bytes`);

/** Every offset where a zstd frame starts. */
const offsets = [];
let cursor = buffer.indexOf(MAGIC, 0);
while (cursor !== -1) {
  offsets.push(cursor);
  cursor = buffer.indexOf(MAGIC, cursor + MAGIC.length);
}
console.log(`zstd frames found: ${offsets.length}`);

const chunks = [];

// Anything before the first frame is plain text.
if (offsets.length === 0) {
  chunks.push(buffer);
} else if (offsets[0] > 0) {
  chunks.push(buffer.subarray(0, offsets[0]));
  console.log(`  plain prefix: ${offsets[0]} bytes`);
}

for (const [index, start] of offsets.entries()) {
  const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
  const frame = buffer.subarray(start, end);
  try {
    const inflated = zstdDecompressSync(frame);
    chunks.push(inflated);
  } catch (error) {
    console.log(`  frame ${index} at ${start} (${frame.length}b) FAILED: ${error.message}`);
    // A frame boundary can also appear inside compressed payload bytes; fall
    // back to skipping this false positive rather than aborting the decode.
  }
}

const text = Buffer.concat(chunks).toString('utf8');
await writeFile(output, text);
const lines = text.split('\n').filter(line => line.trim().length > 0);
console.log(`decoded -> ${output}`);
console.log(`output: ${text.length} chars, ${lines.length} lines`);
