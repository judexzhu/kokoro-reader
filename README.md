# Kokoro Reader

A Chrome (MV3) extension that reads web pages aloud with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), running fully on-device. The model, voices and ONNX Runtime are all **bundled with the extension**, so there are no CDN or Hugging Face requests at runtime.

## Quick start

```bash
npm install
npm run fetch-model   # ~92 MB q8 model into models/
npm run build         # outputs dist/
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `dist/`.

Open any normal web page and reload it once. Then start reading in any of these ways:

- **Click** a sentence to start reading from it.
- **Right-click** and choose **Read aloud from here**, or **Read selection aloud**.
- **Select text** and press play to read only that selection.
- **Press play** to read the page's main content. If you've read this page before, play shows **Resume** instead.

As it reads, the current sentence is highlighted and the page scrolls to follow along. Your position is saved per page (the URL without its `#hash`). The popup shows how far you got, and **Start from the top** ignores the saved spot. Once you reach the end of a page, its saved position is cleared. The 300 most recent pages are kept.

**About streaming:** Kokoro renders each utterance in one pass, so it can't stream audio word by word. Instead, the engine streams sentence by sentence, synthesizing the next sentence while the current one plays. It also splits a long first sentence at its first comma so audio starts sooner.

During development, run `npm run watch` and click reload on the extension card after each rebuild.

## Architecture

```
popup ──TOGGLE/STOP──▶ background (service worker) ──PLAY/PAUSE/STOP/SKIP──▶ offscreen (player)
                          ▲   │  HIGHLIGHT/CLEAR/NAV                            │  ▲ (zero-copy Float32Array)
content script ──READ─────┘   ▼                                                 ▼  │
(sentences + Ranges,      content script  ◀──────── PROGRESS/FINISHED ──────── worker (ONNX WASM)
 click-to-read, highlight)
```

| File | Role |
|---|---|
| `src/content.js` | Walks text nodes, groups by block, splits with `Intl.Segmenter`, keeps DOM `Range` per sentence. Highlights with CSS Custom Highlight API (zero DOM mutation). Capture-phase click-to-read and right-click support. |
| `src/background.js` | Manages offscreen lifecycle, routes messages, registers persistent context menus, handles keyboard shortcuts (`Option+J`/`K` navigation, `Option+Shift+S` play/pause). |
| `src/offscreen.js` | Lightweight Web Audio player with 50-item in-memory LRU cache, instant worker abort on skip/jump, and pause/resume barrier. |
| `src/worker.js` | Dedicated background Web Worker for Kokoro ONNX inference. Runs on dedicated OS thread with multi-core WASM (`numThreads: 4` via cross-origin isolation). |
| `src/popup.*` | Play/pause/stop, voice, speed, toggles, highlight color, and live shortcut list. |
| `src/config.js` | Model ID, dtype and device. Shared by the engine, build and fetch scripts. |

## Offline-first details

These are the pitfalls that break similar extensions:

- **Model from the CDN.** Hugging Face now redirects downloads to `*.cdn.hf.co`, which most extension CSPs block. This extension sets `env.allowRemoteModels = false` and loads from `models/` inside the extension.
- **Voices.** kokoro-js fetches voice `.bin` files from a hard-coded Hugging Face URL but checks the `kokoro-voices` Cache Storage first. The engine seeds that cache from the bundled `voices/` folder, copied from the kokoro-js npm package.
- **ONNX Runtime WASM.** It defaults to jsDelivr, which MV3 can't import remote code from. `wasmPaths` points to the bundled `ort/` folder instead.
- **Threads.** Offscreen documents aren't cross-origin isolated, so `numThreads = 1`.

## Configuration

- **WebGPU (faster on Apple Silicon or discrete GPUs):** in `src/config.js`, set `DTYPE = 'fp32'` and `DEVICE = 'webgpu'`, then run `npm run fetch-model && npm run build`. If you already downloaded `model.onnx` (fp32), place it at `models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx` to skip the download.
- **Sentence length:** `maxChars` in `src/shared/settings.js` (default 300).

## Known limitations

- Chrome closes an `AUDIO_PLAYBACK` offscreen document after about 30 seconds without audio, so the model reloads (a few seconds, from local files) after a long idle.
- Extensions can't run on `chrome://` pages, the Chrome Web Store, or the New Tab page.
- kokoro-js supports English voices only (American and British).
- Auto-scroll uses `scrollIntoView`, which may be imperfect on pages with unusual scroll containers.

## Ideas for next steps

- A Readability-based "article mode" that skips boilerplate.
- Word-level highlighting, using phoneme timing or estimated per-word durations.
- A context menu entry: "Read selection" and "Read from here".
- A WebGPU/WASM auto-detect fallback.
