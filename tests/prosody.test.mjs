import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceProsody } from '../src/shared/prosody.js';

test('enhanceProsody: adds breath pause comma after intro adverbs', () => {
  assert.equal(
    enhanceProsody('However they could not find it.'),
    'However, they could not find it.'
  );
  assert.equal(
    enhanceProsody('In fact the results were conclusive.'),
    'In fact, the results were conclusive.'
  );
  assert.equal(
    enhanceProsody('Of course we agreed.'),
    'Of course, we agreed.'
  );
});

test('enhanceProsody: leaves intro adverbs with existing punctuation intact', () => {
  assert.equal(
    enhanceProsody('However, they could not find it.'),
    'However, they could not find it.'
  );
});

test('enhanceProsody: converts parenthetical dashes to em-dashes', () => {
  assert.equal(
    enhanceProsody('The design -- while ambitious -- was feasible.'),
    'The design — while ambitious — was feasible.'
  );
  assert.equal(
    enhanceProsody('The design – while ambitious – was feasible.'),
    'The design — while ambitious — was feasible.'
  );
});

test('enhanceProsody: normalizes ellipses for trailing pitch drop', () => {
  assert.equal(
    enhanceProsody('Wait… she said.'),
    'Wait... she said.'
  );
  assert.equal(
    enhanceProsody('I wonder..... could it be?'),
    'I wonder... could it be?'
  );
});

test('enhanceProsody: expands shorthand terms that sound robotic', () => {
  assert.equal(
    enhanceProsody('Coffee w/ milk vs. black coffee.'),
    'Coffee with milk versus black coffee.'
  );
  assert.equal(
    enhanceProsody('e.g. Kokoro TTS'),
    'for example, Kokoro TTS'
  );
});
