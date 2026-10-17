import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateRegistryContext } from './context.mts';

const lock = readFileSync(`${import.meta.dir}/fixture/Cargo.lock`, 'utf8');
const context = JSON.parse(readFileSync(`${import.meta.dir}/fixture/registry-index.json`, 'utf8'));

test('every genuine locked registry archive has its exact captured sparse record', () => {
  expect(validateRegistryContext(lock, context)).toHaveLength(context.archives.length);
});

test('mismatched archive checksum, missing record and duplicate identity fail closed', () => {
  for (const mutate of [
    (value: typeof context) => {
      value.indexes[0].records[0].cksum = '0'.repeat(64);
    },
    (value: typeof context) => {
      value.indexes[0].records.pop();
    },
    (value: typeof context) => {
      value.indexes[0].records.push(value.indexes[0].records[0]);
    },
  ]) {
    const changed = structuredClone(context);
    mutate(changed);
    expect(() => validateRegistryContext(lock, changed)).toThrow();
  }
});
