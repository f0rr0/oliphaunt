import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStrictJson } from './strict-json.mts';
test('preserves JSON values and rejects duplicate keys, including escaped aliases', () => {
  const value = { a: ['{"x":1}', { b: true }], c: null, d: '}', e: 'key:"value"' };
  assert.deepEqual(parseStrictJson(JSON.stringify(value, null, 2)), value);
  for (const source of [
    '{"a":1,"\\u0061":2}',
    '{"list":[{"a":1,"a":2}]}',
    '{"a":1,}',
    '{"a":1}\u00a0',
  ]) {
    assert.throws(() => parseStrictJson(source));
  }
});
