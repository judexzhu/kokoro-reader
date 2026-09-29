// Service worker: owns the offscreen engine's lifecycle and routes messages
// between the popup, content scripts and the engine.
import { getSettings } from './shared/settings.js';
import { MAX_SAVED_POSITIONS } from './shared/position.js';

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

const CANT_READ =
  "This page can't be read. Chrome doesn't let extensions access chrome:// pages, the Chrome Web Store or the New Tab page.";

// ---------- session state (survives service-worker restarts) ----------
async function sget(key, fallback) {
  const r = await chrome.storage.session.get(key);
  return r[key] ?? fallback;
}
const sset = (obj) => chrome.storage.session.set(obj);

// ---------- engine (offscreen document) ----------
async function engineAlive() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureEngine() {
  if (await engineAlive()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Synthesizes speech with an on-device model and plays it.',
    })
    .finally(() => { creating = null; });
  await creating;
}

async function toEngine(msg, { create = true } = {}) {
  if (create) await ensureEngine();
  else if (!(await engineAlive())) return;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  } catch (err) {
    console.warn('Engine message failed', msg.type, err);
  }
}

// ---------- tabs ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// Tabs opened before the extension was installed/reloaded have no content
// script yet; inject on demand instead of failing.
async function sendToTab(tabId, msg, { inject = false } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    if (!inject) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

// ---------- actions ----------
async function startOnActiveTab({ fromTop = false } = {}) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  try {
    return (await sendToTab(tab.id, { type: 'READ_START', fromTop }, { inject: true })) ?? { ok: true };
  } catch {
    return { ok: false, error: CANT_READ };
  }
}

async function beginReading(tabId, items, startIndex) {
  const prev = await sget('readingTab', null);
  if (prev != null && prev !== tabId) sendToTab(prev, { type: 'CLEAR' }).catch(() => {});
  await sset({ readingTab: tabId });
  const { voice, speed } = await getSettings();
  await toEngine({ type: 'PLAY', tabId, items, startIndex, voice, speed });
}

async function stopReading() {
  await toEngine({ type: 'STOP' }, { create: false });
  const tabId = await sget('readingTab', null);
  if (tabId != null) sendToTab(tabId, { type: 'CLEAR' }).catch(() => {});
  await sset({ readingTab: null });
}

async function toggle() {
  const alive = await engineAlive();
  const { state } = await sget('engine', { state: 'idle' });
  if (alive && state === 'playing') { await toEngine({ type: 'PAUSE' }, { create: false }); return { ok: true }; }
  if (alive && state === 'paused') { await toEngine({ type: 'RESUME' }, { create: false }); return { ok: true }; }
  return startOnActiveTab();
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return; // addressed to the engine

  const handle = async () => {
    switch (msg.type) {
      // from content scripts
      case 'READ':
        if (!sender.tab?.id) return { ok: false };
        await beginReading(sender.tab.id, msg.items || msg.texts, msg.startIndex);
        return { ok: true };

      // from the popup
      case 'TOGGLE': return toggle();
      case 'READ_FROM_TOP': return startOnActiveTab({ fromTop: true });
      case 'STOP': await stopReading(); return { ok: true };
      case 'PRELOAD': await toEngine({ type: 'PRELOAD' }); return { ok: true };
      case 'GET_STATE':
        return (await engineAlive()) ? sget('engine', { state: 'idle' }) : { state: 'idle' };

      // from the engine
      case 'STATUS':
        await sset({ engine: msg.status });
        return;
      case 'PROGRESS':
        sendToTab(msg.tabId, { type: 'HIGHLIGHT', index: msg.index }).catch(() => {});
        return;
      case 'TELEMETRY':
        if (msg.tabId) sendToTab(msg.tabId, { type: 'TELEMETRY', line: msg.line }).catch(() => {});
        return;
      case 'FINISHED':
        sendToTab(msg.tabId, { type: 'CLEAR', finished: true }).catch(() => {});
        await sset({ readingTab: null });
        return;
    }
  };

  handle().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// ---------- keyboard shortcuts ----------
chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'toggle-reading': return toggle();
    case 'stop-reading': return stopReading();
    case 'next-sentence':
    case 'prev-sentence': {
      const alive = await engineAlive();
      const { state } = await sget('engine', { state: 'idle' });
      const delta = command === 'next-sentence' ? 1 : -1;
      if (alive && (state === 'playing' || state === 'paused')) {
        await toEngine({ type: 'SKIP', delta }, { create: false });
        return;
      }
      const tabId = (await sget('readingTab', null)) ?? (await activeTab())?.id;
      if (tabId == null) return;
      sendToTab(tabId, { type: 'NAV', delta }, { inject: true }).catch(() => {});
    }
  }
});

// ---------- housekeeping ----------
async function stopIfReading(tabId) {
  if (tabId === (await sget('readingTab', null))) stopReading();
}
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') stopIfReading(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => stopIfReading(tabId));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(changes.voice || changes.speed)) return;
  getSettings().then(({ voice, speed }) => toEngine({ type: 'SETTINGS', voice, speed }, { create: false }));
});

// ---------- right-click menu ----------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'read-from-here',
      title: 'Read starting here',
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'read-selection',
      title: 'Read selection aloud',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'read-selection' ? 'READ_SELECTION' : 'READ_FROM_CONTEXT_MENU';
  sendToTab(tab.id, { type }, { inject: true }).catch(() => {});
});

// Keep only the most recent saved reading positions.
async function prunePositions() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('pos:'));
  if (entries.length <= MAX_SAVED_POSITIONS) return;
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  await chrome.storage.local.remove(entries.slice(MAX_SAVED_POSITIONS).map(([k]) => k));
}

const reset = () => sset({ engine: { state: 'idle' }, readingTab: null });
createMenus();
chrome.runtime.onInstalled.addListener(() => { reset(); createMenus(); prunePositions(); });
chrome.runtime.onStartup.addListener(() => { reset(); createMenus(); prunePositions(); });
