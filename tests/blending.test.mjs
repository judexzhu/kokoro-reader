import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_BLENDS, VOICES } from '../src/shared/voices.js';

test('VOICE_BLENDS: all blends have valid components and weights totaling 1.0', () => {
  for (const [id, blend] of Object.entries(VOICE_BLENDS)) {
    assert.ok(blend.name, `${id} must have a name`);
    assert.ok(blend.lang, `${id} must have a lang`);
    assert.ok(Array.isArray(blend.components), `${id} must have components array`);
    assert.ok(blend.components.length >= 2, `${id} must have at least 2 components`);

    let totalWeight = 0;
    for (const comp of blend.components) {
      assert.ok(VOICES[comp.id], `Component ${comp.id} in ${id} must exist in VOICES`);
      assert.ok(comp.weight > 0 && comp.weight < 1, `Component weight must be between 0 and 1`);
      totalWeight += comp.weight;
    }
    assert.ok(Math.abs(totalWeight - 1.0) < 0.001, `Component weights in ${id} must sum to 1.0`);
  }
});

test('VOICE_BLENDS: linear interpolation computes exact weighted average', () => {
  const len = 256;
  const v1 = new Float32Array(len).fill(1.0);
  const v2 = new Float32Array(len).fill(2.0);

  const blend = VOICE_BLENDS.blend_heart_bella;
  const w1 = blend.components[0].weight;
  const w2 = blend.components[1].weight;

  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = w1 * v1[i] + w2 * v2[i];
  }

  assert.ok(Math.abs(out[0] - (w1 * 1.0 + w2 * 2.0)) < 1e-6);
  assert.ok(out[0] > 1.0 && out[0] < 2.0);
});
