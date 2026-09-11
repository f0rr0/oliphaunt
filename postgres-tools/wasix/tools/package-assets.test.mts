import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { postgresSourceFingerprint } from '../../../runtimes/liboliphaunt-wasix/tools/package-release-assets.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { packageWasixToolsAssets, sha256 } from './package-assets.mts';
import { packageWasixToolsCargoArtifacts } from './package-cargo-artifacts.mts';

const scratch = mkdtempSync(path.join(tmpdir(), 'wasix-tools-package-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('independent tools archive freezes real Cargo payload and rejects stale or modified inputs', () => {
  const source = path.join(scratch, 'source');
  mkdirSync(path.join(source, 'bin'), { recursive: true });
  const manifest = { 'source-lane': 'stable', 'source-fingerprint': postgresSourceFingerprint() };
  for (const [key, name] of [
    ['pg-dump', 'pg_dump'],
    ['psql', 'psql'],
  ]) {
    const bytes = Buffer.from('\0asm\x01\0\0\0');
    const relative = `bin/${name}.wasix.wasm`;
    writeFileSync(path.join(source, relative), bytes);
    manifest[key] = { name, path: relative, sha256: sha256(bytes), size: bytes.length };
  }
  const manifestPath = path.join(source, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = path.join(scratch, 'release-assets');
  const argv = ['--source', source, '--version', '0.2.1', '--output-dir', output];
  const archive = packageWasixToolsAssets(argv);
  const before = readFileSync(archive);
  packageWasixToolsAssets(argv);
  expect(readFileSync(archive)).toEqual(before);
  const packages = packageWasixToolsCargoArtifacts([
    '--target',
    'portable',
    '--version',
    '0.2.1',
    '--asset-dir',
    output,
    '--output-dir',
    path.join(scratch, 'cargo'),
    '--work-dir',
    path.join(scratch, 'work'),
  ]);
  expect(packages.map((row) => row.name)).toEqual(['oliphaunt-wasix-tools']);
  const entries = readPortableArchiveEntries(packages[0].cratePath);
  expect(entries.get('oliphaunt-wasix-tools-0.2.1/payload/bin/pg_dump.wasix.wasm')?.data()).toEqual(
    Buffer.from('\0asm\x01\0\0\0'),
  );
  writeFileSync(path.join(source, 'bin/psql.wasix.wasm'), 'corrupted');
  expect(() => packageWasixToolsAssets(argv)).toThrow('bytes do not match');
  manifest['source-fingerprint'] = 'stale';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => packageWasixToolsAssets(argv)).toThrow('source fingerprint');
});
