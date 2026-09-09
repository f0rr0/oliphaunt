import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { nativeExtensionPackages } from '../native-extension-packages.js';
import { workerOpenOptions } from './worker-helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('resolves an imported package by its file identity, including npm aliases, and rejects substituted versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'oliphaunt-extension-'));
  roots.push(root);
  const owner = join(root, 'node_modules', 'my-pgtap-version');
  const path = 'extensions/pgtap/extension.tar.zst';
  mkdirSync(join(owner, 'extensions', 'pgtap'), { recursive: true });
  writeFileSync(join(owner, path), 'fixture');
  const options = workerOpenOptions();
  const carrier = {
    sqlName: 'pgtap',
    product: 'oliphaunt-extension-pgtap',
    version: '1.3.4',
    sha256: 'a'.repeat(64),
    size: 7,
    source: pathToFileURL(join(owner, path)).href,
  };
  // The serializer validates the complete install descriptor before this resolver.
  options.extensionCarriers.pgtap = carrier as (typeof options.extensionCarriers)[string];
  options.extensions = ['pgtap'];
  const manifest = {
    name: '@oliphaunt/extension-pgtap-wasix',
    version: carrier.version,
    oliphaunt: {
      product: carrier.product,
      kind: 'exact-extension-wasix',
      wasixRuntimeVersion: options.runtime.version,
      carriers: { pgtap: { path, sha256: carrier.sha256, size: 7, requiresAot: false } },
    },
  };
  writeFileSync(join(owner, 'package.json'), JSON.stringify(manifest));
  expect(nativeExtensionPackages(options)).toEqual([
    {
      sqlName: 'pgtap',
      product: carrier.product,
      version: carrier.version,
      packageJson: join(owner, 'package.json'),
    },
  ]);
  manifest.version = '1.3.5';
  writeFileSync(join(owner, 'package.json'), JSON.stringify(manifest));
  expect(() => nativeExtensionPackages(options)).toThrow('does not match its installed package');
  carrier.source = 'https://example.com/untrusted.tar.zst';
  expect(() => nativeExtensionPackages(options)).toThrow('requires an installed package file URL');
});
