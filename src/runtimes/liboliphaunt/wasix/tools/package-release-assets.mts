#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requireSafeDirectoryChain } from '../../../../shared/artifact-packaging/release-directory-safety.mts';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createDeterministicTar } from '../../../../shared/artifact-packaging/archive-directory.mts';
import {
  portableMemberName,
  releaseZstdCompressSync,
} from '../../../../shared/artifact-packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../../shared/artifact-packaging/release-notices.mts';
import {
  ROOT,
  currentProductVersionSync,
} from '../../../../shared/product-metadata/release-artifact-targets.mts';
import { assertCanonicalWasixAotManifest } from './wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from './wasix-cargo-artifact-contract.mts';
import { main as checkReleaseAssets } from './check-release-assets.mts';

const ASSETS = 'target/oliphaunt-wasix/assets';
const AOT = 'target/oliphaunt-wasix/aot';
const json = (file) => {
  requireSafeDirectoryChain(path.dirname(file));
  assert(regularEntry(file).isFile(), 'manifest must be a regular file: ' + file);
  return JSON.parse(readFileSync(file, 'utf8'));
};
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function regularEntry(file) {
  const stat = lstatSync(file);
  assert(
    stat.isDirectory() || stat.isFile(),
    `payload must contain only regular files and directories: ${file}`,
  );
  return stat;
}

function copyTree(source, destination) {
  requireSafeDirectoryChain(path.dirname(source));
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter(file) {
      regularEntry(file);
      return true;
    },
  });
}

export function postgresSourceFingerprint() {
  const { postgresql } = Bun.TOML.parse(
    readFileSync(path.join(ROOT, 'src/postgres/versions/18/source.toml'), 'utf8'),
  );
  const patches = path.join(ROOT, 'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches');
  const names = readFileSync(path.join(patches, 'series'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert(
    names.length &&
      new Set(names).size === names.length &&
      names.every((name) => name.endsWith('.patch') && !/[\\/]/.test(name)),
    'invalid PostgreSQL patch series',
  );
  const hashes = ['series', ...names]
    .map(
      (name) =>
        sha256(readFileSync(path.join(patches, name), 'utf8').replaceAll('\r\n', '\n')) + '\n',
    )
    .join('');
  return `${postgresql.version}:${postgresql.sha256}:${sha256(hashes)}`;
}

function assertSource(manifest, fingerprint) {
  assert.equal(manifest['source-fingerprint'], fingerprint, 'stale PostgreSQL source fingerprint');
  assert.equal(manifest['source-lane'] ?? 'stable', 'stable', 'unsupported WASIX source lane');
  assert.match(
    manifest.runtime?.['postgres-version'] ?? manifest['postgres-version'] ?? '18.',
    /^18\./,
  );
}

export function stagePortableAssets(source, destination, fingerprint) {
  const manifest = json(path.join(source, 'manifest.json'));
  assertSource(manifest, fingerprint);
  assert(Array.isArray(manifest.extensions), 'portable manifest must contain an extensions array');
  cpSync(source, destination, {
    recursive: true,
    filter(file) {
      if (path.relative(source, file).split(path.sep)[0] === 'extensions') return false;
      regularEntry(file);
      return true;
    },
  });
  for (const tool of ['pg_dump', 'psql']) {
    assert(
      regularEntry(path.join(destination, 'bin', `${tool}.wasix.wasm`)).isFile(),
      `missing ${tool} WASIX payload`,
    );
  }
  manifest.extensions = [];
  delete manifest['pg-dump'];
  delete manifest.psql;
  writeJson(path.join(destination, 'manifest.json'), manifest);
}

export function stageAotAssets(source, destination, target, fingerprint) {
  const manifest = json(path.join(source, 'manifest.json'));
  assertCanonicalWasixAotManifest(manifest, { expectedTarget: target });
  assertSource(manifest, fingerprint);
  assert(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length,
    'empty AOT artifact manifest',
  );
  mkdirSync(destination, { recursive: true });
  manifest.artifacts = manifest.artifacts.filter((artifact) => {
    assert.equal(typeof artifact.name, 'string', 'missing AOT artifact name');
    assert.equal(typeof artifact.path, 'string', 'missing AOT artifact path');
    assert.equal(
      portableMemberName(artifact.path, 'file', source),
      artifact.path,
      'noncanonical AOT artifact path',
    );
    if (artifact.name.startsWith('extension:')) return false;
    copyTree(path.join(source, artifact.path), path.join(destination, artifact.path));
    return true;
  });
  for (const tool of ['tool:pg_dump', 'tool:psql']) {
    assert(
      manifest.artifacts.some((artifact) => artifact.name === tool),
      `missing ${tool} AOT payload`,
    );
  }
  writeJson(path.join(destination, 'manifest.json'), manifest);
}

function icuDataEntries(root) {
  assert(regularEntry(root).isDirectory(), `ICU data root is not a directory: ${root}`);
  return readdirSync(root)
    .sort()
    .filter((name) => {
      const entry = path.join(root, name);
      const stat = regularEntry(entry);
      if (!name.startsWith('icudt')) return false;
      if (stat.isFile()) return name.endsWith('.dat');
      function fileCount(directory) {
        return readdirSync(directory).reduce((count, child) => {
          const file = path.join(directory, child);
          return count + (regularEntry(file).isDirectory() ? fileCount(file) : 1);
        }, 0);
      }
      return fileCount(entry) > 0;
    });
}

export function stageIcuAssets(source, destination) {
  let entries = icuDataEntries(source);
  if (!entries.length) {
    const candidates = readdirSync(source)
      .map((name) => path.join(source, name))
      .filter((file) => regularEntry(file).isDirectory() && icuDataEntries(file).length);
    assert.equal(candidates.length, 1, 'ICU install root must contain exactly one data directory');
    source = candidates[0];
    entries = icuDataEntries(source);
  }
  mkdirSync(destination, { recursive: true });
  for (const name of entries) copyTree(path.join(source, name), path.join(destination, name));
}

async function main() {
  const output = path.join(ROOT, 'target/oliphaunt-wasix/release-assets');
  const version = currentProductVersionSync('liboliphaunt-wasix');
  const fingerprint = postgresSourceFingerprint();
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(path.join(output, '.staging-'));
  const checksums = [];
  async function archive(stage, name) {
    const bytes = releaseZstdCompressSync(await createDeterministicTar(stage));
    writeFileSync(path.join(staging, name), bytes);
    checksums.push(`${sha256(bytes)}  ./${name}`);
    rmSync(stage, { recursive: true });
  }
  try {
    const portable = path.join(staging, 'portable');
    stagePortableAssets(path.join(ROOT, ASSETS), path.join(portable, ASSETS), fingerprint);
    for (const generated of [
      'src/extensions/generated',
      'src/runtimes/liboliphaunt/wasix/assets/generated',
    ]) {
      copyTree(path.join(ROOT, generated), path.join(portable, generated));
    }
    stageReleaseNotices(portable, { profile: 'wasix-runtime' });
    await archive(portable, `liboliphaunt-wasix-${version}-runtime-portable.tar.zst`);
    const icu = path.join(staging, 'icu');
    stageIcuAssets(
      path.join(ROOT, 'target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu'),
      path.join(icu, 'target/oliphaunt-wasix/icu/share/icu'),
    );
    stageReleaseNotices(icu, { profile: 'wasix-icu-data' });
    await archive(icu, `liboliphaunt-wasix-${version}-icu-data.tar.zst`);
    for (const [id, triple] of Object.entries(AOT_TARGET_TRIPLES)) {
      const stage = path.join(staging, id);
      const payload = path.join(stage, AOT, triple);
      stageAotAssets(path.join(ROOT, AOT, triple), payload, triple, fingerprint);
      stageReleaseNotices(payload, { profile: 'wasix-aot' });
      await archive(stage, `liboliphaunt-wasix-${version}-runtime-aot-${id}.tar.zst`);
    }
    writeFileSync(
      path.join(staging, `liboliphaunt-wasix-${version}-release-assets.sha256`),
      checksums.sort().join('\n') + '\n',
    );
    checkReleaseAssets(['--asset-dir', staging, '--version', version]);
    for (const name of readdirSync(output)) {
      if (name !== path.basename(staging))
        rmSync(path.join(output, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(staging))
      copyTree(path.join(staging, name), path.join(output, name));
    console.log(`packaged public release assets in ${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
