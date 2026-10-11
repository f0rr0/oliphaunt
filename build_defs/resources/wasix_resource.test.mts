import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  validatePgdataDirectories,
} from '../../src/database-resources/contracts/native-manifest.mts';
import {
  renderWasixRuntimeDescriptorModule,
  wasixRuntimeNpmPayloadInputs,
} from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { materializeArchive, materializeInputs } from './shared.mts';
import { extractWasixRuntime } from './wasix_inputs.mts';

const [unitTest, runner, portable, icu, version, runtimeVersion, ...files] = process.argv.slice(2);
assert.equal(files.length, 22);
const identityJson = files.pop();
assert.ok(identityJson);
const identities = JSON.parse(identityJson);
const seedFiles = files.splice(0, 10);
const fzstd = files.shift();
assert.ok(fzstd);
const sdkSources: Record<string, string> = {};
for (let index = 0; index < files.length; index += 2) sdkSources[files[index]] = files[index + 1];
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-resource-'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const copyArchive = (source: string) =>
  materializeArchive(source, mkdtempSync(path.join(root, 'archive-')));
const member = (entries: ReturnType<typeof readPortableArchiveEntries>, name: string) => {
  const entry = entries.get(name);
  assert.ok(entry?.isFile, `carrier must contain regular ${name}`);
  return entry.data();
};
const environment = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', RAYON_NUM_THREADS: '2' };
const invoke = (args: string[]) =>
  Bun.spawnSync([runner, ...args], { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' });
try {
  const units = Bun.spawnSync([unitTest], {
    cwd: root,
    env: { ...environment, TEST_TMPDIR: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(units.exitCode, 0, `${units.stderr.toString()}\n${units.stdout.toString()}`);
  console.log(units.stdout.toString());
  const runtime = extractWasixRuntime(portable, root);
  const icuRoot = path.join(root, 'icu-resource');
  extractPortableArchiveTree(copyArchive(icu), icuRoot);
  const icuData = path.join(icuRoot, 'share/icu');
  // This exercises the real SDK metadata consumer from its declared source
  // closure. The independent Rust verifier below executes PostgreSQL.
  const sdk = materializeInputs(sdkSources, path.join(root, 'sdk'));
  extractPortableArchiveTree(copyArchive(fzstd), path.join(sdk, 'node_modules/.fzstd'));
  renameSync(path.join(sdk, 'node_modules/.fzstd/package'), path.join(sdk, 'node_modules/fzstd'));
  const runtimeBytes = readFileSync(path.join(portable, 'oliphaunt.wasix.tar.zst'));
  const coreBytes = readFileSync(path.join(portable, 'manifest.json'));
  const coreInputs = wasixRuntimeNpmPayloadInputs({
    manifestBytes: coreBytes,
    runtimeBytes,
    label: 'resource SDK consumer',
  });
  const runtimePackage = path.join(sdk, 'node_modules/@oliphaunt/liboliphaunt-wasix');
  mkdirSync(runtimePackage, { recursive: true });
  writeFileSync(
    path.join(runtimePackage, 'index.mjs'),
    renderWasixRuntimeDescriptorModule({ version: runtimeVersion, ...coreInputs }),
  );
  // This private fixture declares only module resolution; the descriptor's
  // actual identity and implementation come from the canonical formatter.
  writeFileSync(
    path.join(runtimePackage, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.mjs' }),
  );
  const { prepareWasixRuntime } = await import(path.join(sdk, 'resources/extensions.ts'));
  const { descriptor } = await import(path.join(runtimePackage, 'index.mjs'));
  const runtimeDescriptor = {
    ...descriptor,
    runtimeArchive: { ...descriptor.runtimeArchive, source: runtimeBytes },
    manifest: { ...descriptor.manifest, source: coreBytes },
  };
  const optionsFor = (profile: string, archive: Buffer, manifest: Buffer) => ({
    runtime: runtimeDescriptor,
    extensions: [],
    extensionCarriers: {},
    startupGUCs: {},
    seed: { archive, manifest },
    ...(profile === 'icu'
      ? {
          icu: {
            data: readFileSync(path.join(icuData, 'icudt76l.dat')),
            manifest: readFileSync(path.join(icuRoot, 'manifest.properties')),
          },
        }
      : {}),
  });
  const load = async (options: ReturnType<typeof optionsFor>) => {
    const prepared = await prepareWasixRuntime(options);
    assert.ok(prepared.loadClusterSeed);
    return prepared.loadClusterSeed();
  };
  for (const [index, profile] of ['standard', 'icu'].entries()) {
    const [frozen, archive, manifestPath, npm, cargo] = seedFiles.slice(index * 5, index * 5 + 5);
    const seed = path.join(root, profile);
    extractPortableArchiveTree(copyArchive(archive), seed);
    validatePgdataDirectories(seed);
    const original = path.join(root, `${profile}-frozen`);
    await extractNativePayload(frozen, original);
    const before = logicalTreeSha256(filesystemTreeRows(original));
    assert.equal(logicalTreeSha256(filesystemTreeRows(seed)), before);
    assert.deepEqual(emptyDirectoryPaths(seed), emptyDirectoryPaths(original));
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.runtime.version, runtimeVersion);
    assert.equal(manifest.runtime.engineFamily, 'wasix');
    assert.equal(
      manifest.runtime.consumerSha256,
      digest(readFileSync(path.join(runtime, 'bin/postgres'))),
    );
    assert.equal(manifest.runtime.producerSha256, manifest.runtime.consumerSha256);
    assert.equal(
      manifest.runtime.initdbSha256,
      digest(readFileSync(path.join(runtime, 'bin/initdb'))),
    );
    assert.equal(manifest.archive.sha256, digest(readFileSync(archive)));
    assert.equal(manifest.catalogProfile, profile);
    const options = optionsFor(profile, readFileSync(archive), manifestBytes);
    const mount = await load(options);
    assert.equal(Buffer.from(mount.files.PG_VERSION).toString('utf8').trim(), '18');
    assert.equal(
      digest(mount.files['global/pg_control']),
      digest(readFileSync(path.join(seed, 'global/pg_control'))),
    );
    for (const [field, value] of [
      ['version', '999.0.0'],
      ['consumerSha256', '0'.repeat(64)],
      ['physicalFormat', 'native-pg18-v1'],
      ['compatibilityKey', 'native-pg18-linux-x64-gnu-v1'],
    ]) {
      const changed = structuredClone(manifest);
      changed.runtime[field] = value;
      await assert.rejects(
        load({
          ...options,
          seed: { ...options.seed, manifest: Buffer.from(JSON.stringify(changed)) },
        }),
      );
    }
    await assert.rejects(
      load({ ...options, seed: { ...options.seed, archive: Buffer.from('changed seed archive') } }),
    );
    if (profile === 'icu') {
      const changed = structuredClone(manifest);
      changed.icu.dataTreeSha256 = '0'.repeat(64);
      await assert.rejects(
        load({
          ...options,
          seed: { ...options.seed, manifest: Buffer.from(JSON.stringify(changed)) },
        }),
      );
    }
    const identity = identities.find((row) => row.profile === profile);
    const npmEntries = readPortableArchiveEntries(copyArchive(npm));
    const npmManifest = JSON.parse(member(npmEntries, 'package/package.json').toString('utf8'));
    assert.equal(npmManifest.name, identity.npm);
    assert.equal(npmManifest.version, version);
    assert.equal(member(npmEntries, 'package/seed.tar.zst').equals(readFileSync(archive)), true);
    assert.equal(member(npmEntries, 'package/manifest.json').equals(manifestBytes), true);
    const cargoEntries = readPortableArchiveEntries(copyArchive(cargo));
    const cratePrefix = `${identity.cargo}-${version}`;
    const cargoManifest = Bun.TOML.parse(
      member(cargoEntries, `${cratePrefix}/Cargo.toml`).toString('utf8'),
    );
    assert.equal(cargoManifest.package.name, identity.cargo);
    assert.equal(cargoManifest.package.version, version);
    assert.equal(
      member(cargoEntries, `${cratePrefix}/seed.tar.zst`).equals(readFileSync(archive)),
      true,
    );
    assert.equal(member(cargoEntries, `${cratePrefix}/manifest.json`).equals(manifestBytes), true);
    if (profile === 'icu') {
      assert.equal(npmManifest.dependencies['@oliphaunt/icu'], version);
      assert.equal(cargoManifest.dependencies['oliphaunt-icu'], `=${version}`);
    } else {
      assert.equal(npmManifest.dependencies, undefined);
      assert.equal(cargoManifest.dependencies, undefined);
    }
    // Independent CLI mode opens the packaged archive on a private copy, checks
    // both profile probes, writes rows, and reads them from a later PG process.
    const result = invoke([
      'verify',
      runtime,
      path.join(root, `${profile}-consumer`),
      profile,
      seed,
      ...(profile === 'icu' ? [icuData] : []),
    ]);
    assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
    assert.equal(logicalTreeSha256(filesystemTreeRows(original)), before);
    assert.equal(logicalTreeSha256(filesystemTreeRows(seed)), before);
    if (profile === 'icu') {
      const missing = invoke(['verify', runtime, path.join(root, 'missing-icu'), profile, seed]);
      assert.notEqual(missing.exitCode, 0, 'ICU PGDATA consumer must reject absent ICU resource');
    }
    const broken = path.join(root, `${profile}-broken`);
    extractPortableArchiveTree(copyArchive(archive), broken);
    rmSync(path.join(broken, 'global/pg_control'));
    const rejected = invoke([
      'verify',
      runtime,
      path.join(root, `${profile}-rejected`),
      profile,
      broken,
      ...(profile === 'icu' ? [icuData] : []),
    ]);
    assert.notEqual(rejected.exitCode, 0, 'consumer must reject missing pg_control');
  }
  // Core admission must fail before constructing any seed if declared module
  // or archive bytes disagree with their canonical runtime manifest.
  const wrong = path.join(root, 'wrong-runtime');
  mkdirSync(wrong);
  writeFileSync(
    path.join(wrong, 'manifest.json'),
    readFileSync(path.join(portable, 'manifest.json')),
  );
  writeFileSync(path.join(wrong, 'oliphaunt.wasix.tar.zst'), 'altered actual archive');
  assert.throws(() => extractWasixRuntime(wrong, path.join(root, 'wrong-input')), /sha256|archive/);
  console.log(
    'WASIX standard/ICU archive +npm/Cargo exact bytes, actual profile/reopen/persistence, missing resource/control and runtime digest rejection passed',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
