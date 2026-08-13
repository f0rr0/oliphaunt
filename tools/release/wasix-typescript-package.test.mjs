import { describe, expect, test } from 'bun:test';

import { assertWasixTypescriptManifest } from './wasix-typescript-package.mjs';

function manifest() {
  return {
    name: '@oliphaunt/wasix-ts',
    version: '1.2.3',
    license: 'MIT',
    type: 'module',
    publishConfig: { access: 'public', provenance: true },
    dependencies: {
      '@oliphaunt/liboliphaunt-wasix': '1.2.3',
      fzstd: '0.1.1',
    },
    exports: {
      '.': {
        types: './lib/index.d.ts',
        node: './lib/index.node.js',
        browser: './lib/index.js',
        default: './lib/index.js',
      },
      './storage/node': {
        types: './lib/storage/node.d.ts',
        node: './lib/storage/node.js',
      },
    },
    oliphaunt: {
      runtimeProduct: 'liboliphaunt-wasix',
      runtimeVersion: '1.2.3',
    },
  };
}

describe('WASIX TypeScript release dependency closure', () => {
  test('accepts only the exact portable runtime and decompressor', () => {
    expect(() => assertWasixTypescriptManifest(manifest())).not.toThrow();
  });

  for (const [family, dependency] of [
    ['dependencies', 'unrelated'],
    ['optionalDependencies', '@wasmer/sdk'],
    ['peerDependencies', '@oliphaunt/native-host'],
  ]) {
    test(`rejects an extra ${family} entry`, () => {
      const candidate = manifest();
      candidate[family] = { ...candidate[family], [dependency]: '1.0.0' };
      expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
        'must depend only on the exact portable runtime and decompression packages',
      );
    });
  }

  test('rejects bundled dependency families', () => {
    const candidate = manifest();
    candidate.bundledDependencies = ['fzstd'];
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must depend only on the exact portable runtime and decompression packages',
    );
  });
});
