import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLong } from '../src/shared/chunking.js';
import { DEFAULTS } from '../src/shared/settings.js';

test('DEFAULTS: maxChars is set to 180 for balanced streaming TTS', () => {
  assert.equal(DEFAULTS.maxChars, 180);
});

test('splitLong: leaves sentences under maxChars intact', () => {
  const text = 'This is a clean, natural sentence under the limit.';
  const chunks = splitLong(text, 0, 180);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], [0, text.length]);
});

test('Pre-roll logic: short initial chunk triggers pre-buffering', () => {
  const PRE_ROLL_MIN_SEC = 4.0;
  const isInitial = (lastAudioEnd, c) => lastAudioEnd === 0 && c === 0;
  const needsPreRoll = (dur, lastAudioEnd, c, hasNext) => isInitial(lastAudioEnd, c) && dur < PRE_ROLL_MIN_SEC && hasNext;

  assert.equal(needsPreRoll(1.5, 0, 0, true), true, 'Short title (1.5s) must pre-roll next chunk');
  assert.equal(needsPreRoll(6.5, 0, 0, true), false, 'Normal sentence (6.5s) starts immediately');
  assert.equal(needsPreRoll(1.5, 1000, 1, true), false, 'Subsequent chunks do not trigger initial pre-roll');
  assert.equal(needsPreRoll(1.5, 0, 0, false), false, 'Single-sentence text plays immediately');
});

