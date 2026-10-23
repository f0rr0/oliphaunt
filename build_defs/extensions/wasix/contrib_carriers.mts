/** Runtime-owned WASIX contrib envelopes from the complete declared module cohort. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { bundleCarrierAssets } from '../../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { stageExtensionWasixNpmPackages } from '../../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import { packageDeclaredWasixExtensionCargo } from '../../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { extensionCompatibilityMetadata } from '../../../tools/release/extension-release-metadata.mts';
import { stageCompiledWasixMember, type WasixCompiledCarrierSpec } from '../wasix_carriers.mts';

interface WasixContribMemberSpec extends WasixCompiledCarrierSpec {
  owner: string;
  runtimeVersion: string;
  contrib: Record<string, any>;
}

export interface WasixContribCarrierSpec
  extends Omit<WasixCompiledCarrierSpec, 'operation' | 'modules' | 'resources' | 'link' | 'aot'> {
  operation: 'contrib';
  owner: string;
  runtimeVersion: string;
  expectedMembers: string[];
  members: WasixContribMemberSpec[];
  sourceIdentity: Record<string, string>;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function validateWasixContribInputs(spec: WasixContribCarrierSpec) {
  assert.equal(spec.product, 'oliphaunt-extension-contrib-pg18');
  assert.equal(spec.owner, 'liboliphaunt-wasix');
  assert.equal(spec.target, 'wasix-portable');
  assert.equal(spec.version, spec.runtimeVersion, 'contrib follows its runtime owner version');
  assert.equal(spec.version, spec.compatibility.wasix_runtime_version);
  assert.equal(spec.owner, spec.compatibility.wasix_runtime_product);
  assert.equal(spec.releaseMetadata.class, 'contrib');
  assert.equal(spec.releaseMetadata.versioning, 'runtime-bound');
  assert.deepEqual(
    spec.releaseMetadata.compatibility,
    extensionCompatibilityMetadata(spec.compatibility),
  );
  assert.equal(
    spec.expectedMembers.length,
    32,
    'contrib must contain the complete canonical inventory',
  );
  assert.equal(new Set(spec.expectedMembers).size, spec.expectedMembers.length);
  assert.deepEqual(spec.members.map((member) => member.sqlName).sort(), spec.expectedMembers);
  for (const member of spec.members) {
    assert.equal(member.owner, spec.owner);
    assert.equal(member.product, spec.product);
    assert.equal(member.version, spec.version);
    assert.equal(member.runtimeVersion, spec.runtimeVersion);
    assert.equal(member.target, spec.target);
    assert.deepEqual(member.compatibility, spec.compatibility);
    assert.equal(member.descriptor['source-kind'], 'postgres-contrib');
    assert.equal(member.contrib['sql-name'], member.sqlName);
    assert.equal(member.descriptor['native-module-file'], member.contrib['module-file']);
    assert.deepEqual(member.recipe.artifacts.data_files, member.contrib['data-files'] ?? []);
    assert.deepEqual(member.releaseMetadata.sourceIdentity, spec.sourceIdentity);
    if (member.descriptor.lifecycle['create-extension'])
      assert.equal(
        member.source['extension-control']['default-version'],
        member.contrib['default-version'],
      );
  }
  const npm = spec.carriers.filter((row) => row.ecosystem === 'npm');
  const cargo = spec.carriers.filter((row) => row.ecosystem === 'cargo');
  assert.equal(npm.length, 1, 'contrib has one canonical npm portable bundle');
  assert.equal(npm[0].name, '@oliphaunt/extension-contrib-pg18-wasix');
  assert.equal(npm[0].target, null);
  assert.equal(npm[0].role, 'facade');
  assert.equal(cargo.length, Object.keys(AOT_TARGET_TRIPLES).length + 1);
  assert.equal(
    new Set(spec.carriers.map((row) => `${row.ecosystem}:${row.name}`)).size,
    spec.carriers.length,
  );
  for (const row of spec.carriers) {
    assert.equal(row.product, spec.owner);
    assert.equal(row.version, spec.version);
  }
  assert.equal(
    path.basename(spec.outputs.github),
    `${spec.product}-${spec.version}-wasix-wasix-portable-bundle.tar.gz`,
  );
}

export async function packageWasixContribCarriers(spec: WasixContribCarrierSpec) {
  validateWasixContribInputs(spec);
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-contrib-envelopes-'),
  );
  try {
    const productRoot = path.join(root, 'product');
    const staged = [];
    for (const member of spec.members) {
      const row = await stageCompiledWasixMember(
        member,
        [],
        productRoot,
        path.join(productRoot, 'member-assets', member.sqlName),
      );
      staged.push(row);
    }
    const members = staged.map(({ member, archive }) => ({
      ...member,
      assets: member.assets.map((asset) => ({
        ...asset,
        path: path.relative(root, archive).split(path.sep).join('/'),
      })),
    }));
    const compatibility = extensionCompatibilityMetadata(spec.compatibility);
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    const assets = bundleCarrierAssets(
      spec.product,
      spec.version,
      productRoot,
      members,
      compatibility,
      { root },
    );
    assert.equal(assets.length, 1, 'contrib must produce one complete portable bundle');
    assert.equal(assets[0].memberCount, spec.expectedMembers.length);
    assert.equal(assets[0].name, path.basename(spec.outputs.github));
    const { manifest, releaseData } = composeExtensionReleaseDocuments({
      product: spec.product,
      releaseProduct: spec.owner,
      family: 'wasix',
      version: spec.version,
      members,
      directAssets: assets,
      releaseMetadata: spec.releaseMetadata,
      sourceIdentity: spec.sourceIdentity,
    });
    const frozen = path.join(productRoot, 'extension-artifacts.json');
    const releaseManifest = path.join(
      productRoot,
      'release-assets',
      path.basename(spec.outputs.manifest),
    );
    writeJson(frozen, manifest);
    writeJson(releaseManifest, releaseData);
    const result = { staged: [] as string[], skipped: [] as string[] };
    assert(stageExtensionWasixNpmPackages([productRoot], path.join(root, 'npm-stage'), result));
    assert.equal(result.staged.length, 1, 'contrib must retain its single canonical npm bundle');
    mkdirSync(spec.outputs.npm, { recursive: true });
    const npm = result.staged[0];
    const npmEntry = readPortableArchiveEntries(npm).get('package/package.json');
    assert(
      npmEntry?.isFile && !npmEntry.isSymbolicLink,
      'npm bundle must contain a regular manifest',
    );
    const npmMetadata = JSON.parse(npmEntry.data().toString());
    const npmRow = spec.carriers.find((row) => row.ecosystem === 'npm');
    assert(npmRow, 'npm bundle must retain its declared carrier identity');
    assert.equal(npmMetadata.name, npmRow.name);
    assert.equal(npmMetadata.version, spec.version);
    copyFileSync(npm, path.join(spec.outputs.npm, path.basename(npm)));
    const cargo = packageDeclaredWasixExtensionCargo(
      {
        product: spec.product,
        version: spec.version,
        runtimeProduct: spec.owner,
        runtimeVersion: spec.runtimeVersion,
        versioning: 'runtime-bound',
        extensionRoot: productRoot,
        members: staged.map(({ member, archive, asset, wasixInstall }) => ({
          sqlName: member.sqlName,
          dependencies: member.dependencies,
          nativeModuleStem: member.nativeModuleStem,
          archive,
          sha256: asset.sha256,
          size: asset.bytes,
          install: wasixInstall,
        })),
      },
      { outputDir: path.join(root, 'cargo-stage'), workDir: path.join(root, 'cargo-work') },
    );
    const expectedCargo = spec.carriers
      .filter((row) => row.ecosystem === 'cargo')
      .map((row) => row.name)
      .sort();
    assert.deepEqual(
      cargo.map((row) => row.name).sort(),
      expectedCargo,
      'measured contrib carriers must retain exactly five canonical Cargo identities; split parts require declared outputs',
    );
    mkdirSync(spec.outputs.cargo, { recursive: true });
    for (const row of cargo) {
      copyFileSync(row.cratePath, path.join(spec.outputs.cargo, path.basename(row.cratePath)));
    }
    for (const [source, destination] of [
      [path.join(root, assets[0].path), spec.outputs.github],
      [frozen, spec.outputs.frozen],
      [releaseManifest, spec.outputs.manifest],
    ]) {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: contrib_carriers.mts <declared-inputs.json>');
  await packageWasixContribCarriers(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
