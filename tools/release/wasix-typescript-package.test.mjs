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
    optionalDependencies: {
      '@oliphaunt/wasix-napi-darwin-arm64': '1.2.3',
      '@oliphaunt/wasix-napi-linux-arm64-gnu': '1.2.3',
      '@oliphaunt/wasix-napi-linux-x64-gnu': '1.2.3',
      '@oliphaunt/wasix-napi-win32-x64-msvc': '1.2.3',
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
      './worker': {
        types: './lib/worker-entry.d.ts',
        deno: './lib/worker-entry.deno.js',
        bun: './lib/worker-entry.bun.js',
        node: './lib/worker-entry.node.js',
        browser: './lib/worker-entry.js',
        default: './lib/worker-entry.js',
      },
      './direct': {
        types: './lib/direct.node.d.ts',
        deno: './lib/direct.node.js',
        bun: './lib/direct.node.js',
        node: './lib/direct.node.js',
      },
      './internal/tools': {
        types: './lib/internal.d.ts',
        deno: './lib/internal.node.js',
        bun: './lib/internal.node.js',
        node: './lib/internal.node.js',
        browser: './lib/internal.js',
        default: './lib/internal.js',
      },
      './server': {
        types: './lib/server.node.d.ts',
        deno: './lib/server.node.js',
        bun: './lib/server.node.js',
        node: './lib/server.node.js',
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
      wasixNapiProduct: 'oliphaunt-wasix-napi',
      wasixNapiVersion: '1.2.3',
      wasixAddonAbiVersion: 1,
      nodeApiVersion: 8,
      browserHost: 'wasmer-js-patched',
      serverHost: 'wasix-rust-napi',
    },
  };
}

describe('WASIX TypeScript release dependency closure', () => {
  test('accepts the portable browser runtime and exact native platform carriers', () => {
    expect(() => assertWasixTypescriptManifest(manifest())).not.toThrow();
  });

  test('rejects a missing native platform carrier', () => {
    const candidate = manifest();
    delete candidate.optionalDependencies['@oliphaunt/wasix-napi-linux-x64-gnu'];
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must depend only on the exact portable runtime, decompressor, and native platform carriers',
    );
  });

  test('rejects a native platform carrier outside the pinned N-API release', () => {
    const candidate = manifest();
    candidate.optionalDependencies['@oliphaunt/wasix-napi-linux-x64-gnu'] = '1.2.4';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must depend only on the exact portable runtime, decompressor, and native platform carriers',
    );
  });

  test('rejects compatibility metadata that could route a server runtime back to Wasmer', () => {
    const candidate = manifest();
    candidate.oliphaunt.serverHost = 'wasmer-js-patched';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'runtime compatibility metadata differs from its exact dependencies',
    );
  });

  test('rejects a carrier ABI outside the qualified Node-API contract', () => {
    const candidate = manifest();
    candidate.oliphaunt.nodeApiVersion = 9;
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'runtime compatibility metadata differs from its exact dependencies',
    );
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

  test('rejects a worker condition order that lets Node shadow Deno or Bun', () => {
    const candidate = manifest();
    candidate.exports['./worker'] = {
      types: './lib/worker-entry.d.ts',
      node: './lib/worker-entry.node.js',
      deno: './lib/worker-entry.deno.js',
      bun: './lib/worker-entry.bun.js',
      browser: './lib/worker-entry.js',
      default: './lib/worker-entry.js',
    };
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose the exact browser, Node, Bun, and Deno worker entrypoint',
    );
  });

  test('rejects a server condition order that lets Node shadow Deno or Bun', () => {
    const candidate = manifest();
    candidate.exports['./server'] = {
      types: './lib/server.node.d.ts',
      node: './lib/server.node.js',
      deno: './lib/server.node.js',
      bun: './lib/server.node.js',
    };
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose one exact host-only conditional local-server entrypoint',
    );
  });

  test('rejects a browser fallback for the host-only server', () => {
    const candidate = manifest();
    candidate.exports['./server'].default = './lib/server.node.js';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose one exact host-only conditional local-server entrypoint',
    );
  });

  test('rejects a browser fallback for the blocking host-only direct placement', () => {
    const candidate = manifest();
    candidate.exports['./direct'].default = './lib/direct.node.js';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose one exact host-only conditional direct entrypoint',
    );
  });

  test('rejects a cross-runtime directory storage fallback', () => {
    const candidate = manifest();
    candidate.exports['./storage/deno'].default = './lib/storage/deno.js';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must expose Deno directory storage only under the Deno condition',
    );
  });

  test('rejects an accidental low-level query entrypoint', () => {
    const candidate = manifest();
    candidate.exports['./query'] = {
      types: './lib/query.d.ts',
      default: './lib/query.js',
    };
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'exports do not match the deliberate public package surface',
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
        'must depend only on the exact portable runtime, decompressor, and native platform carriers',
      );
    });
  }

  test('rejects bundled dependency families', () => {
    const candidate = manifest();
    candidate.bundledDependencies = ['fzstd'];
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(
      'must depend only on the exact portable runtime, decompressor, and native platform carriers',
    );
  });
});
