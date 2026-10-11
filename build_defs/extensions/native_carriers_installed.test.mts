/** Install actual final leaves through SDK staging, then load both native ABIs. */

import { CString, dlopen } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readCanonicalExtensionArtifactArchive,
  validateExtensionArtifactArchive,
  validateExtensionArtifactEntries,
} from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { type NativeCarrierSpec, validateNativeCarrierIdentities } from './native_carriers.mts';

const [
  specFile,
  githubFile,
  npmFile,
  cargoDirectory,
  runtimeFile,
  consumerFile,
  installSql,
  smokeSql,
  startupFile,
  manifestFile,
  frozenFile,
] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as NativeCarrierSpec;
spec.outputs = {
  github: githubFile,
  npm: npmFile,
  cargo: cargoDirectory,
  manifest: manifestFile,
  frozen: frozenFile,
};
const identities = validateNativeCarrierIdentities(spec);
const npm = readPortableArchiveEntries(realpathSync(npmFile));
const manifest = JSON.parse(npm.get('package/package.json')!.data().toString('utf8'));
const contracts = JSON.parse(npm.get('package/extension-contract.json')!.data().toString('utf8'));
const member = contracts.members[0];
for (const [file, schema] of [
  [manifestFile, 'oliphaunt-extension-release-manifest-v1'],
  [frozenFile, 'oliphaunt-extension-ci-artifacts-v1'],
]) {
  const release = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(release.schema, schema);
  assert.equal(release.product, spec.product);
  assert.equal(release.version, spec.version);
  assert.equal(release.sqlName, spec.sqlName);
  assert.deepEqual(
    release.compatibility,
    Object.fromEntries(
      Object.entries(spec.compatibility).map(([name, value]) => [
        name.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()),
        value,
      ]),
    ),
  );
  assert.equal(
    release.assets.length,
    1,
    'selected target manifest input must not invent other platform assets',
  );
  const asset = release.assets[0];
  assert.equal(asset.name, path.basename(githubFile));
  assert.equal(asset.family, 'native');
  assert.equal(asset.target, spec.target);
  const bytes = readFileSync(githubFile);
  assert.equal(asset.bytes, bytes.length);
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(manifest.name, identities.npm.name);
assert.equal(manifest.version, spec.version);
assert.equal(manifest.oliphaunt.liboliphauntVersion, spec.runtimeVersion);
assert.deepEqual(
  contracts.members.map((row) => row.sqlName),
  [spec.sqlName],
);
const metadata = {
  ...member,
  nativeConstructionLicenseFiles:
    spec.sqlName === 'vector' && spec.target === 'linux-x64-gnu'
      ? member.licenseFiles.filter((row) => row.path.startsWith('share/licenses/llvm-compiler-rt/'))
      : [],
};
validateExtensionArtifactArchive({
  file: realpathSync(githubFile),
  metadata,
  product: spec.product,
  target: spec.target,
  nativeRuntimeVersion: spec.runtimeVersion,
});
const gh = readPortableArchiveEntries(realpathSync(githubFile));
const canonicalEntries = readCanonicalExtensionArtifactArchive(realpathSync(githubFile));
const validateEntries = (entries = canonicalEntries, inventory = metadata) =>
  validateExtensionArtifactEntries({
    entries,
    metadata: inventory,
    product: spec.product,
    target: spec.target,
    nativeRuntimeVersion: spec.runtimeVersion,
    label: 'final public negative fixture',
  });
const foreignEntries = new Map(canonicalEntries);
foreignEntries.set('files/lib/modules/foreign.so', canonicalEntries.values().next().value!);
assert.throws(() => validateEntries(foreignEntries), /undeclared:/);
for (const dependency of member.nativeDependencyModules ?? []) {
  const missing = new Map(canonicalEntries);
  missing.delete(`files/lib/modules/${dependency}`);
  assert.throws(() => validateEntries(missing), /missing:/);
  assert.throws(
    () =>
      validateEntries(canonicalEntries, { ...metadata, nativeDependencyModules: ['foreign.so'] }),
    /differ from the canonical recipe/,
  );
}
for (const construction of metadata.nativeConstructionLicenseFiles) {
  const changed = new Map(canonicalEntries);
  changed.set(`files/${construction.path}`, {
    ...changed.get(`files/${construction.path}`),
    sha256: '0'.repeat(64),
  });
  assert.throws(() => validateEntries(changed), /does not match canonical bytes/);
}
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const cargoPayload = new Map<string, string>();
const chunks = new Map<string, { index: number; bytes: Buffer }[]>();
const parts: string[] = [];
let parentDependencies: Record<string, any> = {};
let parent = false;
for (const file of readdirSync(realpathSync(cargoDirectory)).filter((name) =>
  name.endsWith('.crate'),
)) {
  const archive = readPortableArchiveEntries(realpathSync(path.join(cargoDirectory, file)));
  const prefix = file.slice(0, -6);
  const cargo = Bun.TOML.parse(archive.get(`${prefix}/Cargo.toml`)!.data().toString('utf8'));
  assert.equal(cargo.package.version, spec.version);
  if (cargo.package.name === identities.cargo.name) {
    parent = true;
    parentDependencies = cargo['build-dependencies'] ?? {};
  } else {
    assert(
      cargo.package.name.startsWith(`${identities.cargo.name}-part-`) &&
        /-part-[0-9]{3}$/u.test(cargo.package.name),
      'undeclared Cargo payload identity',
    );
    parts.push(cargo.package.name);
  }
  assert(cargo.package.license.includes('MIT'));
  if (spec.sqlName === 'vector' && metadata.nativeConstructionLicenseFiles.length > 0)
    assert(cargo.package.license.includes('Apache-2.0 WITH LLVM-exception'));
  for (const [name, entry] of archive)
    if (name.startsWith(`${prefix}/payload/`) && entry.isFile) {
      let relative = name.slice(`${prefix}/payload/`.length);
      if (relative.startsWith('chunks/')) {
        const match = /^(.*)\.part([0-9]{3})$/u.exec(relative.slice('chunks/'.length));
        assert(match, 'invalid split Cargo chunk name');
        const rows = chunks.get(match[1]) ?? [];
        rows.push({ index: Number(match[2]), bytes: entry.data() });
        chunks.set(match[1], rows);
        continue;
      }
      if (relative.startsWith('files/')) relative = relative.slice('files/'.length);
      assert(!cargoPayload.has(relative), 'Cargo payload parts must not duplicate file ownership');
      cargoPayload.set(relative, digest(entry.data()));
    }
}
assert(parent, 'missing canonical Cargo parent carrier');
assert.deepEqual(
  parts.sort(),
  parts.map((_, index) => `${identities.cargo.name}-part-${String(index + 1).padStart(3, '0')}`),
);
assert.deepEqual(
  Object.keys(parentDependencies)
    .filter((name) => name.startsWith(`${identities.cargo.name}-part-`))
    .sort(),
  parts,
);
for (const name of parts) assert.equal(parentDependencies[name].version, `=${spec.version}`);
for (const [relative, rows] of chunks) {
  assert(!cargoPayload.has(relative), 'split and whole Cargo payload ownership overlap');
  rows.sort((a, b) => a.index - b.index);
  assert.deepEqual(
    rows.map((row) => row.index),
    rows.map((_, index) => index),
    'Cargo chunks must have contiguous unique indexes',
  );
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.bytes);
  cargoPayload.set(relative, hash.digest('hex'));
}
for (const name of gh.keys())
  if (name.startsWith('files/')) {
    const relative = name.slice('files/'.length);
    assert.deepEqual(
      digest(npm.get(`package/runtime/${relative}`)!.data()),
      digest(gh.get(name)!.data()),
      `npm differs from final GitHub member ${relative}`,
    );
    assert.deepEqual(
      cargoPayload.get(relative),
      digest(gh.get(name)!.data()),
      `Cargo differs from final GitHub member ${relative}`,
    );
  }
assert.equal(cargoPayload.size, [...gh.keys()].filter((name) => name.startsWith('files/')).length);

const root = mkdtempSync(path.join(tmpdir(), 'native-final-install-'));
const writableDirectories = (directory: string) => {
  chmodSync(directory, 0o755);
  for (const row of readdirSync(directory, { withFileTypes: true }))
    if (row.isDirectory()) writableDirectories(path.join(directory, row.name));
};
let materialized: { runtimeDirectory?: string; moduleDirectory?: string } | undefined;
const extract = (file: string, directory: string, prefix = '') => {
  mkdirSync(directory, { recursive: true });
  for (const [name, entry] of readPortableArchiveEntries(realpathSync(file))) {
    if (!entry.isFile || !name.startsWith(prefix)) continue;
    const output = path.join(directory, name.slice(prefix.length));
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, entry.data());
    chmodSync(output, entry.mode);
  }
};
const run = (args: string[], env: Record<string, string | undefined>, stdin?: string) => {
  const result = Bun.spawnSync(args, {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = result.stdout.toString() + result.stderr.toString();
  assert.equal(result.exitCode, 0, `${args[0]} failed: ${output}`);
  assert(!output.includes('ERROR:') && !output.includes('FATAL:'), output);
  return output;
};
try {
  const sdk = path.join(root, 'node_modules/@oliphaunt/ts');
  cpSync(path.resolve(import.meta.dirname, '../../src/native/sdks/ts'), sdk, { recursive: true });
  writableDirectories(sdk);
  const targetRoot = path.join(root, 'node_modules', manifest.name);
  extract(npmFile, targetRoot, 'package/');
  const runtime = path.join(root, 'host');
  mkdirSync(runtime, { recursive: true });
  run(['tar', '-xf', realpathSync(runtimeFile), '-C', runtime], {});
  const library = path.join(runtime, 'lib/liboliphaunt.so');
  const ffi = dlopen(library, { oliphaunt_version: { args: [], returns: 'ptr' } });
  try {
    assert.equal(
      new CString(ffi.symbols.oliphaunt_version()).toString(),
      spec.runtimeVersion,
      'actual incorporated supplier identity differs from extension host pin',
    );
  } finally {
    ffi.close();
  }
  const sdkManifest = JSON.parse(readFileSync(path.join(sdk, 'package.json'), 'utf8'));
  const assets = await import(pathToFileURL(path.join(sdk, 'src/native/assets.ts')).href);
  const install = { libraryPath: library, runtimeDirectory: runtime };
  if (sdkManifest.oliphaunt.liboliphauntVersion !== spec.runtimeVersion) {
    await assert.rejects(
      () => assets.materializeExtensionInstall(install, [spec.sqlName]),
      /does not match @oliphaunt\/ts liboliphauntVersion/,
      'held SDK must reject a newly compiled supplier before adoption',
    );
    console.log(
      `Held SDK host ${sdkManifest.oliphaunt.liboliphauntVersion} correctly rejects native extension host ${spec.runtimeVersion}; exercising explicit candidate SDK adoption.`,
    );
    sdkManifest.oliphaunt.liboliphauntVersion = spec.runtimeVersion;
    chmodSync(path.join(sdk, 'package.json'), 0o644);
    writeFileSync(path.join(sdk, 'package.json'), JSON.stringify(sdkManifest));
  }
  materialized = await assets.materializeExtensionInstall(install, [spec.sqlName]);
  assert(materialized.runtimeDirectory);
  assert(materialized.moduleDirectory);
  for (const name of gh.keys())
    if (name.startsWith('files/')) {
      const relative = name.slice('files/'.length);
      assert.deepEqual(
        readFileSync(path.join(materialized.runtimeDirectory, relative)),
        gh.get(name)!.data(),
      );
      if (relative.startsWith('lib/modules/'))
        assert.deepEqual(
          readFileSync(path.join(materialized.moduleDirectory, path.basename(relative))),
          gh.get(name)!.data(),
        );
    }
  const consumer = path.join(root, 'consumer');
  cpSync(realpathSync(consumerFile), consumer);
  chmodSync(consumer, 0o755);
  const env: Record<string, string | undefined> = {
    LD_LIBRARY_PATH: path.join(runtime, 'lib'),
    OLIPHAUNT_SMOKE_MODULE_DIR: materialized.moduleDirectory,
    OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
    OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
  };
  for (const row of spec.recipe.runtime_environment ?? [])
    env[row.name] = path.join(materialized.runtimeDirectory, row.path);
  const initialize = (database: string) => {
    mkdirSync(database, { recursive: true });
    run(
      [
        path.join(runtime, 'bin/initdb'),
        '-D',
        path.join(database, 'pgdata'),
        '-U',
        'postgres',
        '--auth=trust',
        '--no-sync',
        '--locale-provider=libc',
        '--locale=C',
        '--encoding=UTF8',
      ],
      env,
    );
    writeFileSync(
      path.join(database, '.oliphaunt.json'),
      JSON.stringify({
        schema: 'oliphaunt-database-root-v1',
        engineFamily: 'native',
        pgdata: 'pgdata',
        postgresMajor: 18,
        physicalFormat: 'native-pg18-v1',
      }),
    );
  };
  const embedded = path.join(root, 'embedded');
  initialize(embedded);
  for (let restart = 0; restart < 2; restart++)
    run(
      [
        consumer,
        path.join(embedded, 'pgdata'),
        materialized.runtimeDirectory,
        '--sql-plan',
        realpathSync(installSql),
        realpathSync(smokeSql),
        realpathSync(startupFile),
      ],
      env,
    );
  const server = path.join(root, 'server');
  initialize(server);
  const sql = [installSql, smokeSql]
    .map((file) => readFileSync(file, 'utf8').replace(/^-- oliphaunt-statement$/gmu, ''))
    .join('\n');
  const startup = readFileSync(startupFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((assignment) => ['-c', assignment]);
  const output = run(
    [
      path.join(materialized.runtimeDirectory, 'bin/postgres'),
      '--single',
      '-j',
      '-D',
      path.join(server, 'pgdata'),
      ...startup,
      'postgres',
    ],
    env,
    sql,
  );
  assert(output.includes('candidate-extension-smoke-ok'));
  for (const dependency of member.nativeDependencyModules ?? []) {
    const file = path.join(targetRoot, 'runtime/lib/modules', dependency);
    const bytes = readFileSync(file);
    rmSync(file);
    await assert.rejects(
      () => assets.materializeExtensionInstall(install, [spec.sqlName]),
      /missing declared native dependency module/,
    );
    writeFileSync(file, bytes, { mode: 0o755 });
  }
  const foreign = path.join(targetRoot, 'runtime/lib/modules/foreign.so');
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(foreign, 'undeclared module');
  await assert.rejects(
    () => assets.materializeExtensionInstall(install, [spec.sqlName]),
    /undeclared runtime file/,
  );
  console.log(
    `${spec.product}@${spec.version}: exact final GitHub/npm/Cargo bytes, SDK staging, supplier identity, restart and server SQL verified.`,
  );
} finally {
  if (materialized?.runtimeDirectory)
    rmSync(path.dirname(materialized.runtimeDirectory), { recursive: true, force: true });
  writableDirectories(root);
  rmSync(root, { recursive: true, force: true });
}
