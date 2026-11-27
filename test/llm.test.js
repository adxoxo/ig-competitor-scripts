import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShape, SCHEMA } from '../lib/llm.js';
import { postTitle } from '../lib/view.js';
import { goodAnalysis } from './helpers.js';

test('checkShape accepts the page shape and names the problem otherwise', () => {
  assert.equal(checkShape(goodAnalysis), null);
  assert.match(checkShape({ ...goodAnalysis, scripts: [] }), /exactly 3/);
  assert.match(checkShape({ ...goodAnalysis, shared: [] }), /shared/);
  assert.match(checkShape({ ...goodAnalysis, differs: [{ t: 'x', d: '', ev: '1' }] }), /empty field/);
  assert.match(checkShape({ ...goodAnalysis, scripts: [{}, {}, {}] }), /empty field/);
  assert.match(checkShape(null), /not an object/);
});

test('schema uses only features that structured output supports', () => {
  const text = JSON.stringify(SCHEMA);
  for (const word of ['minItems', 'maxItems', 'minLength', 'maxLength', 'oneOf', 'minimum']) assert.ok(!text.includes(word), word);
  assert.equal(SCHEMA.additionalProperties, false);
});

test('postTitle takes the first non-empty caption line', () => {
  assert.equal(postTitle('\n  First line  \nsecond'), 'First line');
  assert.equal(postTitle(''), '(no caption)');
  assert.equal(postTitle('x'.repeat(200)).length, 90);
});
