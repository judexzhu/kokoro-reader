// Bundles the extension into dist/ (load that folder via chrome://extensions → Load unpacked).
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID, MODEL_FILES } from '../src/config.js';
import { VOICES } from '../src/shared/voices.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const r = (...p) => path.join(root, ...p);

await mkdir(out, { recursive: true });

// 1. Static files
for (const f of ['manifest.json', 'popup.html', 'popup.css', 'offscreen.html', 'icons']) {
  await cp(r('src', f), path.join(out, f), { recursive: true });
}

// 2. ONNX Runtime WASM (loaded locally instead of from the jsDelivr CDN)
const ortDist = r('node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
                 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  await cp(path.join(ortDist, f), path.join(out, 'ort', f));
}

// 3. Voices (ship inside the kokoro-js npm package)
for (const id of Object.keys(VOICES)) {
  await cp(r('node_modules/kokoro-js/voices', `${id}.bin`), path.join(out, 'voices', `${id}.bin`));
}

// 4. Model (downloaded by `npm run fetch-model`)
const missing = MODEL_FILES.filter((f) => !existsSync(r('models', MODEL_ID, f)));
if (missing.length) {
  console.warn(`\n⚠  Model files missing: ${missing.join(', ')}\n   Run "npm run fetch-model", then build again.\n`);
} else {
  for (const f of MODEL_FILES) await cp(r('models', MODEL_ID, f), path.join(out, 'models', MODEL_ID, f));
}

// 5. Scripts
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  outdir: out,
  logLevel: 'info',
  legalComments: 'none',
  minify: !watch,
};
const builds = [
  { ...common, entryPoints: { background: 'src/background.js', offscreen: 'src/offscreen.js', worker: 'src/worker.js' }, format: 'esm' },
  { ...common, entryPoints: { popup: 'src/popup.js', content: 'src/content.js' }, format: 'iife' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('Watching src/ for changes. Reload the extension after each rebuild.');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`\nBuilt ${path.relative(process.cwd(), out)}/ — load it at chrome://extensions (Developer mode → Load unpacked).`);
}
