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
      if (msg.sessionId !== session) return;
      tlog(`[Worker] Chunk #${msg.chunkId} synthesized in ${msg.synthMs}ms (audio: ${msg.audioSec}s, RTF: ${msg.rtf})`);
      const req = pendingRequests.get(msg.chunkId);
      pendingRequests.delete(msg.chunkId);
      if (req) {
        putCache(req.key, { audio: msg.audio, sampling_rate: msg.sampling_rate });
        req.resolve({ audio: msg.audio, sampling_rate: msg.sampling_rate });
      }
      break;
    }

    case 'AUDIO_ERROR': {
      if (msg.sessionId !== session) return;
      const req = pendingRequests.get(msg.chunkId);
      pendingRequests.delete(msg.chunkId);
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
  worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (err) => {
    console.error('[Offscreen] Worker crashed, re-initializing:', err);
    initWorker();
  };
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

function requestChunk(sessionId, chunkId, text, settings, priority = 'normal') {
  const key = cacheKey(settings.voice, settings.speed, text);
  const cached = getCache(key);
  if (cached) {
    tlog(`⚡ [CACHE HIT] Sentence #${chunkId} loaded from RAM (0ms). "${text.slice(0, 45)}..."`);
    return Promise.resolve(cached);
  }

  if (pendingRequests.has(chunkId)) {
    const existing = pendingRequests.get(chunkId);
    if (priority === 'high' && !existing.isHighPriority) {
      existing.isHighPriority = true;
      worker.postMessage({
        type: 'PRIORITIZE',
        sessionId,
        chunkId,
      });
    }
    return existing.promise;
  }

  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pendingRequests.set(chunkId, { key, resolve, reject, promise, isHighPriority: priority === 'high' });

  worker.postMessage({
    type: 'SYNTH',
    sessionId,
    chunkId,
    text,
    voice: settings.voice,
    speed: settings.speed,
    priority,
  });

  return promise;
}

// ---------- playback ----------
const ctx = new AudioContext();
let current = null; // { src, resolve, clearPause }
let masterChain = null;

// Studio vocal mastering chain: removes sub-bass rumble, enhances vocal body & air, levels dynamic range
function getMasterNode() {
  if (masterChain) return masterChain;

  // 1. High-pass filter: cut low rumble below 80Hz
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;
  highpass.Q.value = 0.707;

  // 2. Warmth peaking EQ: subtle chest resonance at 220Hz
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'peaking';
  warmth.frequency.value = 220;
  warmth.Q.value = 1.0;
  warmth.gain.value = 1.5;

  // 3. Presence highshelf: crisp intelligibility and breath presence at 3.8kHz
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 3800;
  air.gain.value = 1.8;

  // 4. Dynamics compressor: smooths volume peaks, elevates quiet breath nuances
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3.0;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.060;

  // Connect mastering graph: highpass -> warmth -> air -> compressor -> destination
  highpass.connect(warmth);
  warmth.connect(air);
  air.connect(compressor);
  compressor.connect(ctx.destination);

  masterChain = highpass;
  return masterChain;
}

// Zero-copy trim of leading and trailing dead silence
function trimSilence(samples) {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < 0.01) start++;
  start = Math.max(0, start - 480);

  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < 0.01) end--;

  return start === 0 && end === samples.length - 1 ? samples : samples.subarray(start, end + 1);
}

function play(raw, chunkIndex = 0, tabId = null) {
  return new Promise((resolve) => {
    const audio = trimSilence(raw.audio);
    const buf = ctx.createBuffer(1, audio.length, raw.sampling_rate);
    buf.copyToChannel(audio, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(getMasterNode());

    const playStart = performance.now();
    const actualSilenceGap = lastAudioEnd > 0 ? Math.round(playStart - lastAudioEnd) : 0;
    const speechSec = (raw.audio.length / raw.sampling_rate).toFixed(2);
    tlog(`▶ [PLAYING] #${chunkIndex} (speech: ${speechSec}s, pause before: ${actualSilenceGap}ms)`);

    // Report active playback once audio actually hits Web Audio destination
    if (!isPaused) {
      report({ state: 'playing', tabId });
    }

    src.onended = () => {
      lastAudioEnd = performance.now();
      try { src.disconnect(); } catch {}
      current = null;
      resolve();
    };

    current = {
      src,
      resolve,
    };
    src.start(0);
  });
}

function haltAudio() {
  lastAudioEnd = 0;
  if (!current) return;
  const { src, resolve, clearPause } = current;
  current = null;
  clearPause?.();
  if (src) {
    src.onended = null;
    try { src.stop(); src.disconnect(); } catch {}
  }
  resolve?.();
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
  // Clear obsolete prefetch tasks from worker queue
  worker.postMessage({ type: 'CLEAR_QUEUE' });
  if (currentTabId != null) {
    send({ type: 'PROGRESS', tabId: currentTabId, index: currentChunks[target].index });
  }
  if (pauseResolve) {
    const r = pauseResolve;
    pauseResolve = null;
    r();
  }
}

function plan(input, startIndex = 0) {
  const list = input || [];
  const chunks = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item === 'string') {
      if (i >= startIndex) chunks.push({ text: item, index: i, isParagraphEnd: false });
    } else {
      const idx = item.index ?? i;
      if (idx >= startIndex) chunks.push({ text: item.text, index: idx, isParagraphEnd: !!item.isParagraphEnd });
    }
  }
  return chunks;
}

async function playFrom({ tabId, items, texts, startIndex = 0 }) {
  const my = ++session;

  worker.postMessage({ type: 'SET_SESSION', sessionId: my });
  worker.postMessage({ type: 'CLEAR_QUEUE' });
  pendingRequests.clear();
  haltAudio();
  isPaused = false;
  skipTarget = null;
  if (pauseResolve) { const r = pauseResolve; pauseResolve = null; r(); }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  report({ state: 'buffering', progress: 1, tabId });
  const chunks = plan(items || texts, startIndex);
  currentChunks = chunks;
  if (!chunks.length) {
    send({ type: 'FINISHED', tabId });
    report({ state: 'ready', progress: 1 });
    return;
  }

  const BUFFER_AHEAD = 4; // Keep 4 sentences ahead in background worker queue

  // Pre-queue first sentence as high priority, next sentences as normal prefetch
  if (chunks.length > 0) {
    requestChunk(my, 0, chunks[0].text, settings, 'high');
  }
  for (let i = 1; i < Math.min(chunks.length, BUFFER_AHEAD); i++) {
    requestChunk(my, i, chunks[i].text, settings, 'normal');
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

    // Prioritize synthesis for currently active chunk
    requestChunk(my, c, chunks[c].text, settings, 'high');

    // Keep pipeline filled from current position c
    for (let ahead = 1; ahead <= BUFFER_AHEAD && c + ahead < chunks.length; ahead++) {
      requestChunk(my, c + ahead, chunks[c + ahead].text, settings, 'normal');
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
      const key = cacheKey(settings.voice, settings.speed, chunks[c].text);
      if (!audioCache.has(key) && !isPaused) {
        report({ state: 'buffering', tabId });
      }
      raw = await requestChunk(my, c, chunks[c].text, settings, 'high');
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

    // Pre-roll watermark: on initial playback, ensure enough audio is buffered in RAM
    // to prevent any secondary stall after the first sentence.
    // If chunk 0 has less than 10.0s of speech, pre-buffer chunk 1 as well.
    if (lastAudioEnd === 0 && c === 0 && c + 1 < chunks.length) {
      const dur0 = raw.audio.length / raw.sampling_rate;
      if (dur0 < 10.0) {
        tlog(`⏳ [PRE-ROLL] Initial sentence has ${dur0.toFixed(2)}s audio (<10s). Pre-buffering sentence #1 so playback never stalls...`);
        try {
          await requestChunk(my, c + 1, chunks[c + 1].text, settings, 'high');
        } catch {}
      }
    }

    // Natural inter-sentence pause: 500ms between sentences, 1000ms at paragraph ends.
    // Subtract time already spent waiting for synthesis.
    // If synthesis stalled and already took longer than target pause, wait 0ms (play immediately!).
    if (lastAudioEnd > 0) {
      const prevChunk = c > 0 ? chunks[c - 1] : null;
      const targetGapMs = prevChunk?.isParagraphEnd ? 1000 : 500;
      const elapsedSinceAudioEnd = performance.now() - lastAudioEnd;
      const remainingGapMs = Math.max(0, targetGapMs - elapsedSinceAudioEnd);
      if (remainingGapMs > 0) {
        let pauseTimer = null;
        await new Promise((res) => {
          pauseTimer = setTimeout(res, remainingGapMs);
          current = { clearPause: () => { clearTimeout(pauseTimer); res(); } };
        });
        current = null;
      }
    }

    if (my !== session) return;
    if (skipTarget != null) continue;

    if (chunks[c].index !== shown) {
      shown = chunks[c].index;
      send({ type: 'PROGRESS', tabId, index: shown });
    }

    await play(raw, c, tabId);
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
  worker.postMessage({ type: 'SET_SESSION', sessionId: session });
  worker.postMessage({ type: 'CLEAR_QUEUE' });
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
    case 'SETTINGS': {
      const changed = settings.voice !== msg.voice || settings.speed !== msg.speed;
      settings = { voice: msg.voice, speed: msg.speed };
      // Invalidate pre-buffered sentences if voice/speed changed while paused
      if (changed && isPaused) {
        worker.postMessage({ type: 'CLEAR_QUEUE' });
        pendingRequests.clear();
      }
      sendResponse?.({ ok: true });
      break;
    }
    case 'PRELOAD':
      worker.postMessage({ type: 'PRELOAD' });
      sendResponse?.({ ok: true });
      break;
  }
});
