import { DEFAULTS, getSettings } from './shared/settings.js';
import { VOICES } from './shared/voices.js';
import { posKey } from './shared/position.js';

const $ = (id) => document.getElementById(id);
const RING = 289.03; // 2πr, r = 46

// ---------- engine state ----------
const LABELS = {
  idle: ['The voice model loads when you start reading.', 'Read this page'],
  loading: [null, 'Loading'],
  ready: ['Ready', 'Read this page'],
  playing: ['Reading', 'Pause'],
  paused: ['Paused', 'Resume'],
  error: [null, 'Try again'],
};

let engineState = { state: 'idle' };
let saved = null; // saved reading position for the active tab

function render(engine = engineState) {
  engineState = engine;
  const state = LABELS[engine.state] ? engine.state : 'idle';
  let [status, action] = LABELS[state];
  const canResume = saved && ['idle', 'ready', 'error'].includes(state);
  if (canResume) action = 'Resume';
  document.body.dataset.state = state;

  $('status').textContent =
    state === 'loading' ? `Loading the voice model, ${Math.round((engine.progress || 0) * 100)}%`
    : state === 'error' ? engine.message || 'Something went wrong.'
    : status;
  $('playLabel').textContent = action;
  $('play').setAttribute('aria-label', action);
  $('ring').style.strokeDashoffset = String(RING * (1 - (engine.progress || 0)));
  $('stop').disabled = !['playing', 'paused', 'loading'].includes(state);
  $('fromTop').hidden = !canResume;
  $('playHint').hidden = !!canResume;
  renderResume(canResume);
}

function renderResume(show) {
  $('resume').hidden = !show;
  if (!show) return;
  const pct = Math.round(((saved.index + 1) / Math.max(saved.total, 1)) * 100);
  $('resumeFill').style.width = `${pct}%`;
  $('resumePct').textContent = `${pct}% read`;
  $('resumeText').textContent = saved.text;
}

// The saved position for whatever tab is active.
let activeKey = null;
async function loadSaved() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeKey = tab?.url ? posKey(tab.url) : null;
  saved = activeKey ? (await chrome.storage.local.get(activeKey))[activeKey] ?? null : null;
  render();
}

function note(text) {
  $('note').textContent = text || '';
  $('note').hidden = !text;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.engine) render(changes.engine.newValue);
  if (area === 'local' && activeKey && changes[activeKey]) {
    saved = changes[activeKey].newValue ?? null;
    render();
  }
});

$('fromTop').addEventListener('click', async () => {
  note();
  const res = await chrome.runtime.sendMessage({ type: 'READ_FROM_TOP' });
  if (res?.ok === false) note(res.error);
});

$('play').addEventListener('click', async () => {
  note();
  const res = await chrome.runtime.sendMessage({ type: 'TOGGLE' });
  if (res?.ok === false) note(res.error);
});

$('stop').addEventListener('click', () => {
  note();
  chrome.runtime.sendMessage({ type: 'STOP' });
});

// ---------- settings ----------
function fillVoices(selected) {
  const groups = { 'en-us': 'American English', 'en-gb': 'British English' };
  const select = $('voice');
  for (const [lang, label] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [id, v] of Object.entries(VOICES)) {
      if (v.lang !== lang) continue;
      og.append(new Option(`${v.name} (${v.gender.toLowerCase()}, ${v.grade})`, id, false, id === selected));
    }
    select.append(og);
  }
}

const fmtSpeed = (v) => `${Number(v).toFixed(2)}×`;
const save = (patch) => chrome.storage.sync.set(patch);

async function initSettings() {
  const s = await getSettings();
  fillVoices(s.voice);
  $('speed').value = s.speed;
  $('speedOut').value = fmtSpeed(s.speed);
  $('clickToRead').checked = s.clickToRead;
  $('autoScroll').checked = s.autoScroll;
  $('highlightColor').value = s.highlightColor;

  $('voice').addEventListener('change', (e) => save({ voice: e.target.value }));
  $('speed').addEventListener('input', (e) => { $('speedOut').value = fmtSpeed(e.target.value); });
  $('speed').addEventListener('change', (e) => save({ speed: Number(e.target.value) }));
  $('clickToRead').addEventListener('change', (e) => save({ clickToRead: e.target.checked }));
  $('autoScroll').addEventListener('change', (e) => save({ autoScroll: e.target.checked }));
  $('highlightColor').addEventListener('change', (e) => save({ highlightColor: e.target.value || DEFAULTS.highlightColor }));
}

// ---------- shortcuts (reflect whatever the user has set in Chrome) ----------
async function renderKeys() {
  const dl = $('keys');
  const commands = await chrome.commands.getAll();
  const rows = [['Click', 'Start reading from that sentence'], ['Right-click', 'Read aloud from here'], ...commands.map((c) => [c.shortcut || 'Not set', c.description])];
  for (const [key, what] of rows) {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = what;
    dl.append(dt, dd);
  }
}
$('editKeys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- boot ----------
initSettings();
renderKeys();
loadSaved();
chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((engine) => {
  render(engine);
  // Opening the popup is a good hint you're about to read: warm the model up.
  if (engine?.state === 'idle') chrome.runtime.sendMessage({ type: 'PRELOAD' });
});
