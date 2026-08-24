import { describe, expect, test } from 'bun:test';

import { assertWasixToolsTypescriptManifest } from './wasix-tools-typescript-package.mjs';

function manifest() {
  return {
    name: '@oliphaunt/wasix-tools',
    version: '1.2.3',
    license: 'MIT',
    type: 'module',
    repository: {
      type: 'git',
      url: 'git+https://github.com/f0rr0/oliphaunt.git',
      directory: 'src/bindings/wasix-ts/tools-package',
    },
    publishConfig: { access: 'public', provenance: true },
    oliphaunt: {
      runtimeProduct: 'liboliphaunt-wasix',
      runtimeVersion: '4.5.6',
    },
    dependencies: {
      '@oliphaunt/liboliphaunt-wasix-tools': '4.5.6',
    },
    peerDependencies: {
      '@oliphaunt/wasix-ts': '1.2.3',
    },
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './package.json': './package.json',
    },
  };
}

describe('WASIX TypeScript tools package contract', () => {
  test('accepts only the exact binding and carrier closure', () => {
    expect(() => assertWasixToolsTypescriptManifest(manifest())).not.toThrow();
  });

  test('rejects semver ranges and extra dependencies', () => {
    const range = manifest();
    range.peerDependencies['@oliphaunt/wasix-ts'] = '^1.2.3';
    expect(() => assertWasixToolsTypescriptManifest(range)).toThrow(/exact WASIX binding/);
    const extra = manifest();
    extra.dependencies.other = '1.0.0';
    expect(() => assertWasixToolsTypescriptManifest(extra)).toThrow(/exact WASIX binding/);
  });
});
