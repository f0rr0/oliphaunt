/** Actual final facade/control bytes; original hosts retain their own runtime qualification. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  composeExtensionReleaseDocuments,
  extensionReleasePropertiesText,
} from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { rustNativeTargetCfg } from '../../tools/packaging/rust-native-targets.mts';
import { validateChecksumManifest } from '../../tools/release/checksum-manifest.mts';
import { frozenExtensionOwnerRequirements } from '../../tools/release/extension-release-metadata.mts';
import {
  DESKTOP_TARGETS,
  extensionOwnerForSqlName,
} from '../../tools/release/release-artifact-targets.mts';
import { declaredWasixDependencyManifest } from './declared_final_inputs.mts';
import {
  mergeNativeFinalMembers,
  type NativeOwnerSpec,
  ownerFamilyCompleteness,
} from './owner_carriers.mts';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const [specFile, locationsFile, runfiles] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
const locations = json(locationsFile);
const resolve = (value: any): any =>
  typeof value === 'string' && locations[value]
    ? realpathSync(path.join(runfiles, locations[value]))
    : Array.isArray(value)
      ? value.map(resolve)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
        : value;
const spec = resolve(json(specFile)) as NativeOwnerSpec;
const completeness = ownerFamilyCompleteness(spec, spec.leaves);
assert(completeness.completeExtensionDistribution);
const cohorts = spec.leaves.map((leaf) => {
  const frozen = json(leaf.frozen);
  return { members: frozen.extensions ?? [frozen], assets: frozen.carrierAssets ?? frozen.assets };
});
const members = mergeNativeFinalMembers(spec, cohorts);
const directAssets = cohorts.flatMap((cohort) => cohort.assets);
const family = spec.ownerFamilies.length > 1 ? null : spec.ownerFamilies[0];
const documents = composeExtensionReleaseDocuments({
  product: spec.product,
  releaseProduct: spec.owner,
  version: spec.version,
  family,
  members,
  directAssets,
  releaseMetadata: spec.releaseMetadata,
});
const frozen = json(spec.outputs.frozen);
const manifest = json(spec.outputs['control_manifest-json']);
const schemaVersion = spec.members.length > 1 ? 2 : 1;
const hasOwnership = spec.owner !== spec.product || family !== null;
for (const [document, schema] of [
  [frozen, `oliphaunt-extension-ci-artifacts-v${schemaVersion}`],
  [manifest, `oliphaunt-extension-release-manifest-v${schemaVersion}`],
] as const) {
  assert.equal(document.schema, schema);
  assert.equal(document.product, spec.product);
  assert.equal(document.version, spec.version);
  assert.deepEqual(document.compatibility, spec.releaseMetadata.compatibility);
  assert.equal(Object.hasOwn(document, 'releaseProduct'), hasOwnership);
  assert.equal(Object.hasOwn(document, 'family'), hasOwnership);
  if (hasOwnership) {
    assert.equal(document.releaseProduct, spec.owner);
    assert.equal(document.family, family ?? 'combined');
  }
}
const withoutAssetLocators = (value: any) => {
  const result = structuredClone(value);
  for (const asset of [
    ...(result.carrierAssets ?? []),
    ...(result.extensions ?? [result]).flatMap((member) => member.assets),
  ]) {
    delete asset.path;
    delete asset.source;
  }
  return result;
};
assert.deepEqual(
  withoutAssetLocators(frozen),
  withoutAssetLocators(JSON.parse(JSON.stringify(documents.manifest))),
);
for (const asset of frozen.carrierAssets ?? frozen.assets)
  assert.equal(asset.path, `product/release-assets/${asset.name}`);
if (frozen.extensions)
  for (const member of frozen.extensions)
    for (const asset of member.assets)
      assert.equal(asset.path, `product/member-assets/${member.sqlName}/${asset.name}`);
assert.deepEqual(manifest, JSON.parse(JSON.stringify(documents.releaseData)));
assert.equal(
  readFileSync(spec.outputs['control_manifest-properties'], 'utf8'),
  extensionReleasePropertiesText({
    product: spec.product,
    releaseProduct: spec.owner,
    family,
    version: spec.version,
    manifest: documents.manifest,
    releaseData: documents.releaseData,
    directAssets,
    compatibility: spec.releaseMetadata.compatibility,
  }),
);
const controls = Object.entries(spec.outputs)
  .filter(([key]) => key.startsWith('control_') && key !== 'control_checksums')
  .map(([, file]) => file);
validateChecksumManifest(
  spec.outputs.control_checksums,
  [...spec.leaves.flatMap((leaf) => leaf.github), ...controls],
  spec.product,
);
if (spec.outputs.cargo) {
  const api = Bun.TOML.parse(
    readFileSync(
      new URL('../../src/extensions/artifacts/packages/Cargo.toml', import.meta.url),
      'utf8',
    ),
  );
  const archive = readPortableArchiveEntries(spec.outputs.cargo);
  const cargo = Bun.TOML.parse(
    archive.get(`${spec.product}-${spec.version}/Cargo.toml`)!.data().toString('utf8'),
  ) as any;
  assert.equal(cargo.package.name, spec.product);
  assert.equal(cargo.package.version, spec.version);
  assert.deepEqual(cargo.features.default, ['native']);
  const dependencies = new Map<string, any>(Object.entries(cargo.dependencies ?? {}));
  for (const row of Object.values(cargo.target ?? {}) as any[])
    for (const [name, dependency] of Object.entries(row.dependencies ?? {})) {
      assert(!dependencies.has(name), 'final facade repeats a target dependency');
      dependencies.set(name, dependency);
    }
  const leafNames = spec.carriers
    .filter((row) => row.ecosystem === 'cargo' && row.target !== null)
    .map((row) => row.name);
  const requirements = (family: 'native' | 'wasix') =>
    frozenExtensionOwnerRequirements({
      product: spec.product,
      releaseProduct: family === 'native' ? spec.owner : spec.cargoFacadeMetadata.wasixOwner,
      members:
        family === 'native'
          ? members
          : members.map((member) => ({
              sqlName: member.sqlName,
              dependencies: member.wasixInstall.dependencies,
            })),
      runtimeProduct: `liboliphaunt-${family}`,
      runtimeVersion: spec.releaseMetadata.compatibility[`${family}RuntimeVersion`],
      ownerForSqlName: (sqlName) =>
        extensionOwnerForSqlName(sqlName, family, {
          ownerMetadata: spec.ownerMetadata,
        }),
    });
  const nativeRequirements = requirements('native');
  const wasixRequirements = spec.ownerFamilies.includes('wasix') ? requirements('wasix') : [];
  const captured = (spec.wasixDependencyManifests ?? []).map(declaredWasixDependencyManifest);
  const installs = new Map(members.map((member) => [member.sqlName, member.wasixInstall]));
  const selectedForeignModules = new Set<string>();
  const visited = new Set<string>();
  const pending = spec.ownerFamilies.includes('wasix') ? [...installs.keys()] : [];
  for (const sqlName of pending) {
    if (sqlName === 'plpgsql' || visited.has(sqlName)) continue;
    visited.add(sqlName);
    let install = installs.get(sqlName);
    if (!install) {
      const owner = extensionOwnerForSqlName(sqlName, 'wasix', {
        ownerMetadata: spec.ownerMetadata,
      });
      const supplier = captured.find((row) => row.product === owner.product);
      install = supplier?.members.find((member) => member.sqlName === sqlName)?.wasixInstall;
      assert(install, 'final facade dependency lacks its captured WASIX install');
      if (install.nativeModules.length) selectedForeignModules.add(owner.product);
    }
    pending.push(...install.dependencies);
  }
  const foreignPortable = wasixRequirements.map(({ product }) =>
    wasixExtensionPackageName(product),
  );
  const foreignAot = wasixRequirements.filter(({ product }) => selectedForeignModules.has(product));
  const foreignNames = [
    ...nativeRequirements.map(({ product }) => product),
    ...foreignPortable,
    ...foreignAot.flatMap(({ product }) =>
      expectedExtensionAotTargets().map((target) => wasixExtensionAotPackageName(product, target)),
    ),
  ];
  assert.deepEqual(
    [...dependencies.keys()].sort(),
    [
      ...leafNames,
      ...foreignNames,
      'liboliphaunt-native-bindings',
      ...(spec.ownerFamilies.includes('wasix') ? ['oliphaunt-wasix'] : []),
    ].sort(),
  );
  const exact = new Map(leafNames.map((name) => [name, spec.version]));
  for (const requirement of nativeRequirements) exact.set(requirement.product, requirement.version);
  for (const requirement of wasixRequirements)
    exact.set(wasixExtensionPackageName(requirement.product), requirement.version);
  for (const requirement of foreignAot)
    for (const target of expectedExtensionAotTargets())
      exact.set(wasixExtensionAotPackageName(requirement.product, target), requirement.version);
  for (const [name, dependency] of dependencies) {
    if (exact.has(name)) assert.equal(dependency.version, `=${exact.get(name)}`);
    assert.equal(dependency.path, undefined);
    assert.equal(dependency.optional, true);
  }
  assert.equal(
    dependencies.get('liboliphaunt-native-bindings').version,
    api.dependencies['liboliphaunt-native-bindings'],
  );
  assert.equal(
    cargo['build-dependencies']['oliphaunt-build'].version,
    api['build-dependencies']['oliphaunt-build'],
  );
  for (const target of spec.cargoFacadeMetadata.targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const expected = spec.carriers.find(
      (row) => row.ecosystem === 'cargo' && row.target === target,
    );
    assert(expected && cargo.target[`cfg(${cfg})`].dependencies[expected.name]);
    for (const { product } of foreignAot)
      assert(
        cargo.target[`cfg(${cfg})`].dependencies[
          wasixExtensionAotPackageName(product, DESKTOP_TARGETS[target].triple)
        ],
      );
  }
  if (spec.ownerFamilies.includes('wasix')) {
    assert.equal(dependencies.get('oliphaunt-wasix').version, api.dependencies['oliphaunt-wasix']);
    assert(cargo.features.wasix.includes('dep:oliphaunt-wasix'));
    for (const name of foreignPortable) assert(cargo.features.wasix.includes(`dep:${name}`));
    for (const { product } of foreignAot)
      for (const target of expectedExtensionAotTargets())
        assert(
          cargo.features.wasix.includes(`dep:${wasixExtensionAotPackageName(product, target)}`),
        );
  } else assert.equal(cargo.features.wasix, undefined);
  for (const { product } of nativeRequirements) {
    assert.deepEqual(dependencies.get(product).features, ['native']);
    assert(cargo.features.native.includes(`dep:${product}`));
    assert(!cargo.features.wasix?.includes(`dep:${product}`));
  }
}
if (spec.outputs.npm) {
  const archive = readPortableArchiveEntries(spec.outputs.npm);
  const manifest = JSON.parse(archive.get('package/package.json')!.data().toString('utf8'));
  const api = json(
    path.resolve(import.meta.dirname, '../../src/extensions/artifacts/packages/package.json'),
  );
  assert.deepEqual(manifest.peerDependencies, api.peerDependencies);
  assert.deepEqual(manifest.peerDependenciesMeta, api.peerDependenciesMeta);
  const facade = spec.carriers.find(
    (row) => row.ecosystem === 'npm' && row.target === null && row.role === 'facade',
  );
  assert.equal(manifest.name, facade.name);
  assert.equal(manifest.version, spec.version);
  const targets = spec.profiles
    .filter((row) => row.kind === 'native-dynamic')
    .map((row) => row.target);
  const leaves = spec.carriers.filter(
    (row) =>
      row.ecosystem === 'npm' &&
      targets.includes(row.target) &&
      row.name === `${facade.name}-${row.target}`,
  );
  assert.deepEqual(
    leaves.map((row) => row.target).sort(),
    [...targets].sort(),
    'final facade requires exactly one native npm carrier for every dynamic target',
  );
  assert.deepEqual(
    manifest.optionalDependencies,
    Object.fromEntries(leaves.map((row) => [row.name, spec.version])),
  );
  assert.deepEqual(
    manifest.oliphaunt.targetPackageNames,
    Object.fromEntries(leaves.map((row) => [row.target, row.name])),
  );
  assert.deepEqual(
    [...manifest.oliphaunt.members].sort(),
    spec.members.map((row) => row.sqlName).sort(),
  );
  assert.equal(manifest.oliphaunt.liboliphauntVersion, spec.runtimeVersion);
  assert.equal(
    manifest.oliphaunt.runtimeBound,
    spec.releaseMetadata.versioning === 'runtime-bound',
  );
  const ios = JSON.parse(
    archive
      .get(`package/${manifest.oliphaunt.iosCarrierManifest.slice(2)}`)!
      .data()
      .toString('utf8'),
  );
  const base = json(spec.baseCarrierManifest!);
  assert.deepEqual(ios.base, base.base);
  assert.deepEqual(ios.legal.base, base.legal.base);
  assert.deepEqual(
    ios.extensions.map((row) => row.sqlName).sort(),
    spec.members.map((row) => row.sqlName).sort(),
  );
  const root = realpathSync(
    mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'final-extension-facade-')),
  );
  try {
    const directory = path.join(root, 'node_modules', manifest.name);
    extractPortableArchiveTree(spec.outputs.npm, directory, 'package');
    const require = createRequire(path.join(root, 'consumer.cjs'));
    const packageJson = path.join(directory, 'package.json');
    assert.equal(require.resolve(`${manifest.name}/package.json`), packageJson);
    assert.equal(require.resolve(manifest.name), path.join(directory, 'index.js'));
    const host = spec.leaves
      .filter((leaf) => leaf.family === 'native')
      .flatMap((leaf) => leaf.npm)
      .map((file) => ({
        file,
        manifest: JSON.parse(
          readPortableArchiveEntries(file).get('package/package.json')!.data().toString('utf8'),
        ),
      }))
      .filter(
        ({ manifest: leaf }) =>
          leaf.os?.includes(process.platform) && leaf.cpu?.includes(process.arch),
      );
    assert.equal(host.length, 1, 'final facade requires its one original host npm carrier');
    const leaf = host[0].manifest;
    assert.equal(manifest.optionalDependencies[leaf.name], leaf.version);
    assert.equal(manifest.oliphaunt.targetPackageNames[leaf.oliphaunt.target], leaf.name);
    assert.equal(leaf.version, spec.version);
    assert.equal(leaf.oliphaunt.product, spec.product);
    assert.equal(leaf.oliphaunt.liboliphauntVersion, spec.runtimeVersion);
    assert.deepEqual([...leaf.oliphaunt.members].sort(), [...manifest.oliphaunt.members].sort());
    const targetDirectory = path.join(root, 'node_modules', leaf.name);
    extractPortableArchiveTree(host[0].file, targetDirectory, 'package');
    assert.equal(
      createRequire(packageJson).resolve(`${leaf.name}/package.json`),
      path.join(targetDirectory, 'package.json'),
    );
    for (const name of ['index.js', 'mobile.js']) {
      const file = path.join(directory, name);
      const module = await import(pathToFileURL(file).href);
      assert.deepEqual(
        Object.keys(module).sort(),
        spec.members.map((row) => row.sqlName.replaceAll('-', '_')).sort(),
      );
      for (const member of spec.members) {
        const descriptor = module[member.sqlName.replaceAll('-', '_')];
        assert(Object.isFrozen(descriptor));
        const { packageJsonUrl, ...identity } = descriptor;
        assert.deepEqual(identity, {
          schema: 'oliphaunt-native-extension-v1',
          sqlName: member.sqlName,
          product: spec.product,
          packageName: facade.name,
          version: spec.version,
        });
        assert.equal(typeof packageJsonUrl, name === 'index.js' ? 'string' : 'undefined');
        if (name === 'index.js') assert.equal(fileURLToPath(packageJsonUrl), packageJson);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
