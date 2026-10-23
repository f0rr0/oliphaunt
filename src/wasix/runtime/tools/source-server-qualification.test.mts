import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCargoToml } from '../../../../tools/packaging/cargo-manifest.mts';
import {
  stageSourceServerQualification,
  verifySourceServerResolution,
} from './source-server-qualification.mts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(sdkVersion = '0.3.2') {
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-source-server-'));
  temporary.push(directory);
  const root = path.join(directory, 'repository');
  const write = (relative: string, text: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('Cargo.lock', 'version = 4\n');
  write(
    'Cargo.toml',
    renderCargoToml({
      workspace: {
        members: [
          'src/wasix/pgwire-server',
          'src/wasix/sdks/rust',
          'src/wasix/runtime/crates/assets',
        ],
        resolver: '3',
        package: { repository: 'https://example.invalid/repository' },
        dependencies: { 'oliphaunt-wasix': { version: '0.3.2', path: 'src/wasix/sdks/rust' } },
      },
    }),
  );
  write(
    'src/wasix/pgwire-server/Cargo.toml',
    renderCargoToml({
      package: {
        name: 'oliphaunt-pgwire-server',
        version: '0.2.1',
        edition: '2024',
        repository: { workspace: true },
      },
      features: {
        default: [],
        extensions: ['dep:oliphaunt-wasix', 'oliphaunt-wasix/extension-pg-hashids'],
      },
      dependencies: { 'oliphaunt-wasix': { workspace: true, optional: true } },
    }),
  );
  write(
    'src/wasix/pgwire-server/src/lib.rs',
    '#[cfg(feature="extensions")] pub fn answer() -> u32 { oliphaunt_wasix::answer() }\n',
  );
  write(
    'src/wasix/pgwire-server/tests/extensions.rs',
    '#[test] fn source_extension() { assert_eq!(oliphaunt_pgwire_server::answer(),42); }\n',
  );
  write('src/wasix/pgwire-server/README.md', 'source server fixture\n');
  write('src/extensions/catalog/extensions.source.json', '{"extensions":[]}\n');
  write('src/test-fixtures/extensions/pg_hashids.sql', 'SELECT 42;\n');
  write(
    'src/wasix/sdks/rust/Cargo.toml',
    renderCargoToml({
      package: { name: 'oliphaunt-wasix', version: sdkVersion, edition: '2024' },
      features: { 'extension-pg-hashids': ['liboliphaunt-wasix-portable/extension-pg-hashids'] },
      dependencies: {
        'liboliphaunt-wasix-portable': { version: '*', path: '../../runtime/crates/assets' },
      },
    }),
  );
  write(
    'src/wasix/sdks/rust/src/lib.rs',
    'pub fn answer() -> u32 { liboliphaunt_wasix_portable::answer() }\n',
  );
  write(
    'src/wasix/runtime/crates/assets/Cargo.toml',
    renderCargoToml({
      package: { name: 'liboliphaunt-wasix-portable', version: '0.3.2', edition: '2024' },
      features: { 'extension-pg-hashids': [] },
    }),
  );
  write('src/wasix/runtime/crates/assets/src/lib.rs', 'pub fn answer() -> u32 { 42 }\n');
  const held = new Map(
    ['Cargo.lock', 'Cargo.toml', 'src/wasix/pgwire-server/Cargo.toml'].map((relative) => [
      relative,
      readFileSync(path.join(root, relative), 'utf8'),
    ]),
  );
  const manifest = stageSourceServerQualification(root, path.join(directory, 'source-proof'));
  const cargo = (...arguments_: string[]) =>
    Bun.spawnSync(
      [
        'cargo',
        ...arguments_,
        '--manifest-path',
        manifest,
        '--offline',
        '--no-default-features',
        '--features',
        'extensions',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  return { root, manifest, cargo, held };
}

test('actual isolated Cargo resolution and execution use current source SDK and carriers without changing held manifests', () => {
  const proof = fixture();
  const manifest = Bun.TOML.parse(readFileSync(proof.manifest, 'utf8'));
  expect(manifest.dependencies['oliphaunt-wasix'].version).toBe('0.3.2');
  expect(manifest.dependencies['oliphaunt-wasix'].optional).toBe(true);
  expect(manifest.package.repository).toBe('https://example.invalid/repository');
  expect(manifest.package.workspace).toBeUndefined();
  expect(manifest.package.publish).toBe(false);
  const resolved = proof.cargo('metadata', '--format-version', '1');
  expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
  const metadata = JSON.parse(resolved.stdout.toString());
  verifySourceServerResolution(metadata, proof.root, proof.manifest);
  const executed = proof.cargo('test', '--locked', '--test', 'extensions');
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
  expect(executed.stdout.toString()).toContain('1 passed');
  for (const [relative, original] of proof.held)
    expect(readFileSync(path.join(proof.root, relative), 'utf8')).toBe(original);
});

test('Cargo rejects a source SDK outside the held conventional requirement', () => {
  const proof = fixture('0.4.0');
  const resolved = proof.cargo('metadata', '--format-version', '1');
  expect(resolved.exitCode).not.toBe(0);
  expect(resolved.stderr.toString()).toContain('failed to select a version');
});

test('resolution verification rejects registry SDK or runtime substitution and wrong root', () => {
  const proof = fixture();
  const resolved = proof.cargo('metadata', '--format-version', '1');
  expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
  const metadata = JSON.parse(resolved.stdout.toString());
  for (const name of ['oliphaunt-wasix', 'liboliphaunt-wasix-portable']) {
    const invalid = structuredClone(metadata);
    invalid.packages.find((row: any) => row.name === name).source =
      'registry+https://github.com/rust-lang/crates.io-index';
    expect(() => verifySourceServerResolution(invalid, proof.root, proof.manifest)).toThrow(
      /installed or different/,
    );
  }
  const invalid = structuredClone(metadata);
  invalid.resolve.root = 'different root';
  expect(() => verifySourceServerResolution(invalid, proof.root, proof.manifest)).toThrow(
    'actual resolved root',
  );
});
