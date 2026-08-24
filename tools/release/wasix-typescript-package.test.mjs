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
        deno: './lib/index.deno.js',
        bun: './lib/index.bun.js',
        node: './lib/index.node.js',
        browser: './lib/index.js',
        default: './lib/index.js',
      },
      './protocol': {
        types: './lib/protocol.d.ts',
        default: './lib/protocol.js',
      },
      './query': {
        types: './lib/query.d.ts',
        default: './lib/query.js',
      },
      './internal/tools': {
        types: './lib/internal.d.ts',
        deno: './lib/internal.node.js',
        bun: './lib/internal.node.js',
        node: './lib/internal.node.js',
        browser: './lib/internal.js',
        default: './lib/internal.js',
      },
      './server/node': {
        types: './lib/server.node.d.ts',
        node: './lib/server.node.js',
      },
      './server/bun': {
        types: './lib/server.node.d.ts',
        bun: './lib/server.node.js',
      },
      './server/deno': {
        types: './lib/server.node.d.ts',
        deno: './lib/server.node.js',
      },
      './storage/node': {
        types: './lib/storage/node.d.ts',
        node: './lib/storage/node.js',
      },
      './storage/bun': {
        types: './lib/storage/bun.d.ts',
        bun: './lib/storage/bun.js',
      },
      './storage/deno': {
        types: './lib/storage/deno.d.ts',
        deno: './lib/storage/deno.js',
      },
      './storage/indexed-db': {
        types: './lib/storage/indexed-db.d.ts',
        default: './lib/storage/indexed-db.js',
      },
      './storage/opfs': {
        types: './lib/storage/opfs.d.ts',
        default: './lib/storage/opfs.js',
      },
      './package.json': {
        default: './package.json',
      },
    },
    engines: {
      node: '>=22.13 <25',
      bun: '>=1.3.14',
      deno: '>=2.8.1',
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

  test('rejects a root condition order that lets Node shadow Deno or Bun', () => {
    const candidate = manifest();
    candidate.exports['.'] = {
      types: './lib/index.d.ts',
      node: './lib/index.node.js',
      deno: './lib/index.deno.js',
      bun: './lib/index.bun.js',
      browser: './lib/index.js',
      default: './lib/index.js',
    };
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose exact browser, Node, Bun, and Deno conditional entrypoints',
    );
  });

  test('rejects a cross-runtime directory storage fallback', () => {
    const candidate = manifest();
    candidate.exports['./storage/deno'].default = './lib/storage/deno.js';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose Deno directory storage only under the Deno condition',
    );
  });

  test('rejects an incomplete query entrypoint', () => {
    const candidate = manifest();
    delete candidate.exports['./query'].types;
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose the exact query entrypoint',
    );
  });

  test('rejects an extra Node storage export condition', () => {
    const candidate = manifest();
    candidate.exports['./storage/node'].development = './lib/storage/node.js';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose directory storage only under the Node condition',
    );
  });

  test('rejects runtime floors outside the qualified envelope', () => {
    const candidate = manifest();
    candidate.engines.bun = '>=1';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must declare the qualified Node, Bun, and Deno runtime floors',
    );
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
