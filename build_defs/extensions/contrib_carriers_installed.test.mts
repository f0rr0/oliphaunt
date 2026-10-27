/** Verify the complete contrib bundle and execute only selected installed members. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
import { validateExtensionArtifactArchive } from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import { nativeExtensionConstructionLicenseInventory } from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
} from '../../tools/packaging/release-notices.mts';
import { type NativeContribCarrierSpec, validateNativeContribInputs } from './contrib_carriers.mts';
import {
  exerciseNativeCarrierSql,
  prepareNativeCarrierSdk,
  readNativeCargoPayload,
  writableDirectories,
} from './native_carrier_install_helpers.mts';
import { nativeCarrierCompatibility, nativeCarrierLeaves } from './native_carriers.mts';

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
  pgtapNpm,
] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as NativeContribCarrierSpec;
spec.outputs = {
  github: githubFile,
  npm: npmFile,
  cargo: cargoDirectory,
  manifest: manifestFile,
  frozen: frozenFile,
};
validateNativeContribInputs(spec);
const identities = nativeCarrierLeaves(spec);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const root = mkdtempSync(path.join(tmpdir(), 'native-contrib-final-install-'));
const caches = new Set<string>();
try {
  const gh = readPortableArchiveEntries(realpathSync(githubFile));
  const prefix = path.basename(githubFile, '.tar.gz');
  const bundle = JSON.parse(gh.get(`${prefix}/bundle-manifest.json`)!.data().toString('utf8'));
  assert.equal(bundle.schema, 'oliphaunt-extension-bundle-v1');
  assert.equal(bundle.product, spec.product);
  assert.equal(bundle.version, spec.version);
  assert.equal(bundle.family, 'native');
  assert.equal(bundle.target, spec.target);
  assert.deepEqual(bundle.compatibility, nativeCarrierCompatibility(spec));
  assert.deepEqual(
    bundle.members.map((member: any) => member.sqlName),
    spec.expectedMembers,
  );
  assert.equal(bundle.licenseProfile, 'contrib-native-openssl');
  assert.deepEqual(bundle.licenseFiles, []);
  assertReleaseNoticesInArchive(realpathSync(githubFile), {
    prefix,
    profile: bundle.licenseProfile,
  });
  assert.deepEqual(
    [...gh.keys()].sort(),
    [
      `${prefix}/bundle-manifest.json`,
      ...bundle.members.map((member: any) => `${prefix}/${member.path}`),
      ...releaseNoticeRows({ profile: bundle.licenseProfile }).map(
        (row) => `${prefix}/${row.member}`,
      ),
    ].sort(),
    'contrib bundle must contain only canonical members and legal files',
  );
  for (const entry of gh.values()) {
    assert(entry.isFile);
    assert.equal(entry.mode, 0o644);
  }

  const npm = readPortableArchiveEntries(realpathSync(npmFile));
  const packageJson = JSON.parse(npm.get('package/package.json')!.data().toString('utf8'));
  assert.equal(packageJson.name, identities.npm.name);
  assert.equal(packageJson.version, spec.version);
  assert.equal(packageJson.oliphaunt.liboliphauntVersion, spec.runtimeVersion);
  assert.deepEqual(packageJson.os, ['linux']);
  assert(['linux-x64-gnu', 'linux-arm64-gnu'].includes(spec.target));
  assert.deepEqual(packageJson.cpu, [spec.target === 'linux-arm64-gnu' ? 'arm64' : 'x64']);
  assert.deepEqual(packageJson.libc, ['glibc']);
  const contracts = JSON.parse(npm.get('package/extension-contract.json')!.data().toString('utf8'));
  assert.deepEqual(
    contracts.members.map((member: any) => member.sqlName),
    spec.expectedMembers,
  );
  const npmBundle = JSON.parse(npm.get('package/bundle-manifest.json')!.data().toString('utf8'));
  assert.equal(npmBundle.schema, 'oliphaunt-npm-extension-bundle-v1');
  assert.deepEqual(
    npmBundle.members.map((member: any) => member.sqlName),
    spec.expectedMembers,
  );
  const cargo = readNativeCargoPayload(cargoDirectory, identities.cargo.name, spec.version, [
    'MIT',
    'PostgreSQL',
    'Apache-2.0',
  ]);
  const expectedCargo = new Map<string, string>();
  const publicEntries = new Map<string, ReturnType<typeof readPortableArchiveEntries>>();
  for (const member of bundle.members) {
    const bytes = gh.get(`${prefix}/${member.path}`)!.data();
    assert.equal(member.identity, null);
    assert.equal(member.kind, 'runtime');
    assert.equal(
      member.path,
      `extensions/${member.sqlName}/${spec.product}-${spec.version}-native-${spec.target}-runtime.tar.gz`,
    );
    assert.equal(member.bytes, bytes.length);
    assert.equal(member.sha256, digest(bytes));
    const nested = path.join(root, member.sqlName + '.tar.gz');
    writeFileSync(nested, bytes);
    const contract = contracts.members.find((row: any) => row.sqlName === member.sqlName);
    assert(contract);
    const metadata = {
      ...contract,
      nativeConstructionLicenseFiles: nativeExtensionConstructionLicenseInventory(
        member.sqlName,
        spec.target,
      ),
    };
    validateExtensionArtifactArchive({
      file: nested,
      metadata,
      product: spec.product,
      target: spec.target,
      nativeRuntimeVersion: spec.runtimeVersion,
    });
    const entries = readPortableArchiveEntries(nested);
    publicEntries.set(member.sqlName, entries);
    const npmMember = npmBundle.members.find((row: any) => row.sqlName === member.sqlName);
    assert.equal(npmMember.path, member.path);
    assert.equal(npmMember.sha256, member.sha256);
    assert.equal(npmMember.bytes, member.bytes);
    assert.deepEqual(npm.get('package/' + npmMember.path)!.data(), bytes);
    for (const [name, entry] of entries)
      if (name.startsWith('files/')) {
        const relative = name.slice('files/'.length);
        assert.deepEqual(
          npm.get(`package/${npmMember.runtimeRelativePath}/${relative}`)!.data(),
          entry.data(),
        );
        expectedCargo.set(`extensions/${member.sqlName}/${relative}`, digest(entry.data()));
      }
  }
  assert.deepEqual(
    cargo,
    expectedCargo,
    'Cargo and npm must carry the same exact nested GitHub payload bytes',
  );

  for (const [file, schema] of [
    [frozenFile, 'oliphaunt-extension-ci-artifacts-v2'],
    [manifestFile, 'oliphaunt-extension-release-manifest-v2'],
  ]) {
    const release = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(release.schema, schema);
    assert.equal(release.product, spec.product);
    assert.equal(release.releaseProduct, spec.owner);
    assert.equal(release.family, 'native');
    assert.equal(release.version, spec.version);
    assert.deepEqual(release.compatibility, nativeCarrierCompatibility(spec));
    assert.deepEqual(
      release.extensions.map((member: any) => member.sqlName),
      spec.expectedMembers,
    );
    const assets = release.carrierAssets ?? release.assets;
    assert.equal(
      assets.length,
      1,
      'selected Linux manifest input cannot invent complete release coverage',
    );
    assert.equal(assets[0].name, path.basename(githubFile));
    assert.equal(assets[0].sha256, digest(readFileSync(githubFile)));
    assert.equal(assets[0].bytes, readFileSync(githubFile).length);
    assert.equal(assets[0].memberCount, spec.expectedMembers.length);
    for (const member of release.extensions) {
      assert.equal(member.assets.length, 1);
      const asset = member.assets[0],
        nested = bundle.members.find((row: any) => row.sqlName === member.sqlName);
      assert.equal(asset.carrierAsset, assets[0].name);
      assert.equal(asset.carrierRoot, prefix);
      assert.equal(asset.memberPath, nested.path);
      assert.equal(asset.sha256, nested.sha256);
      assert.equal(asset.bytes, nested.bytes);
    }
  }

  const facade = spec.carriers.find((row) => row.ecosystem === 'npm' && row.target === null)!;
  const desktopOwnerFixture = {
    name: facade.name,
    version: facade.version,
    oliphauntQualificationFixture: {
      schema: 'oliphaunt-selected-desktop-owner-fixture-v1',
      target: spec.target,
      testOnly: true,
      completeShippingFacade: false,
    },
    oliphaunt: {
      kind: 'exact-extension-bundle',
      product: spec.product,
      members: spec.expectedMembers,
      liboliphauntVersion: spec.runtimeVersion,
      targetPackageNames: Object.fromEntries(
        spec.carriers
          .filter((row) => row.ecosystem === 'npm' && row.role === 'platform-leaf')
          .map((row) => [row.target, row.name]),
      ),
    },
  };
  const fixtureDirectory = path.join(root, 'node_modules', facade.name);
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(
    path.join(fixtureDirectory, 'package.json'),
    JSON.stringify(desktopOwnerFixture, null, 2),
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(fixtureDirectory, 'package.json'), 'utf8'))
      .oliphauntQualificationFixture.testOnly,
    true,
  );
  console.log(
    'Using serialized test-only desktop owner metadata; complete shipping facade remains unproduced.',
  );
  const { assets, install, runtime, packages, materialize, sdkRuntimeVersion } =
    await prepareNativeCarrierSdk({
      root,
      runtimeFile,
      npmFiles: [npmFile, pgtapNpm],
      runtimeVersion: spec.runtimeVersion,
      selected: ['cube', 'pg_trgm'],
    });
  const selected = ['cube', 'pg_trgm'];
  const descriptor = new Map(spec.members.map((member) => [member.sqlName, member.descriptor]));
  const assertSelected = (materialized: any, selectedSql: string[]) => {
    assert(materialized.runtimeDirectory);
    assert(materialized.moduleDirectory);
    caches.add(path.dirname(materialized.runtimeDirectory));
    const expectedModules = selectedSql
      .filter((sql) => descriptor.has(sql))
      .map((sql) => descriptor.get(sql)!['native-module-file'])
      .sort();
    const baseModules = [path.join(runtime, 'lib/modules'), path.join(runtime, 'modules')].flatMap(
      (directory) => (existsSync(directory) ? readdirSync(directory) : []),
    );
    assert.deepEqual(
      readdirSync(materialized.moduleDirectory).sort(),
      [...new Set([...baseModules, ...expectedModules])].sort(),
    );
    for (const member of spec.members) {
      const wanted = selectedSql.includes(member.sqlName);
      for (const [name, entry] of publicEntries.get(member.sqlName)!)
        if (name.startsWith('files/')) {
          const relative = name.slice('files/'.length);
          if (wanted)
            assert.deepEqual(
              readFileSync(path.join(materialized.runtimeDirectory, relative)),
              entry.data(),
            );
          else if (relative.startsWith('lib/') || relative.startsWith('share/postgresql/'))
            assert(
              !existsSync(path.join(materialized.runtimeDirectory, relative)),
              `unselected contrib payload staged: ${member.sqlName}/${relative}`,
            );
        }
    }
  };
  const contribOnly = await materialize(selected);
  assertSelected(contribOnly, selected);
  const combined = await materialize([...selected, 'pgtap']);
  assertSelected(combined, [...selected, 'pgtap']);
  assert(
    existsSync(path.join(combined.runtimeDirectory, 'share/postgresql/extension/pgtap.control')),
  );
  exerciseNativeCarrierSql({
    root,
    runtime,
    materialized: combined,
    consumerFile,
    plans: [installSql, smokeSql, startupFile],
  });
  await assert.rejects(
    () => materialize(['not_a_catalogued_extension']),
    /unknown|unsupported|catalog/i,
  );
  if (sdkRuntimeVersion === spec.runtimeVersion) {
    const unused = path.join(
      packages[0].directory,
      'extensions/amcheck/runtime/lib/modules/foreign.so',
    );
    mkdirSync(path.dirname(unused), { recursive: true });
    writeFileSync(unused, 'undeclared module');
    await assert.rejects(
      () => assets.materializeExtensionInstall(install, ['amcheck']),
      /undeclared runtime file/,
    );
  }
  console.log(
    `${spec.product}@${spec.version}: all ${spec.expectedMembers.length} runtime-owned nested GitHub/npm/Cargo members verified; only cube/pg_trgm selected, pgtap combined, ${sdkRuntimeVersion === spec.runtimeVersion ? 'matching source SDK asset staging' : 'explicit runtime-directory staging with held SDK rejection'}, actual supplier/embedded restart/server SQL proved.`,
  );
} finally {
  for (const cache of caches) rmSync(cache, { recursive: true, force: true });
  writableDirectories(root);
  rmSync(root, { recursive: true, force: true });
}
