// Content script: turns the page into sentences (each backed by a DOM Range),
// starts reading from a click / selection / main content, and highlights
// the sentence being spoken with the CSS Custom Highlight API (no DOM edits).
import { DEFAULTS } from './shared/settings.js';
import { posKey } from './shared/position.js';

(() => {
  if (window.__kokoroReader) return; // guard against double injection
  window.__kokoroReader = true;

  const HL = 'kokoro-reader-current';
  const SKIP =
    'script,style,noscript,template,svg,math,textarea,input,select,button,nav,footer,aside,' +
    '[aria-hidden="true"],[hidden],[contenteditable=""],[contenteditable="true"]';
  const BLOCKS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TD', 'TH',
    'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SECTION', 'ARTICLE', 'HEADER', 'MAIN', 'SUMMARY', 'BODY',
  ]);
  const INTERACTIVE = 'a,button,input,textarea,select,label,summary,video,audio,[role="button"],[contenteditable]';

  let settings = { ...DEFAULTS };
  let sentences = []; // [{ text, range, block }]
  let current = -1;
  let mode = 'page'; // 'page' saves the position; 'selection' doesn't
  let lastContextMenu = null; // where the user right-clicked

  // ---------- settings + highlight style ----------
  const styleEl = document.createElement('style');
  function applyStyle() {
    styleEl.textContent = `::highlight(${HL}){background-color:${rgba(settings.highlightColor, 0.45)};color:inherit;}`;
    if (!styleEl.isConnected) (document.head || document.documentElement).append(styleEl);
  }
  chrome.storage.sync.get(DEFAULTS).then((s) => { settings = s; applyStyle(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    applyStyle();
  });

  // ---------- text extraction ----------
  function blockOf(node) {
    let el = node.parentElement;
    while (el && !BLOCKS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  function collectSentences(root = document.body) {
    const ok = new WeakMap();
    const readable = (el) => {
      if (!ok.has(el)) ok.set(el, !el.closest(SKIP) && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      return ok.get(el);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue.trim() && n.parentElement && readable(n.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });

    // Group consecutive text nodes by their block ancestor.
    const segments = [];
    let seg = null;
    for (let n; (n = walker.nextNode()); ) {
      const block = blockOf(n);
      if (!seg || seg.block !== block) segments.push((seg = { block, parts: [], text: '' }));
      seg.parts.push({ node: n, start: seg.text.length });
      seg.text += n.nodeValue;
    }

    let splitter;
    try {
      splitter = new Intl.Segmenter(document.documentElement.lang, { granularity: 'sentence' });
    } catch {
      splitter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
    const out = [];
    for (const s of segments) {
      for (const { segment, index } of splitter.segment(s.text)) {
        for (const [a, b] of splitLong(segment, index, settings.maxChars)) {
          const raw = s.text.slice(a, b);
          const start = a + (raw.length - raw.trimStart().length);
          const end = b - (raw.length - raw.trimEnd().length);
          if (end <= start) continue;
          const text = s.text.slice(start, end).replace(/\s+/g, ' ');
          if (!/[\p{L}\p{N}]/u.test(text)) continue;
          out.push({ text, block: s.block, range: rangeFor(s.parts, start, end) });
        }
      }
    }
    return out;
  }

  // Break very long "sentences" at punctuation, falling back to spaces.
  function splitLong(str, offset, max) {
    const pieces = [];
    let from = 0;
    while (str.length - from > max) {
      const window = str.slice(from, from + max);
      let cut = Math.max(...[',', ';', ':', '—', ')'].map((c) => window.lastIndexOf(c)));
      if (cut < max * 0.4) cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = max - 1;
      pieces.push([offset + from, offset + from + cut + 1]);
      from += cut + 1;
    }
    pieces.push([offset + from, offset + str.length]);
    return pieces;
  }

  function rangeFor(parts, start, end) {
    const locate = (pos, isEnd) => {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (isEnd ? pos > p.start : pos >= p.start) return { node: p.node, offset: pos - p.start };
      }
      return { node: parts[0].node, offset: 0 };
    };
    const s = locate(start, false);
    const e = locate(end, true);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, Math.min(e.offset, e.node.nodeValue.length));
    return r;
  }

  // ---------- starting points ----------
  function start(list, index, readMode = 'page') {
    if (!list.length) return { ok: false, error: 'No readable text found on this page.' };
    sentences = list;
    mode = readMode;
    current = Math.max(0, Math.min(index, list.length - 1));
    const items = list.map((s, i) => ({
      text: s.text,
      isParagraphEnd: i === list.length - 1 || s.block !== list[i + 1].block,
    }));
    try {
      if (!chrome.runtime?.id) return { ok: false };
      chrome.runtime.sendMessage({ type: 'READ', items, texts: list.map((s) => s.text), startIndex: current }).catch(() => {});
    } catch {}
    return { ok: true };
  }

  function readSelection(sel) {
    const r = sel.getRangeAt(0);
    const picked = collectSentences().filter(
      (s) =>
        s.range.compareBoundaryPoints(Range.START_TO_END, r) > 0 &&
        s.range.compareBoundaryPoints(Range.END_TO_START, r) < 0,
    );
    return start(picked, 0, 'selection');
  }

  function readPage(all = collectSentences()) {
    const main = document.querySelector('article, main, [role="main"]');
    const i = main ? all.findIndex((s) => main.contains(s.block)) : 0;
    return start(all, Math.max(i, 0));
  }

  async function resumeOrReadPage({ fromTop = false } = {}) {
    const all = collectSentences();
    if (!fromTop) {
      const saved = await loadPosition();
      const i = saved ? findSaved(all, saved) : -1;
      if (i >= 0) return start(all, i);
    }
    return readPage(all);
  }

  function caretAt(x, y) {
    const p = document.caretPositionFromPoint?.(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  // Start at the sentence under (x, y). Returns null if nothing readable is there.
  function startAtPoint(x, y, target) {
    const pos = caretAt(x, y);
    const all = collectSentences();
    if (!all.length) return null;

    let idx = -1;

    // 1. Exact sentence containing the caret position
    if (pos) {
      idx = all.findIndex((s) => {
        try { return s.range.isPointInRange(pos.node, pos.offset); } catch { return false; }
      });
    }

    // 2. Element intersection fallback (clicked element contains or intersects sentence)
    const el = target || document.elementFromPoint(x, y);
    if (idx < 0 && el) {
      idx = all.findIndex((s) => {
        try {
          return s.range.intersectsNode(el) || el.contains(s.range.startContainer);
        } catch {
          return false;
        }
      });
    }

    // 3. Fallback to clicked element's block ancestor
    if (idx < 0 && el) {
      const block = blockOf(el);
      idx = all.findIndex((s) => s.block === block);
    }

    // 4. Fallback to first sentence following caret
    if (idx < 0 && pos) {
      idx = all.findIndex((s) => {
        try { return s.range.comparePoint(pos.node, pos.offset) <= 0; } catch { return false; }
      });
    }

    if (idx < 0) return null;
    console.log(`%c[Kokoro TTS] Click to read -> sentence #${idx}: "${all[idx].text.slice(0, 45)}..."`, 'color: #f2b544;');
    highlight(idx);
    return start(all, idx);
  }

  const onPageClick = (e) => {
    if (!chrome.runtime?.id) {
      document.removeEventListener('click', onPageClick, true);
      return;
    }
    if (!settings.clickToRead || e.button !== 0) return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (!(e.target instanceof Element) || e.target.closest(INTERACTIVE)) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return; // user is selecting text
    startAtPoint(e.clientX, e.clientY, e.target);
  };
  document.addEventListener('click', onPageClick, true);

  const onContextMenu = (e) => {
    if (!chrome.runtime?.id) {
      document.removeEventListener('contextmenu', onContextMenu, true);
      return;
    }
    lastContextMenu = { x: e.clientX, y: e.clientY, target: e.target };
  };
  document.addEventListener('contextmenu', onContextMenu, true);

  // ---------- saved position ----------
  async function loadPosition() {
    if (!chrome.runtime?.id) return null;
    try {
      const key = posKey(location.href);
      return key ? (await chrome.storage.local.get(key))[key] : null;
    } catch {
      return null;
    }
  }

  function savePosition(index) {
    if (!chrome.runtime?.id) return;
    const key = posKey(location.href);
    const s = sentences[index];
    if (!key || !s || mode !== 'page') return;
    try {
      chrome.storage.local.set({
        [key]: { index, total: sentences.length, text: s.text.slice(0, 200), title: document.title, at: Date.now() },
      }).catch(() => {});
    } catch {}
  }

  function forgetPosition() {
    if (!chrome.runtime?.id) return;
    const key = posKey(location.href);
    if (key && mode === 'page') {
      try { chrome.storage.local.remove(key).catch(() => {}); } catch {}
    }
  }

  // Pages change between visits, so match the saved sentence by text and use
  // the saved index only to pick the nearest match (or as a last resort).
  function findSaved(all, saved) {
    let best = -1;
    let bestDist = Infinity;
    all.forEach((s, i) => {
      if (s.text.slice(0, 200) !== saved.text) return;
      const d = Math.abs(i - saved.index);
      if (d < bestDist) { best = i; bestDist = d; }
    });
    if (best >= 0) return best;
    return saved.index < all.length ? saved.index : -1;
  }

  // ---------- highlighting ----------
  function highlight(index) {
    const s = sentences[index];
    if (!s) return;
    current = index;
    try {
      CSS.highlights.set(HL, new Highlight(s.range));
      if (settings.autoScroll) {
        const rect = s.range.getBoundingClientRect();
        const margin = innerHeight * 0.15;
        if (rect.top < margin || rect.bottom > innerHeight - margin) {
          s.range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    } catch {
      /* DOM changed under us; skip the highlight */
    }
  }

  function clear() {
    CSS.highlights.delete(HL);
    current = -1;
  }

  // ---------- messages ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'READ_START': {
        const sel = getSelection();
        if (!msg.fromTop && sel && !sel.isCollapsed && sel.toString().trim()) {
          sendResponse(readSelection(sel));
          return;
        }
        resumeOrReadPage({ fromTop: msg.fromTop }).then(sendResponse);
        return true; // async response
      }
      case 'READ_SELECTION': {
        const sel = getSelection();
        sendResponse(sel && !sel.isCollapsed ? readSelection(sel) : { ok: false, error: 'Nothing is selected.' });
        return;
      }
      case 'READ_FROM_CONTEXT_MENU': {
        const c = lastContextMenu;
        const res = c && startAtPoint(c.x, c.y, c.target);
        sendResponse(res || readPage());
        return;
      }
      case 'TELEMETRY':
        console.log(`%c[Kokoro TTS] ${msg.line}`, 'color: #f2b544; font-weight: bold;');
        break;
      case 'HIGHLIGHT':
        highlight(msg.index);
        savePosition(msg.index);
        break;
      case 'CLEAR':
        if (msg.finished) forgetPosition(); // read to the end: next time start fresh
        clear();
        break;
      case 'NAV': {
        if (!sentences.length) sentences = collectSentences();
        if (sentences.length) {
          const next = Math.max(0, Math.min((current < 0 ? 0 : current) + msg.delta, sentences.length - 1));
          highlight(next);
          start(sentences, next, mode);
        }
        break;
      }
    }
  });

  function rgba(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
})();
