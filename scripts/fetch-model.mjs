// Downloads the Kokoro ONNX model into models/ so it can be bundled with the extension.
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID, DTYPE, MODEL_FILES } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log(`Fetching ${MODEL_ID} (dtype ${DTYPE})`);

for (const file of MODEL_FILES) {
  const dest = path.join(root, 'models', MODEL_ID, file);
  if (existsSync(dest) && statSync(dest).size > 0) { console.log(`  ✓ ${file} (already downloaded)`); continue; }
  await mkdir(path.dirname(dest), { recursive: true });

  const res = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (total) process.stdout.write(`\r  … ${file} ${((done / total) * 100).toFixed(0)}%   `);
  });
  await pipeline(body, createWriteStream(dest + '.part'));
  await rename(dest + '.part', dest);
  process.stdout.write(`\r  ✓ ${file} (${(done / 1e6).toFixed(1)} MB)          \n`);
}
console.log('Done. Now run "npm run build".');
