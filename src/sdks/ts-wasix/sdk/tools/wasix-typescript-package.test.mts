import { describe, expect, test } from 'bun:test';

import { assertWasixTypescriptManifest } from './wasix-typescript-package.mts';

function manifest() {
  return {
    name: '@oliphaunt/wasix-ts',
    version: '1.2.3',
    license: 'MIT',
    type: 'module',
    sideEffects: ['./lib/browser.js', './lib/native-only.js'],
    publishConfig: { access: 'public', provenance: true },
    dependencies: {
      '@oliphaunt/ts-query': '0.1.0',
      '@oliphaunt/liboliphaunt-wasix': '1.2.3',
      fzstd: '0.1.1',
    },
    optionalDependencies: {
      '@oliphaunt/wasix-napi-darwin-arm64': '1.2.3',
      '@oliphaunt/wasix-napi-linux-arm64-gnu': '1.2.3',
      '@oliphaunt/wasix-napi-linux-x64-gnu': '1.2.3',
      '@oliphaunt/wasix-napi-win32-x64-msvc': '1.2.3',
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
      wasixAddonAbiVersion: 2,
      nodeApiVersion: 8,
      browserHost: 'wasmer-js-patched',
      serverHost: 'wasix-rust-napi',
    },
  };
}

describe('WASIX TypeScript package dependency contract', () => {
  test('accepts the portable browser runtime and exact native platform carriers', () => {
    expect(() => assertWasixTypescriptManifest(manifest())).not.toThrow();
  });

  test('rejects a missing native platform carrier', () => {
    const candidate = manifest();
    delete candidate.optionalDependencies['@oliphaunt/wasix-napi-linux-x64-gnu'];
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(/must depend only/u);
  });

  test('rejects a native platform carrier outside the pinned N-API release', () => {
    const candidate = manifest();
    candidate.optionalDependencies['@oliphaunt/wasix-napi-linux-x64-gnu'] = '1.2.4';
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(/must depend only/u);
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
      expect(() => assertWasixTypescriptManifest(candidate)).toThrow(/must depend only/u);
    });
  }

  test('rejects bundled dependencies', () => {
    const candidate = manifest();
    candidate.bundledDependencies = ['fzstd'];
    expect(() => assertWasixTypescriptManifest(candidate)).toThrow(/must depend only/u);
  });
});
