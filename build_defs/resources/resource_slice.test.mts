import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  validateNativeClusterSeedDirectory,
  validatePgdataDirectories,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { parseNativeMobileAbiReceipt } from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { validateSelectedNativeSeed } from '../../src/native/sdks/ts/src/native/cluster-seed.ts';
import { publishNativeDescriptor } from '../../src/native/sdks/ts/src/root-descriptor.ts';
import { validateMavenCentralPublication } from '../../tools/packaging/maven-central-contract.mts';
import {
  archiveLogicalTreeRows,
  extractPortableArchiveTree,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  assertMissingHostRuntime,
  extractNativePayload,
} from '../native/host-runtime-test-helpers.mts';
import { seedProducerIdentity, validateSeedConstructionReceipt } from './seed_construction.mts';
import { materializeArchive, nativeSeedHost, run, seedEnvironment } from './shared.mts';

const [
  runtimeArchive,
  consumerInput,
  runtimeVersion,
  version,
  seedSpecification,
  icuArchive,
  icuNpm,
  icuCargo,
  mavenRoot,
  ...seedInputs
] = process.argv
  .slice(2)
  .map((value, index) => ([2, 3].includes(index) ? value : path.resolve(value)));
const runtimeArtifact = JSON.parse(readFileSync(seedSpecification, 'utf8')).runtimeArtifact;
const host = nativeSeedHost(runtimeArtifact);
const target = host.target;
assert.equal(seedInputs.length, 14);
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
const consumer = path.join(root, `consumer/bin/seed-consumer${host.executableSuffix}`);
mkdirSync(path.dirname(consumer), { recursive: true });
copyFileSync(consumerInput, consumer);
if (process.platform !== 'win32') chmodSync(consumer, 0o755);
assert.equal(
  run(consumer, ['--version'], seedEnvironment(runtime, root), root).trim(),
  runtimeVersion,
);
const library = path.join(runtime, host.libraryRelativePath);
renameSync(library, `${library}.removed`);
try {
  assertMissingHostRuntime(
    Bun.spawnSync([consumer, '--version'], {
      env: seedEnvironment(runtime, root),
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    path.basename(library),
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
const seedProfiles = Object.keys(
  JSON.parse(
    readFileSync(
      new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
      'utf8',
    ),
  ).profiles,
).sort();
const identities = seedCarrierIdentities();
for (const [index, profile] of seedProfiles.entries()) {
  let [archive, manifestFile, frozen, abiFile, npm, cargo, constructionFile] = seedInputs.slice(
    index * 7,
    (index + 1) * 7,
  );
  archive = copyArchive(archive);
  npm = copyArchive(npm);
  cargo = copyArchive(cargo);
  const tree = path.join(root, profile, 'frozen');
  await extractNativePayload(frozen, tree);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const construction = validateSeedConstructionReceipt(
    JSON.parse(readFileSync(constructionFile, 'utf8')),
  );
  assert.equal(construction.intent.family, 'native');
  assert.equal(construction.intent.target, target);
  assert.equal(construction.intent.profile, profile);
  const frozenBytes = readFileSync(frozen);
  assert.deepEqual(construction.frozen, {
    size: frozenBytes.length,
    sha256: createHash('sha256').update(frozenBytes).digest('hex'),
  });
  if (construction.sourceManifest) {
    const original = JSON.parse(construction.sourceManifest.contents);
    assert.deepEqual(
      manifest.runtime,
      original.runtime,
      'qualification must retain the original admitted native runtime',
    );
    assert.deepEqual(
      manifest.source,
      original.source,
      'qualification must retain the original seed source',
    );
  }
  assert.equal(manifest.runtime.target, target);
  assert.equal(
    manifest.archive.sha256,
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
  );
  assert.deepEqual(
    {
      postgresSha256: manifest.source.postgresSha256,
      initdbSha256: manifest.source.initdbSha256,
    },
    seedProducerIdentity(construction),
    'seed producer hashes must identify the original constructor',
  );
  const abi = parseNativeMobileAbiReceipt(readFileSync(abiFile, 'utf8'));
  assert.equal(abi.get('target'), target);
  validateNativeClusterSeedDirectory(tree, profile, {
    target,
    icuData: profile === 'icu' ? icuData : undefined,
  });
  const originalHash = logicalTreeSha256(filesystemTreeRows(path.join(tree, 'files')));
  const selectedManifestFile = path.join(root, profile, 'selected-seed.json');
  writeFileSync(
    selectedManifestFile,
    JSON.stringify({
      ...manifest,
      directory: {
        path: 'frozen/files',
        treeSha256: originalHash,
        emptyDirectories: emptyDirectoryPaths(path.join(tree, 'files')),
      },
    }),
  );
  await validateSelectedNativeSeed(
    { manifestPath: selectedManifestFile, directory: path.join(tree, 'files') },
    target,
    runtimeVersion,
    profile === 'icu' ? icuIdentity.icuDataTreeSha256 : undefined,
  );
  assert.equal(construction.pgdata.treeSha256, originalHash);
  const seedEntries = readPortableArchiveEntries(archive);
  assert.equal(logicalTreeSha256(archiveLogicalTreeRows(seedEntries, archive, '')), originalHash);
  const directories = readdirSync(path.join(tree, 'files'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path
        .relative(path.join(tree, 'files'), path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
  assert.deepEqual(
    [...seedEntries]
      .filter(([, entry]) => entry.isDirectory)
      .map(([name]) => name)
      .sort(),
    directories,
    'the final archive must preserve exactly the original PostgreSQL directories',
  );
  for (const [name, entry] of seedEntries) {
    assert(
      entry.isDirectory || (entry.isFile && !entry.isSymbolicLink),
      `unexpected seed member ${name}`,
    );
    assert.equal(
      entry.mode,
      entry.isDirectory ? 0o755 : 0o644,
      `unexpected seed member mode ${name}`,
    );
  }
  const pgdata = path.join(root, profile, 'consumer/pgdata');
  extractPortableArchiveTree(archive, pgdata);
  validatePgdataDirectories(pgdata);
  assert.equal(logicalTreeSha256(filesystemTreeRows(pgdata)), originalHash);
  chmodSync(pgdata, 0o700);
  await publishNativeDescriptor(path.dirname(pgdata));
  const env = seedEnvironment(runtime, root, profile === 'icu' ? icuData : undefined);
  const probe = profileContract.profiles[profile];
  // Each negative starts from the immutable original, before a successful open
  // can checkpoint or otherwise change PGDATA. PostgreSQL's CRC routines
  // preserve a valid checksum so PostgreSQL must reject the physical version.
  for (const field of ['control', 'catalog']) {
    const incompatible = path.join(root, profile, `incompatible-${field}`, 'pgdata');
    mkdirSync(path.dirname(incompatible), { recursive: true });
    cpSync(pgdata, incompatible, { recursive: true });
    await publishNativeDescriptor(path.dirname(incompatible));
    const controlFile = path.join(incompatible, 'global/pg_control');
    const before = readFileSync(controlFile);
    const mutation = run(consumer, [`--corrupt-${field}`, controlFile], env, root);
    assert.match(
      mutation,
      new RegExp(
        `corrupted ${field === 'control' ? 'PG_CONTROL_VERSION' : 'CATALOG_VERSION_NO'} with valid CRC32C`,
        'u',
      ),
    );
    const changed = readFileSync(controlFile);
    assert.equal(changed.length, before.length);
    assert.ok(!changed.equals(before), 'test must change the physical control file');
    const rejected = Bun.spawnSync([consumer, incompatible, runtime, probe.sql, probe.expected], {
      env,
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.notEqual(rejected.exitCode, 0, `runtime accepted incompatible ${field} version`);
    const diagnostic = rejected.stderr.toString();
    assert.match(diagnostic, /database files are incompatible with server/u);
    assert.doesNotMatch(diagnostic, /incorrect checksum in control file/u);
  }
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
  const identity = identities.find(
    (row) => row.family === 'native' && row.target === target && row.profile === profile,
  );
  assert(identity, 'the installed seed must have one canonical carrier identity');
  assert.equal(packageJson.name, identity.npm);
  assert.equal(packageJson.version, version);
  assert.deepEqual(
    packageJson.dependencies ?? {},
    profile === 'icu' ? { '@oliphaunt/icu': version } : {},
  );
  assert(!packedNpm.has('package/seed.tar.zst'));
  const npmManifest = JSON.parse(member(packedNpm, 'package/manifest.json').data().toString());
  assert.deepEqual(npmManifest.runtime, manifest.runtime);
  assert.deepEqual(npmManifest.source, manifest.source);
  assert.equal(npmManifest.directory.treeSha256, originalHash);
  assert.equal(
    logicalTreeSha256(
      archiveLogicalTreeRows(packedNpm, npm, `package/${npmManifest.directory.path}/`),
    ),
    originalHash,
  );
  for (const [name, entry] of packedNpm) {
    if (!name.startsWith(`package/${npmManifest.directory.path}/`)) continue;
    assert.equal(
      entry.mode,
      entry.isDirectory ? 0o755 : 0o644,
      `unexpected installed seed mode ${name}`,
    );
  }
  assert(npmManifest.directory.emptyDirectories.includes('pg_twophase'));
  const crateEntries = readPortableArchiveEntries(cargo);
  for (const [name, entry] of crateEntries)
    assert.equal(entry.mode, entry.isDirectory ? 0o755 : 0o644, name);
  const crateRoot = `${identity.cargo}-${version}`;
  const cargoManifest = Bun.TOML.parse(
    member(crateEntries, `${crateRoot}/Cargo.toml`).data().toString(),
  );
  const cargoPackage = cargoManifest.package as { name: string; version: string };
  assert.equal(cargoPackage.name, identity.cargo);
  assert.equal(cargoPackage.version, version);
  assert(member(crateEntries, `${crateRoot}/seed.tar.zst`).data().equals(readFileSync(archive)));
  const crateManifest = JSON.parse(
    member(crateEntries, `${crateRoot}/manifest.json`).data().toString(),
  );
  assert.deepEqual(crateManifest.runtime, manifest.runtime);
  assert.deepEqual(crateManifest.source, manifest.source);
  assert(statSync(cargo).size <= 10 * 1024 * 1024);
  const corrupted = path.join(root, profile, 'corrupted');
  cpSync(tree, corrupted, { recursive: true });
  writeFileSync(
    path.join(corrupted, 'manifest.properties'),
    readFileSync(path.join(corrupted, 'manifest.properties'), 'utf8').replace(
      `target=${target}`,
      `target=${target === 'linux-x64-gnu' ? 'macos-arm64' : 'linux-x64-gnu'}`,
    ),
  );
  assert.throws(
    () =>
      validateNativeClusterSeedDirectory(corrupted, profile, {
        target,
        icuData: profile === 'icu' ? icuData : undefined,
      }),
    /target/,
  );
  writeFileSync(path.join(corrupted, 'files/PG_VERSION'), '17\n');
  assert.throws(
    () =>
      validateNativeClusterSeedDirectory(corrupted, profile, {
        target,
        icuData: profile === 'icu' ? icuData : undefined,
      }),
    /PostgreSQL.*expected 18/,
  );
}
console.log(
  `ICU npm/Cargo/Maven and both ${target} native seed carriers passed actual runtime, reopen, ABI, integrity and missing-library checks`,
);
