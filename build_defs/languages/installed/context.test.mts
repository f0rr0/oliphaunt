import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { validateRegistryContext } from './context.mts';

const lock = readFileSync(`${import.meta.dir}/fixture/Cargo.lock`, 'utf8');
const context = JSON.parse(readFileSync(`${import.meta.dir}/fixture/registry-index.json`, 'utf8'));

test('every genuine locked registry archive has its exact captured sparse record', () => {
  expect(validateRegistryContext(lock, context)).toHaveLength(context.archives.length);
});

test('installed WASIX source captures retain the selected Cargo version and exact closed registry inputs', () => {
  const version = Bun.TOML.parse(
    readFileSync(new URL('../../../rust-toolchain.toml', import.meta.url), 'utf8'),
  ).toolchain.channel;
  for (const directory of readdirSync(`${import.meta.dir}/wasix`)) {
    const lock = readFileSync(`${import.meta.dir}/wasix/${directory}/Cargo.lock`, 'utf8');
    const context = JSON.parse(
      readFileSync(`${import.meta.dir}/wasix/${directory}/registry-index.json`, 'utf8'),
    );
    expect(context.cargo).toBe(version);
    expect(validateRegistryContext(lock, context)).toHaveLength(context.archives.length);
    const locals = new Set(
      Bun.TOML.parse(lock)
        .package.filter((row) => !row.source)
        .map((row) => row.name),
    );
    for (const index of context.indexes)
      for (const record of index.records) expect(locals.has(record.name)).toBe(false);
  }
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
