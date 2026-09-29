// Offscreen document: manages Web Audio playback and coordinates with
// the background TTS Web Worker running ONNX inference on a separate OS thread.
import { MODEL_ID, DTYPE, DEVICE } from './config.js';

// ---------- status reporting ----------
let status = { state: 'idle', progress: 0 };
let currentTabId = null;
let lastAudioEnd = 0;

function report(patch) {
  status = { ...status, message: undefined, ...patch };
  send({ type: 'STATUS', status });
}
function send(msg) {
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}
function tlog(line) {
  console.log(line);
  if (currentTabId != null) {
    send({ type: 'TELEMETRY', tabId: currentTabId, line });
  }
}

// ---------- worker setup ----------
let worker = null;
let isWorkerBusy = false;

function handleWorkerMessage(e) {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'MODEL_STATUS':
      // Only report model load status if player is not currently active
      if (status.state === 'idle' || status.state === 'loading') {
        report({ state: msg.state, progress: msg.progress, message: msg.message });
      }
      break;

    case 'AUDIO': {
      isWorkerBusy = false;
      if (msg.sessionId !== session) return;
      tlog(`[Worker] Chunk #${msg.chunkId} synthesized in ${msg.synthMs}ms (audio: ${msg.audioSec}s, RTF: ${msg.rtf})`);
      const req = pendingRequests.get(msg.chunkId);
      if (req) {
        putCache(req.key, { audio: msg.audio, sampling_rate: msg.sampling_rate });
        req.resolve({ audio: msg.audio, sampling_rate: msg.sampling_rate });
      }
      break;
    }

    case 'AUDIO_ERROR': {
      isWorkerBusy = false;
      if (msg.sessionId !== session) return;
      const req = pendingRequests.get(msg.chunkId);
      if (req) {
        req.resolve(null);
      }
      break;
    }
  }
}

function initWorker() {
  if (worker) {
    try { worker.terminate(); } catch {}
  }
  isWorkerBusy = false;
  worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({
    type: 'INIT',
    modelId: MODEL_ID,
    dtype: DTYPE,
    device: DEVICE,
    localModelPath: chrome.runtime.getURL('models/'),
    wasmPaths: chrome.runtime.getURL('ort/'),
    voicesPath: chrome.runtime.getURL('voices/'),
  });
}

initWorker();

// ---------- in-memory audio LRU cache ----------
const MAX_CACHE_ENTRIES = 50; // ~15MB RAM cap, holds ~5-7 minutes of spoken audio
const audioCache = new Map(); // key -> { audio: Float32Array, sampling_rate: number }

function cacheKey(voice, speed, text) {
  return `${voice}:${speed}:${text}`;
}

function getCache(key) {
  const hit = audioCache.get(key);
  if (!hit) return null;
  audioCache.delete(key);
  audioCache.set(key, hit); // Move to end (most recently used)
  return hit;
}

function putCache(key, data) {
  if (audioCache.has(key)) {
    audioCache.delete(key);
  } else if (audioCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = audioCache.keys().next().value;
    audioCache.delete(oldest);
  }
  audioCache.set(key, data);
}

let pendingRequests = new Map();

function requestChunk(sessionId, chunkId, text, settings) {
  if (pendingRequests.has(chunkId)) return pendingRequests.get(chunkId).promise;

  const key = cacheKey(settings.voice, settings.speed, text);
  const cached = getCache(key);
  if (cached) {
    tlog(`⚡ [CACHE HIT] Sentence #${chunkId} loaded from RAM (0ms). "${text.slice(0, 45)}..."`);
    const promise = Promise.resolve(cached);
    pendingRequests.set(chunkId, { key, resolve: () => {}, promise });
    return promise;
  }

  isWorkerBusy = true;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pendingRequests.set(chunkId, { key, resolve, reject, promise });

  worker.postMessage({
    type: 'SYNTH',
    sessionId,
    chunkId,
    text,
    voice: settings.voice,
    speed: settings.speed,
  });

  return promise;
}

// ---------- playback ----------
const ctx = new AudioContext();
let current = null; // { src, resolve }

// Pad audio with calibrated natural human speech pauses between sentences and paragraphs
function padAudio(samples, isParagraphEnd) {
  // 1. Trim leading dead silence (leave 20ms lead-in)
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < 0.01) start++;
  start = Math.max(0, start - 480);

  // 2. Trim trailing dead silence
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < 0.01) end--;

  const trimmed = samples.subarray(start, end + 1);

  // 3. Cadence: 500ms between sentences, 1000ms (1s) between paragraphs
  const pauseDurationSec = isParagraphEnd ? 1.0 : 0.5;
  const pauseSamples = Math.round(24000 * pauseDurationSec);

  const out = new Float32Array(trimmed.length + pauseSamples);
  out.set(trimmed, 0);
  return out;
}

function play(raw, isParagraphEnd = false, chunkIndex = 0) {
  return new Promise((resolve) => {
    const audio = padAudio(raw.audio, isParagraphEnd);
    const buf = ctx.createBuffer(1, audio.length, raw.sampling_rate);
    buf.copyToChannel(audio, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const playStart = performance.now();
    const actualSilenceGap = lastAudioEnd > 0 ? Math.round(playStart - lastAudioEnd) : 0;
    const speechSec = (raw.audio.length / raw.sampling_rate).toFixed(2);
    tlog(`▶ [PLAYING] #${chunkIndex} (speech: ${speechSec}s, pause before: ${actualSilenceGap}ms, paragraphEnd: ${isParagraphEnd})`);

    src.onended = () => {
      lastAudioEnd = performance.now();
      try { src.disconnect(); } catch {}
      current = null;
      resolve();
    };
    current = { src, resolve };
    src.start(0);
  });
}

function haltAudio() {
  lastAudioEnd = 0;
  if (!current) return;
  const { src, resolve } = current;
  current = null;
  src.onended = null;
  try { src.stop(); src.disconnect(); } catch {}
  resolve();
}

// ---------- reading session ----------
let session = 0;
let settings = { voice: 'af_heart', speed: 1 };
let isPaused = false;
let pauseResolve = null;
let currentChunks = [];
let currentPlayIndex = 0;
let skipTarget = null;

function pause() {
  isPaused = true;
  ctx.suspend().catch(() => {});
  report({ state: 'paused' });
}

function resume() {
  isPaused = false;
  ctx.resume().catch(() => {});
  report({ state: 'playing' });
  if (pauseResolve) {
    const r = pauseResolve;
    pauseResolve = null;
    r();
  }
}

function skip(delta) {
  if (!currentChunks.length) return;
  const target = Math.max(0, Math.min(currentPlayIndex + delta, currentChunks.length - 1));
  if (target === currentPlayIndex && delta !== 0) return;
  skipTarget = target;
  haltAudio();
  if (currentTabId != null) {
    send({ type: 'PROGRESS', tabId: currentTabId, index: currentChunks[target].index });
  }
  if (pauseResolve) {
    const r = pauseResolve;
    pauseResolve = null;
    r();
  }
}

function plan(input, startIndex) {
  const list = input || [];
  const chunks = [];
  for (let i = startIndex; i < list.length; i++) {
    const item = list[i];
    if (typeof item === 'string') {
      chunks.push({ text: item, index: i, isParagraphEnd: false });
    } else {
      chunks.push({ text: item.text, index: i, isParagraphEnd: !!item.isParagraphEnd });
    }
  }
  return chunks;
}

async function playFrom({ tabId, items, texts, startIndex = 0 }) {
  const my = ++session;

  // Instantly terminate worker if it's trapped in a WASM loop computing old sentences
  if (isWorkerBusy) {
    tlog(`⚡ [INSTANT ABORT] Terminated busy worker to drop old sentence backlog.`);
    initWorker();
  }

  worker.postMessage({ type: 'SET_SESSION', sessionId: my });
  pendingRequests.clear();
  haltAudio();
  isPaused = false;
  skipTarget = null;
  if (pauseResolve) { const r = pauseResolve; pauseResolve = null; r(); }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  report({ state: 'playing', progress: 1, tabId });
  const chunks = plan(items || texts, startIndex);
  currentChunks = chunks;
  if (!chunks.length) {
    send({ type: 'FINISHED', tabId });
    report({ state: 'ready', progress: 1 });
    return;
  }

  const BUFFER_AHEAD = 4; // Keep 4 sentences ahead in background worker queue

  // Pre-queue first 4 sentences immediately so playback buffer never starves
  for (let i = 0; i < Math.min(chunks.length, BUFFER_AHEAD); i++) {
    requestChunk(my, i, chunks[i].text, settings);
  }

  let shown = -1;
  let c = 0;
  while (c < chunks.length) {
    if (my !== session) return;

    if (skipTarget != null) {
      c = skipTarget;
      skipTarget = null;
    }

    currentPlayIndex = c;

    // Keep pipeline filled from current position c
    for (let ahead = 1; ahead <= BUFFER_AHEAD && c + ahead < chunks.length; ahead++) {
      requestChunk(my, c + ahead, chunks[c + ahead].text, settings);
    }

    // If paused, wait until resumed before playing
    while (isPaused) {
      if (my !== session) return;
      await new Promise((r) => { pauseResolve = r; });
      if (skipTarget != null) {
        c = skipTarget;
        skipTarget = null;
        currentPlayIndex = c;
      }
    }

    currentTabId = tabId;
    const waitT0 = performance.now();
    let raw;
    try {
      raw = await requestChunk(my, c, chunks[c].text, settings);
    } catch {
      raw = null;
    }

    if (my !== session) return;
    if (skipTarget != null) continue; // Skip triggered while waiting for chunk

    const waitMs = Math.round(performance.now() - waitT0);
    if (waitMs > 50) {
      tlog(`⚠️ [STALL] Sentence #${c} was NOT ready! Paused for ${waitMs}ms waiting for synthesis. "${chunks[c].text.slice(0, 45)}..."`);
    } else {
      tlog(`✓ [READY] Sentence #${c} pre-buffered in RAM (wait: ${waitMs}ms). "${chunks[c].text.slice(0, 45)}..."`);
    }

    if (!raw) {
      c++;
      continue;
    }

    if (chunks[c].index !== shown) {
      shown = chunks[c].index;
      send({ type: 'PROGRESS', tabId, index: shown });
    }

    await play(raw, chunks[c].isParagraphEnd, c);
    if (my !== session) return;
    if (skipTarget != null) continue; // Skip triggered while playing chunk

    c++;
  }

  if (my === session) {
    send({ type: 'FINISHED', tabId });
    report({ state: 'ready', progress: 1 });
  }
}

function stop() {
  session++;
  initWorker();
  pendingRequests.clear();
  haltAudio();
  isPaused = false;
  skipTarget = null;
  currentChunks = [];
  if (pauseResolve) { const r = pauseResolve; pauseResolve = null; r(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  report({ state: 'ready', progress: 1 });
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'PLAY':
      settings = { voice: msg.voice, speed: msg.speed };
      playFrom(msg);
      sendResponse?.({ ok: true });
      break;
    case 'PAUSE':
      pause();
      sendResponse?.({ ok: true });
      break;
    case 'RESUME':
      resume();
      sendResponse?.({ ok: true });
      break;
    case 'SKIP':
      skip(msg.delta || 0);
      sendResponse?.({ ok: true });
      break;
    case 'STOP':
      stop();
      sendResponse?.({ ok: true });
      break;
    case 'SETTINGS':
      settings = { voice: msg.voice, speed: msg.speed };
      sendResponse?.({ ok: true });
      break;
    case 'PRELOAD':
      worker.postMessage({ type: 'PRELOAD' });
      sendResponse?.({ ok: true });
      break;
  }
});
