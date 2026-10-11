import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { importBiomeMetadata } from './metadata.mts';

const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = Bun.JSONC.parse(readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8'));
const copy = () => structuredClone(lock);

test('uses the same declared formatter and integrity-locked Linux binary', () => {
  const result = importBiomeMetadata(root, lock);
  expect(result.version).toBe(root.devDependencies['@biomejs/biome']);
  expect(result.integrity).toBe(lock.packages['@biomejs/cli-linux-x64'][3]);
  expect(result.wrapper.integrity).toBe(lock.packages['@biomejs/biome'][3]);
  expect(result.platform).toEqual({ os: 'linux', cpu: 'x64' });
});

test('rejects a stale declaration and unsupported lock format', () => {
  const stale = copy();
  stale.workspaces[''].devDependencies['@biomejs/biome'] = '1.0.0';
  expect(() => importBiomeMetadata(root, stale)).toThrow('stale root Biome');
  const unsupported = copy();
  unsupported.lockfileVersion = 1;
  expect(() => importBiomeMetadata(root, unsupported)).toThrow('Unsupported Bun lockfile');
});

test('rejects substituted, unbound, or non-integrity-bearing native binaries', () => {
  const platform = '@biomejs/cli-linux-x64';
  const wrongVersion = copy();
  wrongVersion.packages[platform][0] = `${platform}@1.0.0`;
  expect(() => importBiomeMetadata(root, wrongVersion)).toThrow('does not satisfy');
  const missingBinding = copy();
  delete missingBinding.packages['@biomejs/biome'][2].optionalDependencies[platform];
  expect(() => importBiomeMetadata(root, missingBinding)).toThrow('not bound');
  const wrongHost = copy();
  wrongHost.packages[platform][2].cpu = 'arm64';
  expect(() => importBiomeMetadata(root, wrongHost)).toThrow('Linux x64');
  const unsigned = copy();
  unsigned.packages[platform][3] = '';
  expect(() => importBiomeMetadata(root, unsigned)).toThrow('integrity-bearing');
});
