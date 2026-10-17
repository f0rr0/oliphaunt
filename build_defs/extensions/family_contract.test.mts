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
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { rustNativeTargetCfg } from '../../tools/packaging/rust-native-targets.mts';
import { validateChecksumManifest } from '../../tools/release/checksum-manifest.mts';
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
const manifest = json(spec.outputs['control_manifest-json']);
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
  const allowed = new Set([
    ...leafNames,
    'liboliphaunt-native-bindings',
    ...(spec.ownerFamilies.includes('wasix') ? ['oliphaunt-wasix'] : []),
  ]);
  assert.deepEqual([...dependencies.keys()].sort(), [...allowed].sort());
  for (const name of leafNames) {
    assert.equal(dependencies.get(name).version, `=${spec.version}`);
    assert.equal(dependencies.get(name).path, undefined);
    assert.equal(dependencies.get(name).optional, true);
  }
  assert.equal(
    dependencies.get('liboliphaunt-native-bindings').version,
    `^${spec.cargoFacadeMetadata.bindingVersion}`,
  );
  assert.equal(
    cargo['build-dependencies']['oliphaunt-build'].version,
    `^${spec.cargoFacadeMetadata.sdkVersion}`,
  );
  for (const target of spec.cargoFacadeMetadata.targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const expected = spec.carriers.find(
      (row) => row.ecosystem === 'cargo' && row.target === target,
    );
    assert(expected && cargo.target[`cfg(${cfg})`].dependencies[expected.name]);
  }
  if (spec.ownerFamilies.includes('wasix')) {
    assert.equal(
      dependencies.get('oliphaunt-wasix').version,
      `^${spec.cargoFacadeMetadata.wasixSdkVersion}`,
    );
    assert(cargo.features.wasix.includes('dep:oliphaunt-wasix'));
  } else assert.equal(cargo.features.wasix, undefined);
}
if (spec.outputs.npm) {
  const archive = readPortableArchiveEntries(spec.outputs.npm);
  const manifest = JSON.parse(archive.get('package/package.json')!.data().toString('utf8'));
  const facade = spec.carriers.find(
    (row) => row.ecosystem === 'npm' && row.target === null && row.role === 'facade',
  );
  assert.equal(manifest.name, facade.name);
  assert.equal(manifest.version, spec.version);
  const targets = spec.profiles
    .filter((row) => row.kind === 'native-dynamic')
    .map((row) => row.target);
  const leaves = spec.carriers.filter(
    (row) => row.ecosystem === 'npm' && targets.includes(row.target),
  );
  assert.deepEqual(
    manifest.optionalDependencies,
    Object.fromEntries(leaves.map((row) => [row.name, spec.version])),
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
