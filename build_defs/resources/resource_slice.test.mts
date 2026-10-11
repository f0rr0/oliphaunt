import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  extractNativePayload,
  assertMissingHostRuntime,
} from '../native/host-runtime-test-helpers.mts';
import {
  archiveLogicalTreeRows,
  extractPortableArchiveTree,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from '../../tools/packaging/portable-archive.mts';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import {
  filesystemTreeRows,
  logicalTreeSha256,
  validateNativeClusterSeedDirectory,
  validatePgdataDirectories,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { parseNativeMobileAbiReceipt } from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { publishNativeDescriptor } from '../../src/native/sdks/ts/src/root-descriptor.ts';
import { validateMavenCentralPublication } from '../../tools/packaging/maven-central-contract.mts';
import { materializeArchive, run, seedEnvironment } from './shared.mts';

const [
  runtimeArchive,
  consumerInput,
  runtimeVersion,
  version,
  icuArchive,
  icuNpm,
  icuCargo,
  mavenRoot,
  ...seedInputs
] = process.argv
  .slice(2)
  .map((value, index) => ([2, 3].includes(index) ? value : path.resolve(value)));
assert.equal(seedInputs.length, 12);
assert(process.env.TEST_TMPDIR, 'test requires a private Bazel scratch directory');
const root = path.resolve(process.env.TEST_TMPDIR);
const copyArchive = (source: string) => materializeArchive(source, path.join(root, 'inputs'));
function member(entries: ReturnType<typeof readPortableArchiveEntries>, name: string) {
  const entry = entries.get(name);
  assert(entry?.isFile && !entry.isSymbolicLink, `missing regular archive member ${name}`);
  return entry;
}
const runtime = path.join(root, 'runtime');
await extractNativePayload(runtimeArchive, runtime);
// This consumer must use the separate ICU carrier selected below.
rmSync(path.join(runtime, 'share/icu'), { recursive: true, force: true });
const consumer = path.join(root, 'consumer/bin/seed-consumer');
mkdirSync(path.dirname(consumer), { recursive: true });
copyFileSync(consumerInput, consumer);
chmodSync(consumer, 0o755);
assert.equal(
  run(consumer, ['--version'], seedEnvironment(runtime, root), root).trim(),
  runtimeVersion,
);
const library = path.join(runtime, 'lib/liboliphaunt.so');
renameSync(library, `${library}.removed`);
try {
  assertMissingHostRuntime(
    Bun.spawnSync([consumer, '--version'], {
      env: seedEnvironment(runtime, root),
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    'liboliphaunt.so',
  );
} finally {
  renameSync(`${library}.removed`, library);
}

const icu = path.join(root, 'icu');
extractPortableArchiveTree(copyArchive(icuArchive), icu);
const icuData = path.join(icu, 'share/icu');
const icuIdentity = validateNativeIcuDataManifest(
  readFileSync(path.join(icu, 'manifest.properties')),
  icuData,
);
const icuEntries = readPortableArchiveEntries(copyArchive(icuNpm));
const icuPackage = JSON.parse(member(icuEntries, 'package/package.json').data().toString());
assert.equal(icuPackage.name, '@oliphaunt/icu');
assert.equal(icuPackage.version, version);
assert.equal(icuPackage.oliphaunt.icuDataTreeSha256, icuIdentity.icuDataTreeSha256);
assert(
  member(icuEntries, 'package/OliphauntICU.bundle/share/icu/icudt76l.dat')
    .data()
    .equals(readFileSync(path.join(icuData, 'icudt76l.dat'))),
);
const icuCrate = readPortableArchiveEntries(copyArchive(icuCargo));
const cargoIcuTree = readPortableTarZstdBufferEntries(
  member(icuCrate, `oliphaunt-icu-${version}/payload/icu-data.tar.zst`).data(),
);
assert.equal(
  logicalTreeSha256(archiveLogicalTreeRows(cargoIcuTree, icuCargo, 'share/icu/')),
  icuIdentity.icuDataTreeSha256,
);
assert(statSync(icuCargo).size <= 10 * 1024 * 1024);
const coordinate = path.join(mavenRoot, 'dev/oliphaunt/runtime/oliphaunt-icu', version);
validateMavenCentralPublication({
  context: 'actual ICU carrier',
  files: readdirSync(coordinate).map((name) => ({
    name,
    size: statSync(path.join(coordinate, name)).size,
  })),
  pomText: readFileSync(path.join(coordinate, `oliphaunt-icu-${version}.pom`), 'utf8'),
});
assert(
  readFileSync(path.join(coordinate, `oliphaunt-icu-${version}.tar.gz`)).equals(
    readFileSync(icuArchive),
  ),
);
const profileContract = JSON.parse(
  readFileSync(
    new URL('../../src/database-resources/contracts/profile-probe.json', import.meta.url),
    'utf8',
  ),
);
for (const [index, profile] of ['standard', 'icu'].entries()) {
  let [archive, manifestFile, frozen, abiFile, npm, cargo] = seedInputs.slice(
    index * 6,
    (index + 1) * 6,
  );
  archive = copyArchive(archive);
  npm = copyArchive(npm);
  cargo = copyArchive(cargo);
  const tree = path.join(root, profile, 'frozen');
  await extractNativePayload(frozen, tree);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.runtime.version, runtimeVersion);
  assert.equal(manifest.runtime.target, 'linux-x64-gnu');
  assert.equal(
    manifest.archive.sha256,
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
  );
  assert.equal(
    manifest.source.postgresSha256,
    createHash('sha256')
      .update(readFileSync(path.join(runtime, 'bin/postgres')))
      .digest('hex'),
  );
  assert.equal(
    manifest.source.initdbSha256,
    createHash('sha256')
      .update(readFileSync(path.join(runtime, 'bin/initdb')))
      .digest('hex'),
  );
  const abi = parseNativeMobileAbiReceipt(readFileSync(abiFile, 'utf8'));
  assert.equal(abi.get('target'), 'linux-x64-gnu');
  validateNativeClusterSeedDirectory(tree, profile, {
    target: 'linux-x64-gnu',
    icuData: profile === 'icu' ? icuData : undefined,
  });
  const originalHash = logicalTreeSha256(filesystemTreeRows(path.join(tree, 'files')));
  const pgdata = path.join(root, profile, 'consumer/pgdata');
  extractPortableArchiveTree(archive, pgdata);
  validatePgdataDirectories(pgdata);
  assert.equal(logicalTreeSha256(filesystemTreeRows(pgdata)), originalHash);
  chmodSync(pgdata, 0o700);
  await publishNativeDescriptor(path.dirname(pgdata));
  const env = seedEnvironment(runtime, root, profile === 'icu' ? icuData : undefined);
  const probe = profileContract.profiles[profile];
  run(consumer, [pgdata, runtime, probe.sql, probe.expected], env, root);
  if (profile === 'icu') {
    const data = path.join(icuData, 'icudt76l.dat');
    renameSync(data, `${data}.removed`);
    try {
      const missingData = Bun.spawnSync([consumer, pgdata, runtime, probe.sql, probe.expected], {
        env,
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.notEqual(missingData.exitCode, 0, 'consumer resolved the removed ICU carrier data');
    } finally {
      renameSync(`${data}.removed`, data);
    }
  }
  const errorResponse = Bun.spawnSync(
    [
      consumer,
      pgdata,
      runtime,
      "DO $$ BEGIN RAISE EXCEPTION 'resource-error-sentinel'; END $$",
      'resource-error-sentinel',
    ],
    { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  assert.notEqual(
    errorResponse.exitCode,
    0,
    'consumer accepted an error message as its expected result',
  );
  run(
    consumer,
    [
      pgdata,
      runtime,
      "CREATE TABLE resource_probe (value text); INSERT INTO resource_probe VALUES ('resource-reopen-ok'); SELECT value FROM resource_probe",
      'resource-reopen-ok',
    ],
    env,
    root,
  );
  run(
    consumer,
    [pgdata, runtime, 'SELECT value FROM resource_probe', 'resource-reopen-ok'],
    env,
    root,
  );
  assert.equal(
    logicalTreeSha256(filesystemTreeRows(path.join(tree, 'files'))),
    originalHash,
    'consumer changed the frozen seed',
  );
  const packedNpm = readPortableArchiveEntries(npm);
  const packageJson = JSON.parse(member(packedNpm, 'package/package.json').data().toString());
  assert.equal(packageJson.version, version);
  assert.deepEqual(
    packageJson.dependencies ?? {},
    profile === 'icu' ? { '@oliphaunt/icu': version } : {},
  );
  assert(!packedNpm.has('package/seed.tar.zst'));
  const npmManifest = JSON.parse(member(packedNpm, 'package/manifest.json').data().toString());
  assert.equal(npmManifest.runtime.version, runtimeVersion);
  assert.equal(npmManifest.directory.treeSha256, originalHash);
  assert.equal(
    logicalTreeSha256(
      archiveLogicalTreeRows(packedNpm, npm, `package/${npmManifest.directory.path}/`),
    ),
    originalHash,
  );
  assert(npmManifest.directory.emptyDirectories.includes('pg_twophase'));
  const crateEntries = readPortableArchiveEntries(cargo);
  const crateRoot = `oliphaunt-seed-native-linux-x64-gnu-${profile}-${version}`;
  assert(member(crateEntries, `${crateRoot}/seed.tar.zst`).data().equals(readFileSync(archive)));
  assert.equal(
    JSON.parse(member(crateEntries, `${crateRoot}/manifest.json`).data().toString()).runtime
      .version,
    runtimeVersion,
  );
  assert(statSync(cargo).size <= 10 * 1024 * 1024);
  const corrupted = path.join(root, profile, 'corrupted');
  cpSync(tree, corrupted, { recursive: true });
  writeFileSync(
    path.join(corrupted, 'manifest.properties'),
    readFileSync(path.join(corrupted, 'manifest.properties'), 'utf8').replace(
      'target=linux-x64-gnu',
      'target=macos-arm64',
    ),
  );
  assert.throws(
    () =>
      validateNativeClusterSeedDirectory(corrupted, profile, {
        target: 'linux-x64-gnu',
        icuData: profile === 'icu' ? icuData : undefined,
      }),
    /target/,
  );
  writeFileSync(path.join(corrupted, 'files/PG_VERSION'), '17\n');
  assert.throws(
    () =>
      validateNativeClusterSeedDirectory(corrupted, profile, {
        target: 'linux-x64-gnu',
        icuData: profile === 'icu' ? icuData : undefined,
      }),
    /PostgreSQL.*expected 18/,
  );
}
console.log(
  'ICU npm/Cargo/Maven and both Linux native seed carriers passed actual runtime, reopen, ABI, integrity and missing-library checks',
);
