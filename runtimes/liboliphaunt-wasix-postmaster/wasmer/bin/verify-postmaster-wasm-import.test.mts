import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { verify } from './verify-postmaster-wasm-import.mts';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const name = (text: string) => [text.length, ...Buffer.from(text)];
function module(
  namespace = 'oliphaunt_postmaster_v1',
  field = 'fd_sync_range',
  params = [127, 126, 126, 127],
  copies = 1,
) {
  const type = [1, 96, params.length, ...params, 1, 127];
  const entry = [...name(namespace), ...name(field), 0, 0];
  const imports = [copies, ...Array.from({ length: copies }, () => entry).flat()];
  return Buffer.from([...header, 1, type.length, ...type, 2, imports.length, ...imports]);
}

test('required postmaster import preserves namespace, uniqueness, and ABI', () => {
  verify(module());
  assert.throws(() => verify(module('wasix_32v1')), /forbidden/);
  assert.throws(() => verify(module(undefined, 'fd_sync')), /exactly one/);
  assert.throws(() => verify(module(undefined, undefined, [127])), /signature/);
  assert.throws(() => verify(module(undefined, undefined, undefined, 2)), /exactly one/);
  assert.throws(() => verify(module(undefined, undefined, undefined, 0)), /exactly one/);
  const valid = module();
  for (let length = 0; length < valid.length; length++)
    assert.throws(() => verify(valid.subarray(0, length)));
  assert.throws(() => verify(Buffer.concat([valid, Buffer.from([1, 1, 0])])), /duplicate/);
  assert.throws(() => verify(Buffer.from([...header, 1, 255, 255, 255, 255, 31])), /LEB/);
  const invalidIndex = Buffer.from(valid);
  invalidIndex[invalidIndex.length - 1] = 1;
  assert.throws(() => verify(invalidIndex), /type index/);
});
