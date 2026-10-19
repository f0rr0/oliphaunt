import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { postgresSourceFingerprint } from '../../runtime/tools/package-release-assets.mts';
import { validateRuntimeAotPayload } from '../../runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { canonicalWasixAotMetadata } from '../../runtime/tools/wasix-aot-manifest.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../../tools/packaging/release-notices.mts';
import { packageWasixToolsAssets, sha256, validateToolsAotPayload } from './package-assets.mts';
import { packageWasixToolsCargoArtifacts } from './package-cargo-artifacts.mts';

const scratch = mkdtempSync(path.join(tmpdir(), 'wasix-tools-package-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('standalone tools AOT validates independently of core and still rejects modified bytes', () => {
  const root = mkdtempSync(path.join(scratch, 'tools-aot-'));
  const canonical = canonicalWasixAotMetadata();
  const target = 'x86_64-unknown-linux-gnu';
  const raw = Buffer.from('tools AOT fixture');
  const bytes = zstdCompressSync(raw);
  const manifest = {
    'format-version': 1,
    'source-lane': canonical.sourceLane,
    'source-fingerprint': postgresSourceFingerprint(),
    engine: canonical.engine,
    'wasmer-version': canonical.wasmerVersion,
    'wasmer-wasix-version': canonical.wasmerWasixVersion,
    'target-triple': target,
    artifacts: ['pg_dump', 'psql'].map((name) => ({
      name: `tool:${name}`,
      path: `${name}.bin.zst`,
      sha256: sha256(bytes),
      'raw-sha256': sha256(raw),
      'raw-size': raw.length,
      'module-sha256': sha256(Buffer.from(name)),
      compressed: true,
    })),
  };
  for (const artifact of manifest.artifacts) writeFileSync(path.join(root, artifact.path), bytes);
  stageReleaseNotices(root, { profile: 'wasix-aot' });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  expect(() => validateToolsAotPayload(root, target)).not.toThrow();
  expect(() => validateRuntimeAotPayload(root, target)).toThrow(/missing core runtime AOT/u);
  writeFileSync(path.join(root, 'psql.bin.zst'), 'corrupted');
  expect(() => validateToolsAotPayload(root, target)).toThrow();
});

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
