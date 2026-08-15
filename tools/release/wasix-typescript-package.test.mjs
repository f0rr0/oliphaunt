import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { stageReleaseNotices } from './release-notices.mjs';
import {
  assertWasixTypescriptJsrDirectory,
  assertWasixTypescriptManifest,
} from './wasix-typescript-package.mjs';

const scratch = [];

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jsrPackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-wasix-jsr-test-'));
  scratch.push(root);
  for (const name of ['ARCHITECTURE.md', 'CHANGELOG.md', 'README.md']) {
    writeFileSync(path.join(root, name), `${name}\n`);
  }
  for (const name of [
    'lib/index.deno.js',
    'lib/protocol.js',
    'lib/query.js',
    'lib/storage/deno.js',
  ]) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'export {};\n');
  }
  stageReleaseNotices(root, { profile: 'source-sdk' });
  const include = [
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'jsr.json',
    'lib/index.deno.js',
    'lib/protocol.js',
    'lib/query.js',
    'lib/storage/deno.js',
  ];
  const config = {
    name: '@oliphaunt/wasix-ts',
    version: '1.2.3',
    license: 'MIT',
    oliphaunt: { runtimeVersion: '4.5.6' },
    exports: {
      '.': './lib/index.deno.js',
      './protocol': './lib/protocol.js',
      './query': './lib/query.js',
      './storage/deno': './lib/storage/deno.js',
    },
    imports: {
      '@oliphaunt/liboliphaunt-wasix': 'npm:@oliphaunt/liboliphaunt-wasix@4.5.6',
      fzstd: 'npm:fzstd@0.1.1',
    },
    publish: { include },
  };
  writeFileSync(path.join(root, 'jsr.json'), `${JSON.stringify(config, null, 2)}\n`);
  return { config, root };
}

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

describe('WASIX TypeScript JSR carrier', () => {
  test('accepts a complete Deno package without npm workspace metadata', () => {
    const { root } = jsrPackage();
    expect(() => assertWasixTypescriptJsrDirectory(root, {
      version: '1.2.3',
      runtimeVersion: '4.5.6',
    })).not.toThrow();
  });

  test('rejects runtime drift and files outside the explicit publish set', () => {
    const { config, root } = jsrPackage();
    config.imports['@oliphaunt/liboliphaunt-wasix'] =
      'npm:@oliphaunt/liboliphaunt-wasix@4.5.5';
    writeFileSync(path.join(root, 'jsr.json'), `${JSON.stringify(config, null, 2)}\n`);
    expect(() => assertWasixTypescriptJsrDirectory(root)).toThrow(
      'incorrect identity, exports, or imports',
    );

    config.imports['@oliphaunt/liboliphaunt-wasix'] =
      'npm:@oliphaunt/liboliphaunt-wasix@4.5.6';
    writeFileSync(path.join(root, 'jsr.json'), `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(path.join(root, 'unexpected.js'), 'export {};\n');
    expect(() => assertWasixTypescriptJsrDirectory(root)).toThrow(
      'publish.include must exactly cover its staged package files',
    );
  });
});
