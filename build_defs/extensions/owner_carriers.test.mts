/** Actual Linux leaves remain partial; immutable import rejects changed bytes. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { frozenExtensionMemberInventory } from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import { validateDeclaredExtensionFinalInput } from './declared_final_inputs.mts';
import { stageNativeRegistryCarriers, writeJson } from './native_carriers.mts';
import {
  composeNativeFinalCarriers,
  finalFileInventory,
  mergeNativeFinalMembers,
  type NativeOwnerSpec,
  nativeFamilyCompleteness,
  stageDeclaredFinalLeaf,
  validateFinalFileReceipt,
  validateNativeFinalLeaf,
} from './owner_carriers.mts';

const [
  pgtapSpecFile,
  contribSpecFile,
  pgtapCollectionFile,
  contribCollectionFile,
  importedFixtureFile,
  postgisSpecFile,
  postgisCollectionFile,
  importedCollectionFile,
] = process.argv.slice(2);
const root = mkdtempSync(path.join(tmpdir(), 'native-final-composition-test-'));
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const declared = (file: string) =>
  path.join(
    process.env.TEST_SRCDIR!,
    process.env.TEST_WORKSPACE ?? '_main',
    file.replace(/^bazel-out\/[^/]+\/bin\//u, ''),
  );
function specAt(file: string): NativeOwnerSpec {
  const spec = read(file);
  spec.components = declared(spec.components);
  for (const leaf of spec.leaves) {
    for (const group of ['github', 'npm', 'cargo']) leaf[group] = leaf[group].map(declared);
    leaf.manifest = declared(leaf.manifest);
    leaf.frozen = declared(leaf.frozen);
  }
  return spec;
}

function projectedRegistryIdentity(
  spec: NativeOwnerSpec,
  cohort: ReturnType<typeof validateNativeFinalLeaf>,
  members: any[],
  metadataOnlyTarget: string,
) {
  const fixture = {
    schema: 'oliphaunt-mixed-native-inventory-fixture-v1',
    testOnly: true,
    actualTargets: ['linux-x64-gnu'],
    metadataOnlyTargets: [metadataOnlyTarget],
    completeShippingFamily: false,
  };
  const documents = composeExtensionReleaseDocuments({
    product: spec.product,
    releaseProduct: spec.owner,
    family: 'native',
    version: spec.version,
    members,
    directAssets: cohort.directAssets,
    releaseMetadata: spec.releaseMetadata,
  });
  documents.manifest.qualificationFixture = fixture;
  documents.releaseData.qualificationFixture = fixture;
  writeJson(path.join(cohort.productRoot, 'extension-artifacts.json'), documents.manifest);
  writeJson(
    path.join(
      cohort.productRoot,
      'release-assets',
      `${spec.product}-${spec.version}-manifest.json`,
    ),
    documents.releaseData,
  );
  const outputs = {
    github: spec.leaves[0].github[0],
    npm: path.join(root, spec.product, 'projected-registry', path.basename(spec.leaves[0].npm[0])),
    cargo: path.join(root, spec.product, 'projected-registry', 'cargo'),
    manifest: '',
    frozen: '',
  };
  mkdirSync(path.dirname(outputs.npm), { recursive: true });
  stageNativeRegistryCarriers(
    {
      ...spec.members[0],
      owner: spec.owner,
      product: spec.product,
      target: 'linux-x64-gnu',
      version: spec.version,
      runtimeVersion: spec.runtimeVersion,
      carriers: spec.carriers,
      outputs,
    },
    cohort.productRoot,
    path.join(root, spec.product, 'projected-staging'),
  );
  assert.deepEqual(
    finalFileInventory({ ...spec.leaves[0], npm: [outputs.npm], cargo: [outputs.cargo] }),
    finalFileInventory(spec.leaves[0]),
    'mixed-target projection preserves every actual Linux registry byte and legal receipt',
  );
}

try {
  const pgtap = specAt(pgtapSpecFile),
    contrib = specAt(contribSpecFile),
    postgis = specAt(postgisSpecFile);
  const importedFixture = read(importedFixtureFile);
  assert.equal(importedFixture.completeNativeFamily, false);
  assert.deepEqual(importedFixture.files, read(pgtapCollectionFile).files);
  assert.equal(importedFixture.imports[0].source.job, 'test-only-receipt-fixture');
  assert.deepEqual(
    read(importedCollectionFile),
    importedFixture,
    'typed imported leaves preserve their immutable source/run receipt through subsequent collection',
  );
  for (const [spec, file, count] of [
    [pgtap, pgtapCollectionFile, 1],
    [contrib, contribCollectionFile, 32],
    [postgis, postgisCollectionFile, 1],
  ] as const) {
    const collection = read(file);
    assert.equal(collection.schema, 'oliphaunt-native-extension-final-collection-v1');
    assert.equal(collection.scope, 'construction');
    assert.equal(collection.completeNativeFamily, false);
    assert.equal(collection.completeExtensionDistribution, false);
    assert.equal(collection.members.length, count);
    assert.deepEqual(collection.targets, ['linux-x64-gnu']);
    assert.deepEqual(
      collection.missingNativeTargets,
      spec.profiles
        .map((row) => row.target)
        .filter((target) => target !== 'linux-x64-gnu')
        .sort(),
    );
    assert.deepEqual(
      collection.files,
      finalFileInventory(spec.leaves[0]).map((row) => ({ target: 'linux-x64-gnu', ...row })),
    );
    assert.throws(
      () => composeNativeFinalCarriers({ ...spec, operation: 'compose' }),
      /missing native final targets/u,
    );
    assert.throws(
      () => nativeFamilyCompleteness(spec, ['linux-x64-gnu', 'linux-x64-gnu']),
      /repeated/u,
    );
    assert.throws(() => nativeFamilyCompleteness(spec, ['fabricated-platform']), /undeclared/u);
  }

  // Use the real original GitHub/control bytes. Producer provenance below is
  // test-only; this regression checks metadata policy, not authentication.
  const originalFile = (file: string) => {
    const { size, sha256 } = fileIdentity(realpathSync(file));
    return {
      path: file,
      size,
      sha256,
      producer: {
        evidenceDigest: `sha256:${'1'.repeat(64)}`,
        invocationId: 'test-only-current-join',
        root: '//src/extensions/external/pgtap:native_carriers',
        configuration: '2'.repeat(64),
        output: path.basename(file),
      },
    };
  };
  const originalLeaf = {
    ...pgtap.leaves[0],
    npm: [],
    cargo: [],
    originalFiles: path.join(root, 'original-pgtap-files.json'),
  };
  const original = {
    product: originalLeaf.product,
    owner: originalLeaf.owner,
    version: originalLeaf.version,
    family: originalLeaf.family as 'native',
    target: originalLeaf.target,
    github: originalLeaf.github.map(originalFile),
    npm: [],
    cargo: [],
    manifest: originalFile(originalLeaf.manifest),
    frozen: originalFile(originalLeaf.frozen),
  };
  writeJson(originalLeaf.originalFiles, original);
  const currentOriginal = composeNativeFinalCarriers({
    ...pgtap,
    operation: 'collect',
    leaves: [originalLeaf],
    outputs: { collection: path.join(root, 'current-original.json') },
  });
  assert.deepEqual(currentOriginal.sourceIdentity, pgtap.releaseMetadata.sourceIdentity);
  assert.deepEqual(currentOriginal.compatibility, pgtap.releaseMetadata.compatibility);
  for (const field of ['sourceIdentity', 'compatibility']) {
    const requested = structuredClone(pgtap);
    if (field === 'sourceIdentity')
      requested.releaseMetadata.sourceIdentity.commit = 'f'.repeat(40);
    else requested.releaseMetadata.compatibility.nativeRuntimeVersion = '999.0.0';
    assert.notDeepEqual(requested.releaseMetadata[field], pgtap.releaseMetadata[field]);
    validateDeclaredExtensionFinalInput(original, {
      owner: requested.owner,
      version: requested.version,
      sqlNames: requested.members.map((member) => member.sqlName),
      sourceIdentity: requested.releaseMetadata.sourceIdentity,
      compatibility: requested.releaseMetadata.compatibility,
      extensionClass: requested.releaseMetadata.class,
      versioning: requested.releaseMetadata.versioning,
      targets: requested.profiles.map((profile) => profile.target),
    });
    stageDeclaredFinalLeaf(requested, originalLeaf, path.join(root, `historical-${field}`));
    const collection = path.join(root, `relabelled-${field}.json`);
    assert.throws(
      () =>
        composeNativeFinalCarriers({
          ...requested,
          operation: 'collect',
          leaves: [originalLeaf],
          outputs: { collection },
        }),
      /current extension join metadata differs from its original constructor/u,
    );
    assert.equal(existsSync(collection), false);
  }
  const allTargets = pgtap.profiles.map((row) => row.target);
  const native = nativeFamilyCompleteness(pgtap, allTargets);
  assert.equal(native.completeNativeFamily, true);
  assert.equal(native.completeExtensionDistribution, false);
  assert.deepEqual(native.missingOwnerFamilies, ['wasix']);
  assert.equal(nativeFamilyCompleteness(contrib, allTargets).completeExtensionDistribution, true);
  for (const spec of [pgtap, contrib]) {
    const changed = read(spec.leaves[0].manifest);
    if (changed.extensions) changed.extensions[0].dependencies = ['undeclared-member'];
    else changed.assets[0].sha256 = '0'.repeat(64);
    const manifest = path.join(root, `${spec.product}-changed-public.json`);
    writeJson(manifest, changed);
    assert.throws(
      () =>
        validateNativeFinalLeaf(
          spec,
          { ...spec.leaves[0], manifest },
          path.join(root, `${spec.product}-changed-public`),
        ),
      /public manifest differs from its frozen/u,
    );
  }

  const actualLinux = validateNativeFinalLeaf(
    contrib,
    contrib.leaves[0],
    path.join(root, 'actual-linux'),
  );
  // This second cohort is explicitly a metadata fixture. Its Android roles
  // exercise inventory selection; no foreign binary is produced or accepted.
  const metadataOnly = {
    members: structuredClone(actualLinux.members).map((member: any) => {
      delete member.nativeConstructionLicenseFiles;
      delete member.nativeDependencyModules;
      member.assets = member.assets.map((asset: any) => ({
        ...asset,
        target: 'android-arm64-v8a',
        name: asset.name.replace('linux-x64-gnu', 'android-arm64-v8a'),
        carrierAsset: asset.carrierAsset.replace('linux-x64-gnu', 'android-arm64-v8a'),
        carrierRoot: asset.carrierRoot.replace('linux-x64-gnu', 'android-arm64-v8a'),
        memberPath: asset.memberPath.replace('linux-x64-gnu', 'android-arm64-v8a'),
      }));
      return member;
    }),
  };
  const mixed = mergeNativeFinalMembers(contrib, [actualLinux, metadataOnly]);
  const crypto = mixed.find((member) => member.sqlName === 'pgcrypto')!;
  assert.equal(
    crypto.nativeConstructionLicenseFiles,
    undefined,
    'joined member must not globally assert a target-specific incorporation',
  );
  const linuxAsset = crypto.assets.find((asset: any) => asset.target === 'linux-x64-gnu')!;
  const androidAsset = crypto.assets.find((asset: any) => asset.target === 'android-arm64-v8a')!;
  assert.equal(linuxAsset.nativeConstructionLicenseFiles.length, 2);
  assert.equal(androidAsset.nativeConstructionLicenseFiles, undefined);
  const selected = (asset: any) =>
    frozenExtensionMemberInventory(crypto, {
      product: contrib.product,
      version: contrib.version,
      target: asset.target,
      asset,
    });
  assert.equal(selected(linuxAsset).nativeConstructionLicenseFiles.length, 2);
  assert.equal(selected(androidAsset).nativeConstructionLicenseFiles, undefined);
  assert.equal(
    selected({
      ...androidAsset,
      nativeConstructionLicenseFiles: linuxAsset.nativeConstructionLicenseFiles,
    }).nativeConstructionLicenseFiles.length,
    2,
    'frozen mobile metadata preserves its declared host construction receipts',
  );
  assert.throws(
    () =>
      selected({
        ...androidAsset,
        nativeConstructionLicenseFiles: linuxAsset.nativeConstructionLicenseFiles.map(
          (row: any, index: number) =>
            index === 0 ? { ...row, path: '../undeclared-source/LICENSE' } : row,
        ),
      }),
    /nativeConstructionLicenseFiles.*portable/u,
  );
  assert.throws(
    () =>
      selected({
        ...linuxAsset,
        nativeConstructionLicenseFiles: linuxAsset.nativeConstructionLicenseFiles.map(
          (row: any, index: number) => (index === 0 ? { ...row, sha256: 'invalid' } : row),
        ),
      }),
    /nativeConstructionLicenseFiles.*SHA-256/u,
  );
  const historicalLicenses = linuxAsset.nativeConstructionLicenseFiles.map((row: any) => ({
    ...row,
    sha256: '0'.repeat(64),
  }));
  assert.deepEqual(
    selected({ ...linuxAsset, nativeConstructionLicenseFiles: historicalLicenses })
      .nativeConstructionLicenseFiles,
    historicalLicenses,
    'frozen metadata preserves captured license hashes; archive validation checks the actual bytes',
  );
  assert.throws(
    () =>
      selected({
        ...linuxAsset,
        kind: 'ios-xcframework',
        nativeConstructionLicenseFiles: linuxAsset.nativeConstructionLicenseFiles,
      }),
    /native runtime/u,
  );
  const oldGlobal = actualLinux.members.find((member: any) => member.sqlName === 'pgcrypto')!;
  assert.deepEqual(
    frozenExtensionMemberInventory(oldGlobal).nativeConstructionLicenseFiles,
    selected(linuxAsset).nativeConstructionLicenseFiles,
    'old member-global defaults remain supported',
  );
  projectedRegistryIdentity(contrib, actualLinux, mixed, 'android-arm64-v8a');

  const actualPostgis = validateNativeFinalLeaf(
    postgis,
    postgis.leaves[0],
    path.join(root, 'actual-postgis'),
  );
  const metadataOnlyMac = {
    members: structuredClone(actualPostgis.members).map((member: any) => {
      delete member.nativeDependencyModules;
      member.assets = member.assets.map((asset: any) => ({
        ...asset,
        target: 'macos-arm64',
        name: asset.name.replace('linux-x64-gnu', 'macos-arm64'),
      }));
      return member;
    }),
  };
  const mixedPostgis = mergeNativeFinalMembers(postgis, [actualPostgis, metadataOnlyMac]);
  const postgisMember = mixedPostgis[0];
  assert.equal(postgisMember.nativeDependencyModules, undefined);
  const postgisLinuxAsset = postgisMember.assets.find(
    (asset: any) => asset.target === 'linux-x64-gnu',
  );
  const postgisMacAsset = postgisMember.assets.find((asset: any) => asset.target === 'macos-arm64');
  const postgisDependencies = [
    'liboliphaunt_postgis_deps.so',
    'postgis_raster-3.so',
    'postgis_topology-3.so',
  ];
  assert.deepEqual(postgisMember.sqlMembers, [
    'postgis',
    'postgis_raster',
    'postgis_tiger_geocoder',
    'postgis_topology',
  ]);
  assert.deepEqual(postgisMember.nativeModuleStems, [
    'postgis-3',
    'postgis_raster-3',
    'postgis_topology-3',
  ]);
  assert.deepEqual(postgisLinuxAsset.nativeDependencyModules, postgisDependencies);
  assert.equal(postgisMacAsset.nativeDependencyModules, undefined);
  assert.deepEqual(
    frozenExtensionMemberInventory(postgisMember, {
      product: postgis.product,
      version: postgis.version,
      asset: postgisLinuxAsset,
    }).nativeDependencyModules,
    postgisDependencies,
  );
  assert.throws(
    () =>
      frozenExtensionMemberInventory(postgisMember, {
        asset: postgisLinuxAsset,
        target: 'macos-arm64',
      }),
    /target/u,
  );
  projectedRegistryIdentity(postgis, actualPostgis, mixedPostgis, 'macos-arm64');

  // Only source/run identities below are fixtures. Every transported package
  // and digest is from the actual declared Linux producer, never a foreign leaf.
  const leaf = {
    ...pgtap.leaves[0],
    receipt: path.join(root, 'receipt.json'),
    expectedOrigin: {
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      runId: '123',
      runAttempt: 1,
      job: 'source-fixture-linux',
    },
  };
  const receipt = {
    schema: 'oliphaunt-extension-final-files-v1',
    scope: 'construction',
    product: leaf.product,
    owner: leaf.owner,
    version: leaf.version,
    target: leaf.target,
    source: leaf.expectedOrigin,
    files: finalFileInventory(leaf),
  };
  writeFileSync(leaf.receipt, JSON.stringify(receipt));
  validateFinalFileReceipt(leaf);
  const imported = composeNativeFinalCarriers({
    ...pgtap,
    operation: 'import',
    leaves: [leaf],
    outputs: { collection: path.join(root, 'imported.json') },
  });
  assert.equal(imported.completeNativeFamily, false);
  assert.deepEqual(imported.files, read(pgtapCollectionFile).files);
  assert.throws(
    () =>
      validateFinalFileReceipt({
        ...leaf,
        expectedOrigin: { ...leaf.expectedOrigin, commit: '3'.repeat(40) },
      }),
    /different source/u,
  );
  writeFileSync(leaf.receipt, JSON.stringify({ ...receipt, files: receipt.files.slice(1) }));
  assert.throws(() => validateFinalFileReceipt(leaf), /immutable receipt/u);
  writeFileSync(
    leaf.receipt,
    JSON.stringify({
      ...receipt,
      files: receipt.files.map((row, index) =>
        index === 0 ? { ...row, sha256: '0'.repeat(64) } : row,
      ),
    }),
  );
  assert.throws(() => validateFinalFileReceipt(leaf), /immutable receipt/u);
  const forged = read(contrib.leaves[0].frozen);
  forged.extensions[0].dependencies = ['foreign_extension'];
  const forgedFile = path.join(root, 'extension-artifacts.json');
  writeFileSync(forgedFile, JSON.stringify(forged));
  const forgedRelease = read(contrib.leaves[0].manifest);
  forgedRelease.extensions[0].dependencies = ['foreign_extension'];
  const forgedManifest = path.join(root, 'forged-public-manifest.json');
  writeJson(forgedManifest, forgedRelease);
  assert.throws(
    () =>
      validateNativeFinalLeaf(
        contrib,
        { ...contrib.leaves[0], frozen: forgedFile, manifest: forgedManifest },
        path.join(root, 'forged'),
      ),
    /canonical source contract/u,
  );
  console.log(
    'Actual Linux pgtap, PostGIS, and all32 contrib final-file joins PASS; mixed-target inventory metadata fixtures preserve every Linux package byte; immutable source/run fixtures tested; six native targets remain absent; external WASIX owner join remains absent.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
