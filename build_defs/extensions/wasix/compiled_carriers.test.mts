import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWasixExtensionArchiveInstall,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../../src/extensions/contracts/wasix-extension-install.mts';
import { assertWasixAotArtifactPayloads } from '../../../src/wasix/runtime/tools/check-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';

const [
  input,
  githubInput,
  npmInput,
  cargoInput,
  frozenInput,
  moduleInput,
  addonInput,
  node,
  consumerInput,
  linkInput,
] = process.argv.slice(2);
const githubRoot = path.dirname(githubInput);
const npmRoot = path.dirname(npmInput);
const cargoRoot = path.dirname(cargoInput);
const spec = JSON.parse(readFileSync(input, 'utf8'));
const frozen = JSON.parse(readFileSync(frozenInput, 'utf8'));
const root = mkdtempSync(
  path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'installed-wasix-member-'),
);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  assert.equal(frozen.product, spec.product);
  assert.equal(frozen.version, spec.version);
  assert.equal(frozen.compatibility.wasixRuntimeVersion, spec.compatibility.wasix_runtime_version);
  const asset = frozen.assets[0];
  const archive = readFileSync(path.join(githubRoot, asset.name));
  assertWasixExtensionArchiveInstall(archive, {
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName: spec.sqlName,
    archive: `extensions/${spec.sqlName}.tar.zst`,
    sha256: asset.sha256,
    size: asset.bytes,
    install: frozen.wasixInstall,
  });
  const portable = readPortableArchiveEntries(realpathSync(path.join(githubRoot, asset.name)));
  assert.deepEqual(
    portable.get(`lib/postgresql/${spec.descriptor['native-module-file']}`)!.data(),
    readFileSync(moduleInput),
    'GitHub member changed the real compiler output',
  );
  assert(frozen.wasixInstall.coreExportsRequired.length > 0);
  assert.deepEqual(frozen.wasixInstall.unresolvedImports, []);
  const link = JSON.parse(readFileSync(linkInput, 'utf8')).moduleLinkMetadata[spec.sqlName];
  const exports = new Set(link.exports.map((row: { name: string }) => row.name));
  for (const name of [
    'Pg_magic_func',
    'id_encode',
    'id_encode_array',
    'id_decode',
    'id_decode_once',
  ])
    assert(exports.has(name), `compiled member lost PostgreSQL export ${name}`);
  for (const name of ['id_encode', 'id_encode_array', 'id_decode', 'id_decode_once'])
    assert(exports.has(`pg_finfo_${name}`), `compiled member lost function metadata ${name}`);
  for (const name of ['hashids_encode_hex', 'hashids_decode_hex', 'malloc', 'calloc', 'free'])
    assert(!exports.has(name), `compiled member exports internal helper or allocator ${name}`);
  for (const name of ['palloc0', 'pfree'])
    assert(
      link.imports.some(
        (row: { name: string; module: string }) => row.module === 'env' && row.name === name,
      ),
      `compiled member lost core allocator import ${name}`,
    );
  const installed = new Map<string, string>();
  for (const filename of readdirSync(npmRoot).filter((name) => name.endsWith('.tgz'))) {
    const archivePath = realpathSync(path.join(npmRoot, filename));
    const entries = readPortableArchiveEntries(archivePath);
    const manifest = JSON.parse(entries.get('package/package.json')!.data().toString());
    assert.equal(manifest.version, spec.version);
    assert.equal(manifest.oliphaunt.product, spec.product);
    const destination = path.join(root, 'node_modules', manifest.name);
    extractPortableArchiveTree(archivePath, destination, 'package');
    installed.set(manifest.name, destination);
    if (manifest.oliphaunt.kind === 'exact-extension-wasix')
      assert.deepEqual(
        entries.get(`package/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
        archive,
      );
    else {
      const aot = JSON.parse(entries.get('package/aot-manifest.json')!.data().toString());
      assertCanonicalWasixAotManifest(aot, {
        expectedTarget: AOT_TARGET_TRIPLES[manifest.oliphaunt.target],
      });
      assertWasixAotArtifactPayloads(aot, {
        readArtifact: (relative: string) => Buffer.from(entries.get(`package/${relative}`)!.data()),
      });
      assert.equal(aot.artifacts[0]['module-sha256'], digest(readFileSync(moduleInput)));
    }
  }
  assert.equal(installed.size, Object.keys(AOT_TARGET_TRIPLES).length + 1);
  const crates = readdirSync(cargoRoot).filter((name) => name.endsWith('.crate'));
  assert.equal(crates.length, installed.size);
  for (const filename of crates) {
    const entries = readPortableArchiveEntries(realpathSync(path.join(cargoRoot, filename)));
    const prefix = filename.slice(0, -'.crate'.length);
    const manifest = Bun.TOML.parse(entries.get(`${prefix}/Cargo.toml`)!.data().toString());
    assert.equal(manifest.package.version, spec.version);
    if (manifest.package.name.endsWith('-wasix'))
      assert.deepEqual(
        entries.get(`${prefix}/payload/files/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
        archive,
      );
  }
  const addonArchive = realpathSync(addonInput);
  const addonEntries = readPortableArchiveEntries(addonArchive);
  const addonManifest = JSON.parse(addonEntries.get('package/package.json')!.data().toString());
  assert.equal(addonManifest.oliphaunt.runtimeVersion, spec.compatibility.wasix_runtime_version);
  extractPortableArchiveTree(
    addonArchive,
    path.join(root, 'node_modules', addonManifest.name),
    'package',
  );
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of Object.keys(env))
    if (/^(?:BUN_|RUNFILES|TEST_SRCDIR)/u.test(key)) delete env[key];
  const result = Bun.spawnSync(
    [
      realpathSync(node),
      '--experimental-strip-types',
      '--preserve-symlinks-main',
      realpathSync(consumerInput),
      addonManifest.name,
      spec.product,
      spec.sqlName,
    ],
    { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 240_000 },
  );
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  console.log(result.stdout.toString().trim());
  console.log(
    'Real compiled WASIX portable + four AOT Cargo/npm carriers preserve exact compiler bytes and installed owner/version contracts: PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
