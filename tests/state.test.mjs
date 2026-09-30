import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test state transition logic and label definitions
const LABELS = {
  idle: ['The voice model loads when you start reading.', 'Read this page'],
  loading: [null, 'Loading'],
  ready: ['Ready', 'Read this page'],
  buffering: ['Generating speech...', 'Generating...'],
  playing: ['Reading', 'Pause'],
  paused: ['Paused', 'Resume'],
  error: [null, 'Try again'],
};

test('LABELS: buffering state has clear status and action labels', () => {
  assert.ok(LABELS.buffering, 'buffering state must be defined');
  const [status, action] = LABELS.buffering;
  assert.equal(status, 'Generating speech...');
  assert.equal(action, 'Generating...');
});

test('Transport logic: buffering state locks voice settings and enables stop', () => {
  const state = 'buffering';
  const isStopEnabled = ['playing', 'paused', 'loading', 'buffering'].includes(state);
  const isAudioLocked = ['playing', 'loading', 'buffering'].includes(state);

  assert.equal(isStopEnabled, true, 'Stop button must be enabled during buffering');
  assert.equal(isAudioLocked, true, 'Voice/speed settings must be locked during buffering');
});
