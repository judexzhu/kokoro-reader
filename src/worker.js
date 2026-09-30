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
let modelPromise = null;
let queue = [];
let isProcessing = false;
let currentJob = null;
const completedChunks = new Set();

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

function createTTS(targetDevice, targetDtype, files, lastSentRef) {
  return KokoroTTS.from_pretrained(modelId, {
    dtype: targetDtype,
    device: targetDevice,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      const now = performance.now();
      if (now - lastSentRef.val > 150) {
        lastSentRef.val = now;
        self.postMessage({ type: 'MODEL_STATUS', state: 'loading', progress: loaded / total });
      }
    },
  });
}

function loadModel() {
  if (modelPromise) return modelPromise;
  self.postMessage({ type: 'MODEL_STATUS', state: 'loading', progress: 0 });
  const files = new Map();
  const lastSentRef = { val: 0 };

  modelPromise = (async () => {
    try {
      if (device === 'webgpu' && typeof navigator !== 'undefined' && !navigator.gpu) {
        throw new Error('WebGPU not supported in this environment');
      }
      return await createTTS(device, dtype, files, lastSentRef);
    } catch (err) {
      if (device === 'webgpu') {
        console.warn('[Worker] WebGPU initialization failed, falling back to WASM:', err);
        device = 'wasm';
        return await createTTS('wasm', dtype, files, lastSentRef);
      }
      throw err;
    }
  })().then(
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

function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  (async () => {
    while (queue.length > 0) {
      // Drop any tasks from stale sessions
      const validJobs = queue.filter((j) => j.sessionId === currentSession);
      if (!validJobs.length) {
        queue = [];
        break;
      }

      // Prioritize high-priority playback jobs over background prefetch
      const targetJob = validJobs.find((j) => j.priority === 'high') || validJobs[0];
      const idx = queue.indexOf(targetJob);
      if (idx !== -1) queue.splice(idx, 1);

      if (targetJob.sessionId !== currentSession) continue;
      currentJob = targetJob;

      try {
        const t0 = performance.now();
        const tts = await loadModel();
        if (targetJob.sessionId !== currentSession) { currentJob = null; continue; }
        await ensureVoice(targetJob.voice);
        if (targetJob.sessionId !== currentSession) { currentJob = null; continue; }
        const raw = await tts.generate(targetJob.text, { voice: targetJob.voice, speed: targetJob.speed });
        if (targetJob.sessionId !== currentSession) { currentJob = null; continue; }

        completedChunks.add(targetJob.chunkId);
        currentJob = null;

        const synthMs = Math.round(performance.now() - t0);
        const audioSec = (raw.audio.length / raw.sampling_rate).toFixed(2);
        const rtf = (synthMs / 1000 / (raw.audio.length / raw.sampling_rate)).toFixed(2);

        // Zero-copy transfer of Float32Array to offscreen main thread
        self.postMessage(
          {
            type: 'AUDIO',
            sessionId: targetJob.sessionId,
            chunkId: targetJob.chunkId,
            synthMs,
            audioSec,
            rtf,
            audio: raw.audio,
            sampling_rate: raw.sampling_rate,
          },
          [raw.audio.buffer]
        );
      } catch (err) {
        currentJob = null;
        if (targetJob.sessionId === currentSession) {
          console.warn('Worker synthesis failed for text:', targetJob.text, err);
          self.postMessage({
            type: 'AUDIO_ERROR',
            sessionId: targetJob.sessionId,
            chunkId: targetJob.chunkId,
            error: err?.message || String(err),
          });
        }
      }
    }
    isProcessing = false;
  })();
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
      completedChunks.clear();
      currentJob = null;
      queue = queue.filter((j) => j.sessionId === currentSession);
      break;
    }

    case 'CLEAR_QUEUE': {
      queue = [];
      break;
    }

    case 'PRIORITIZE': {
      const { sessionId, chunkId } = msg;
      if (sessionId !== currentSession) break;
      const job = queue.find((j) => j.sessionId === sessionId && j.chunkId === chunkId);
      if (job) job.priority = 'high';
      break;
    }

    case 'SYNTH': {
      const { sessionId, chunkId, text, voice, speed, priority = 'normal' } = msg;
      if (sessionId !== currentSession) return;
      if (completedChunks.has(chunkId)) return;
      if (currentJob && currentJob.sessionId === sessionId && currentJob.chunkId === chunkId) return;

      const existingIdx = queue.findIndex((j) => j.sessionId === sessionId && j.chunkId === chunkId);
      if (existingIdx !== -1) {
        if (priority === 'high') queue[existingIdx].priority = 'high';
      } else {
        queue.push({ sessionId, chunkId, text, voice, speed, priority });
      }
      processQueue();
      break;
    }
  }
};
