/** Install actual final leaves through SDK staging, then load both native ABIs. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import {
  readCanonicalExtensionArtifactArchive,
  validateExtensionArtifactArchive,
  validateExtensionArtifactEntries,
} from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  exerciseNativeCarrierSql,
  prepareNativeCarrierSdk,
  readNativeCargoPayload,
  writableDirectories,
} from './native_carrier_install_helpers.mts';
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
const cargoPayload = readNativeCargoPayload(cargoDirectory, identities.cargo.name, spec.version, [
  'MIT',
  ...(spec.sqlName === 'vector' && metadata.nativeConstructionLicenseFiles.length > 0
    ? ['Apache-2.0 WITH LLVM-exception']
    : []),
]);
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
let materialized: { runtimeDirectory?: string; moduleDirectory?: string } | undefined;
try {
  const { assets, install, runtime, packages } = await prepareNativeCarrierSdk({
    root,
    runtimeFile,
    npmFiles: [npmFile],
    runtimeVersion: spec.runtimeVersion,
    selected: [spec.sqlName],
  });
  const targetRoot = packages[0].directory;
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
  exerciseNativeCarrierSql({
    root,
    runtime,
    materialized: materialized as { runtimeDirectory: string; moduleDirectory: string },
    consumerFile,
    plans: [installSql, smokeSql, startupFile],
    environment: spec.recipe.runtime_environment ?? [],
  });
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
