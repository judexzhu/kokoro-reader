// Dedicated Web Worker for Kokoro TTS.
// Runs ONNX WASM in background thread so the extension UI and AudioContext never freeze.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

// Suppress benign Content-Length warning on chrome-extension:// URLs
const _warn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Unable to determine content-length')) return;
  _warn.apply(console, args);
};

let modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let dtype = 'q8';
let device = 'wasm';
let voicesPath = '';
let currentSession = 0;
let chain = Promise.resolve();
let modelPromise = null;

const seeded = new Set();
async function ensureVoice(id) {
  if (seeded.has(id)) return;
  const cache = await caches.open('kokoro-voices');
  const voiceUrl = `https://huggingface.co/${modelId}/resolve/main/voices/${id}.bin`;
  if (!(await cache.match(voiceUrl))) {
    const res = await fetch(`${voicesPath}${id}.bin`);
    if (!res.ok) throw new Error(`Voice file missing: ${id}.bin`);
    await cache.put(voiceUrl, new Response(await res.arrayBuffer(), {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
  }
  seeded.add(id);
}

function loadModel() {
  if (modelPromise) return modelPromise;
  self.postMessage({ type: 'MODEL_STATUS', state: 'loading', progress: 0 });
  const files = new Map();
  let lastSent = 0;
  modelPromise = KokoroTTS.from_pretrained(modelId, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      const now = performance.now();
      if (now - lastSent > 150) {
        lastSent = now;
        self.postMessage({ type: 'MODEL_STATUS', state: 'loading', progress: loaded / total });
      }
    },
  }).then(
    (tts) => {
      self.postMessage({ type: 'MODEL_STATUS', state: 'ready', progress: 1 });
      return tts;
    },
    (err) => {
      modelPromise = null;
      self.postMessage({ type: 'MODEL_STATUS', state: 'error', message: err?.message || String(err) });
      throw err;
    }
  );
  return modelPromise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'INIT': {
      modelId = msg.modelId;
      dtype = msg.dtype;
      device = msg.device;
      voicesPath = msg.voicesPath;

      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = msg.localModelPath;
      env.useBrowserCache = false;
      env.backends.onnx.wasm.wasmPaths = msg.wasmPaths;
      const isIsolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const threads = isIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
      env.backends.onnx.wasm.numThreads = threads;
      console.log(`[Worker] crossOriginIsolated=${isIsolated}, ONNX threads=${threads}`);
      break;
    }

    case 'PRELOAD': {
      loadModel().catch(() => {});
      break;
    }

    case 'SET_SESSION': {
      currentSession = msg.sessionId;
      break;
    }

    case 'SYNTH': {
      const { sessionId, chunkId, text, voice, speed } = msg;
      if (sessionId !== currentSession) return;

      const job = chain.then(async () => {
        if (sessionId !== currentSession) return;
        const t0 = performance.now();
        const tts = await loadModel();
        if (sessionId !== currentSession) return;
        await ensureVoice(voice);
        if (sessionId !== currentSession) return;
        const raw = await tts.generate(text, { voice, speed });
        if (sessionId !== currentSession) return;

        const synthMs = Math.round(performance.now() - t0);
        const audioSec = (raw.audio.length / raw.sampling_rate).toFixed(2);
        const rtf = (synthMs / 1000 / (raw.audio.length / raw.sampling_rate)).toFixed(2);

        // Zero-copy transfer of Float32Array to offscreen main thread
        self.postMessage(
          {
            type: 'AUDIO',
            sessionId,
            chunkId,
            synthMs,
            audioSec,
            rtf,
            audio: raw.audio,
            sampling_rate: raw.sampling_rate,
          },
          [raw.audio.buffer]
        );
      }).catch((err) => {
        if (sessionId === currentSession) {
          console.warn('Worker synthesis failed for text:', text, err);
          self.postMessage({
            type: 'AUDIO_ERROR',
            sessionId,
            chunkId,
            error: err?.message || String(err),
          });
        }
      });

      chain = job.catch(() => {});
      break;
    }
  }
};
