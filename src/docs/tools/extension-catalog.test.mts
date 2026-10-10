import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateExtensionCatalog } from './generate-content.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-docs-catalog-'));
  roots.push(root);
  function write(relative: string, value: unknown) {
    const file = path.join(root, 'src/extensions', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  write('generated/extensions.catalog.json', {
    extensions: [
      {
        id: 'vector',
        'display-name': 'pgvector',
        'source-kind': 'oliphaunt-other-extension',
        control: { 'default-version': '0.8.2' },
      },
      {
        id: 'pgtap',
        'source-kind': 'oliphaunt-other-extension',
        control: { 'default-version': '1.3.5' },
      },
    ],
  });
  write('generated/sdk/extensions.json', {
    extensions: [
      { id: 'vector', 'native-module-stem': 'vector' },
      { id: 'pgtap', 'native-module-stem': null },
    ],
  });
  write('generated/wasix/extensions.json', { extensions: [{ id: 'vector' }, { id: 'pgtap' }] });
  write('generated/mobile/static-registry.json', { modules: [{ id: 'vector' }] });
  fs.mkdirSync(path.join(root, 'src/extensions/contracts'), { recursive: true });
  fs.copyFileSync(
    new URL('../../extensions/contracts/extension-target-profiles.toml', import.meta.url),
    path.join(root, 'src/extensions/contracts/extension-target-profiles.toml'),
  );
  return { root, write };
}

test('catalog distinguishes runtime packaging from source and SQL-only mobile resources', () => {
  const { root } = fixture();
  const markdown = generateExtensionCatalog(root);
  expect(markdown).toContain('| Native desktop | linux-arm64-gnu');
  expect(markdown).toContain('| iOS and Android | ios-xcframework');
  expect(markdown).toContain('| WebAssembly (WASIX) | wasix-portable');
  expect(markdown).toContain('| vector (pgvector) | 0.8.2 | External extension | Declared |');
  expect(markdown).toContain('| Declared | SQL resources | Declared | CREATE EXTENSION |');
  expect(markdown).toContain('do not certify a particular release or device');
});

test('catalog refuses to advertise a missing runtime or mobile packaging projection', () => {
  const { root, write } = fixture();
  write('generated/sdk/extensions.json', {
    extensions: [{ id: 'vector', 'native-module-stem': 'vector' }],
  });
  expect(() => generateExtensionCatalog(root)).toThrow('pgtap is missing a runtime packaging');
  write('generated/sdk/extensions.json', {
    extensions: [
      { id: 'vector', 'native-module-stem': 'vector' },
      { id: 'pgtap', 'native-module-stem': null },
    ],
  });
  write('generated/wasix/extensions.json', { extensions: [{ id: 'vector' }] });
  expect(() => generateExtensionCatalog(root)).toThrow('pgtap is missing a runtime packaging');
  write('generated/wasix/extensions.json', { extensions: [{ id: 'vector' }, { id: 'pgtap' }] });
  write('generated/mobile/static-registry.json', { modules: [] });
  expect(() => generateExtensionCatalog(root)).toThrow(
    'vector is missing its mobile static registry',
  );
});
