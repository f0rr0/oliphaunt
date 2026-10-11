#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDeterministicTar } from '../../../../tools/packaging/cargo-source-package.mts';
import { listArchiveEntries } from '../../../../tools/packaging/package-archive.mts';
import { canonicalGzipSync } from '../../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../../tools/packaging/release-notices.mts';
import { currentProductVersionSync } from '../../../../tools/release/release-artifact-targets.mts';
import { assertWasixAotArtifactPayloads } from '../../runtime/tools/check-release-assets.mts';
import { validateAotPayload } from '../../runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { postgresSourceFingerprint } from '../../runtime/tools/package-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../runtime/tools/wasix-cargo-artifact-contract.mts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PORTABLE_SCHEMA = 'postgres-tools-wasix-portable-v1';
export function fail(message) {
  throw new Error(message);
}
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function validateToolsAotPayload(
  root,
  triple,
  { sourceFingerprint = postgresSourceFingerprint(), sourceRoot = ROOT } = {},
) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  assertSource(manifest, sourceFingerprint);
  const names = manifest.artifacts?.map((row) => row.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['tool:pg_dump', 'tool:psql']))
    fail('WASIX tools AOT archive must contain exactly pg_dump and psql');
  validateAotPayload(root, triple, { sourceRoot });
  return manifest;
}

export function validatePortableToolsPayload(
  root,
  version,
  {
    runtimeVersion = currentProductVersionSync('liboliphaunt-wasix'),
    sourceFingerprint = postgresSourceFingerprint(),
    sourceRoot = ROOT,
  } = {},
) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (
    manifest.schema !== PORTABLE_SCHEMA ||
    manifest.version !== version ||
    manifest.runtimeVersion !== runtimeVersion ||
    manifest.sourceFingerprint !== sourceFingerprint
  )
    fail('WASIX tools portable archive has incompatible producer identity');
  for (const [key, name] of [
    ['pgDump', 'pg_dump'],
    ['psql', 'psql'],
  ]) {
    const row = manifest[key];
    const relative = `bin/${name}.wasix.wasm`;
    const bytes = readFileSync(path.join(root, relative));
    if (
      row?.path !== relative ||
      row.name !== name ||
      row.sha256 !== sha256(bytes) ||
      row.size !== bytes.length
    )
      fail(`WASIX ${name} archive bytes do not match its manifest`);
  }
  const notices = { profile: 'wasix-tools', sourceRoot };
  assertReleaseNoticesInDirectory(root, notices);
  const expected = [
    'manifest.json',
    'bin/pg_dump.wasix.wasm',
    'bin/psql.wasix.wasm',
    ...releaseNoticeRows(notices).map(({ member }) => member),
  ].sort();
  const actual = listArchiveEntries(root)
    .filter((file) => statSync(file).isFile())
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail('WASIX tools portable payload must contain exactly its two commands and legal notices');
  return manifest;
}

function assertSource(manifest, fingerprint = postgresSourceFingerprint()) {
  if (manifest['source-lane'] !== 'stable' || manifest['source-fingerprint'] !== fingerprint) {
    fail(
      'WASIX tools inputs do not match the current PostgreSQL source fingerprint; rebuild the producer',
    );
  }
}

export function stagePortableTools(source, destination, version) {
  const input = readJson(path.join(source, 'manifest.json'));
  assertSource(input);
  const manifest = {
    schema: PORTABLE_SCHEMA,
    version,
    runtimeVersion: currentProductVersionSync('liboliphaunt-wasix'),
    sourceFingerprint: input['source-fingerprint'],
  };
  mkdirSync(path.join(destination, 'bin'), { recursive: true });
  for (const [key, sourceKey, name] of [
    ['pgDump', 'pg-dump', 'pg_dump'],
    ['psql', 'psql', 'psql'],
  ]) {
    const relative = `bin/${name}.wasix.wasm`;
    const bytes = readFileSync(path.join(source, relative));
    const row = input[sourceKey];
    if (row?.path !== relative || row.sha256 !== sha256(bytes) || row.size !== bytes.length) {
      fail(`WASIX ${name} bytes do not match the producing manifest`);
    }
    writeFileSync(path.join(destination, relative), bytes);
    manifest[key] = { name, path: relative, sha256: row.sha256, size: bytes.length };
  }
  writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  stageReleaseNotices(destination, { profile: 'wasix-tools' });
  return manifest;
}

export function stageAotTools(source, destination, triple) {
  const manifest = readJson(path.join(source, 'manifest.json'));
  assertSource(manifest);
  assertCanonicalWasixAotManifest(manifest, { context: source, expectedTarget: triple });
  const selected = {
    ...manifest,
    artifacts: manifest.artifacts.filter((row) => ['tool:pg_dump', 'tool:psql'].includes(row.name)),
  };
  if (
    selected.artifacts.length !== 2 ||
    new Set(selected.artifacts.map((row) => row.name)).size !== 2
  )
    fail('WASIX AOT tools require pg_dump and psql');
  const rows = assertWasixAotArtifactPayloads(selected, {
    context: source,
    readArtifact: (relative) => readFileSync(path.join(source, relative)),
  });
  mkdirSync(destination, { recursive: true });
  for (const row of rows) {
    const file = path.join(destination, row.path);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(path.join(source, row.path), file);
  }
  writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(selected, null, 2)}\n`);
  stageReleaseNotices(destination, { profile: 'wasix-aot' });
}

export function packageWasixToolsAssets(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string', default: 'portable' },
      source: { type: 'string' },
      version: { type: 'string', default: currentProductVersionSync('postgres-tools-wasix') },
      'output-dir': { type: 'string', default: 'target/postgres-tools/wasix/release-assets' },
    },
  });
  if (values.target === 'aot') {
    const requested = process.env.AOT_TARGET;
    values.target = requested
      ? (Object.keys(AOT_TARGET_TRIPLES).find((key) => AOT_TARGET_TRIPLES[key] === requested) ??
        requested)
      : {
          linux: `linux-${process.arch}-gnu`,
          darwin: `macos-${process.arch}`,
          win32: `windows-${process.arch}-msvc`,
        }[process.platform];
  }
  const triple = AOT_TARGET_TRIPLES[values.target];
  if (values.target !== 'portable' && !triple)
    fail(`unsupported WASIX tools target ${values.target}`);
  const output = path.resolve(ROOT, values['output-dir']);
  const stage = path.join(output, `.stage-${values.target}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    const source = path.resolve(
      ROOT,
      values.source ??
        (triple
          ? `target/postgres-tools/wasix/aot/${triple}`
          : 'target/postgres-tools/wasix/assets'),
    );
    if (triple) stageAotTools(source, stage, triple);
    else stagePortableTools(source, stage, values.version);
    const archive = path.join(
      output,
      `postgres-tools-wasix-${values.version}-${triple ? `aot-${values.target}` : 'portable'}.tar.gz`,
    );
    writeFileSync(
      archive,
      canonicalGzipSync(createDeterministicTar(stage, '.', { fail, fixedFileMode: 0o644 })),
    );
    console.log(archive);
    return archive;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) packageWasixToolsAssets(Bun.argv.slice(2));
