import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { importBiomeMetadata, importWorkflowMetadata } from './metadata.mts';

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

const workflowPins = Bun.TOML.parse(
  readFileSync(new URL('../../tools/dev/maintainer-tools.toml', import.meta.url), 'utf8'),
) as any;
test('workflow tools use the same conventional version pins and checksum-bearing archives', () => {
  const metadata = importWorkflowMetadata(workflowPins);
  expect(Object.keys(metadata)).toEqual(['actionlint', 'zizmor', 'shellcheck']);
  for (const [name, tool] of Object.entries(metadata)) {
    expect(tool.version).toBe(workflowPins[name].version);
    expect(tool.sha256).toBe(workflowPins[name].assets['linux-amd64'].sha256);
    expect(tool.binary).toBe(name);
  }
  for (const mutate of [
    (pin: any) => {
      pin.version = 'latest';
    },
    (pin: any) => {
      pin.assets['linux-amd64'].sha256 = '';
    },
    (pin: any) => {
      pin.assets['linux-amd64'].url = 'https://example.com/tool.tgz';
    },
    (pin: any) => {
      pin.assets['linux-amd64'].binary_path = '../actionlint';
    },
    (pin: any) => {
      pin.assets['linux-amd64'].binary_path = 'other';
    },
  ]) {
    const invalid = structuredClone(workflowPins);
    mutate(invalid.actionlint);
    expect(() => importWorkflowMetadata(invalid)).toThrow();
  }
});
