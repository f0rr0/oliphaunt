/** Join final extension files without invoking or replacing their producers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeExtensionReleaseDocuments,
  nativeAssetNameForRow,
  writeReleaseControls,
} from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { validateExtensionArtifactArchive } from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import {
  expectedExtensionRoles,
  projectNativeRuntimeAssetMember,
} from '../../src/extensions/artifacts/packages/tools/extension-runtime-asset-contract.mts';
import { packageExtensionCargoFacades } from '../../src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts';
import {
  frozenExtensionMemberInventory,
  stageExtensionNativeNpmFacade,
} from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import {
  extensionCarrierLegalContract,
  nativeExtensionConstructionLicenseInventory,
  PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import {
  resolveNativeComponentClosure,
  validateNativeComponentContract,
} from '../../src/extensions/tools/native-component-contract.mts';
import {
  buildIosCarrierManifest,
  buildSwiftExtensionCarrierManifest,
} from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { inspectPlatformBinaryEntries } from '../../tools/packaging/platform-binary-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
} from '../../tools/packaging/release-notices.mts';
import {
  type NativeCarrierSpec,
  stageNativeRegistryCarriers,
  writeJson,
} from './native_carriers.mts';
import { validateNativeMemberModule } from './validate_member_payload.mts';

export interface FinalLeaf {
  product: string;
  owner: string;
  version: string;
  family: 'native';
  target: string;
  github: string[];
  npm: string[];
  cargo: string[];
  manifest: string;
  frozen: string;
  receipt?: string;
  expectedOrigin?: Record<string, unknown>;
  validation?: string;
}
export interface NativeOwnerSpec {
  schema: string;
  product: string;
  owner: string;
  version: string;
  runtimeVersion: string;
  releaseMetadata: Record<string, any>;
  members: NativeCarrierSpec[];
  profiles: any[];
  allProfiles: any[];
  catalogSqlNames: string[];
  carriers: any[];
  ownerFamilies: string[];
  cargoFacadeMetadata: any;
  components: string;
  leaves: FinalLeaf[];
  operation: 'import' | 'collect' | 'compose';
  baseCarrierManifest?: string;
  outputs: Record<string, string>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const role = (asset: any) =>
  `${asset.family}:${asset.target}:${asset.kind}:${asset.identity ?? ''}`;
const relative = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join('/');
const sorted = (values: string[] = []) => [...values].sort();

function filesAt(input: string): string[] {
  const file = realpathSync(input);
  if (statSync(file).isFile()) return [file];
  assert(statSync(file).isDirectory(), 'final file input must be a regular file or declared tree');
  return readdirSync(file, { withFileTypes: true })
    .flatMap((entry) => {
      // Declared tree inputs use Bazel's file symlink forest. Follow regular
      // file aliases only; archive member safety is checked independently.
      assert(
        entry.isFile() ||
          entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(path.join(file, entry.name)).isFile()),
        'final carrier tree aliases must resolve to regular files',
      );
      return filesAt(path.join(file, entry.name));
    })
    .sort();
}

/** Transport binds only declared final files, not compiler outputs or ambient paths. */
export function finalFileInventory(leaf: FinalLeaf) {
  const inputs = [
    ...leaf.github.flatMap((file) => filesAt(file).map((name) => ['github', name])),
    ...leaf.npm.flatMap((file) => filesAt(file).map((name) => ['npm', name])),
    ...leaf.cargo.flatMap((file) => filesAt(file).map((name) => ['cargo', name])),
    ['control', realpathSync(leaf.manifest)],
    ['control', realpathSync(leaf.frozen)],
  ];
  const rows = inputs
    .map(([ecosystem, file]) => ({
      path: `${ecosystem}/${path.basename(file)}`,
      sha256: digest(readFileSync(file)),
      bytes: statSync(file).size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(
    new Set(rows.map((row) => row.path)).size,
    rows.length,
    'repeated final-file identity',
  );
  return rows;
}

export function validateFinalFileReceipt(leaf: FinalLeaf) {
  assert(
    leaf.receipt && leaf.expectedOrigin,
    'imported final files require an immutable source/run receipt',
  );
  const receipt = json(leaf.receipt);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'files',
    'owner',
    'product',
    'schema',
    'scope',
    'source',
    'target',
    'version',
  ]);
  assert.equal(receipt.schema, 'oliphaunt-extension-final-files-v1');
  assert.equal(receipt.scope, 'construction', 'final-file transport is construction evidence');
  for (const key of ['product', 'owner', 'version', 'target'])
    assert.equal(receipt[key], leaf[key as keyof FinalLeaf]);
  assert.deepEqual(
    receipt.source,
    leaf.expectedOrigin,
    'foreign final files belong to a different source or producing run',
  );
  assert.deepEqual(Object.keys(receipt.source).sort(), [
    'commit',
    'job',
    'runAttempt',
    'runId',
    'tree',
  ]);
  for (const key of ['commit', 'tree']) assert.match(receipt.source[key], /^[0-9a-f]{40}$/u);
  assert.match(receipt.source.runId, /^[1-9][0-9]*$/u);
  assert(Number.isSafeInteger(receipt.source.runAttempt) && receipt.source.runAttempt > 0);
  assert.match(receipt.source.job, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(
    receipt.files,
    finalFileInventory(leaf),
    'transported final bytes differ from their immutable receipt',
  );
}

function expectedMember(spec: NativeCarrierSpec, target: string) {
  const artifact = spec.recipe.artifacts ?? {};
  const startup = spec.descriptor.lifecycle['startup-config'] ?? [];
  return {
    sqlName: spec.sqlName,
    createsExtension: spec.descriptor.lifecycle['create-extension'],
    nativeModuleStem: spec.descriptor['native-module-file']?.replace(/\.[^.]+$/u, '') ?? null,
    dependencies: sorted(spec.selectedDependencies),
    dataFiles: sorted(spec.contrib ? spec.contrib['data-files'] : artifact.data_files).map(
      (file) => {
        assert(file.startsWith('share/postgresql/'));
        return file.slice('share/postgresql/'.length);
      },
    ),
    extensionSqlFileNames: sorted(artifact.extension_sql_file_names),
    extensionSqlFilePrefixes: sorted(artifact.extension_sql_file_prefixes),
    sharedPreloadLibraries: startup
      .flatMap((value: string) =>
        value.startsWith('shared_preload_libraries=')
          ? value.slice('shared_preload_libraries='.length).split(',')
          : [],
      )
      .sort(),
    nativeDependencyModules: sorted(
      target.startsWith('linux-') ? artifact.native_dependency_modules : [],
    ).map((file) => path.posix.basename(file)),
    nativeConstructionLicenseFiles:
      (spec.sqlName === 'vector' && target === 'linux-x64-gnu') ||
      (spec.contrib &&
        spec.sqlName === 'pgcrypto' &&
        PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS.includes(target))
        ? nativeExtensionConstructionLicenseInventory(spec.sqlName, target)
        : [],
  };
}

function declaredApple(spec: NativeOwnerSpec) {
  return {
    declaredProducts: {
      [spec.product]: {
        product: spec.product,
        releaseProduct: spec.owner,
        version: spec.version,
        sqlNames: spec.members.map((member) => member.sqlName).sort(),
        tag: `${spec.owner}-v${spec.version}`,
      },
    },
    baseTag: `liboliphaunt-native-v${spec.runtimeVersion}`,
  };
}

function componentContract(spec: NativeOwnerSpec) {
  return validateNativeComponentContract(Bun.TOML.parse(readFileSync(spec.components, 'utf8')), {
    checkSourcePaths: false,
    knownExtensions: new Set(spec.catalogSqlNames),
    targetProfiles: new Map(
      spec.allProfiles.map((row) => [row.target, `${row.family}\0${row.kind}`]),
    ),
  });
}

function mobileRuntimeContract(member: any, target: string, components: any) {
  const targets = target === 'ios-xcframework' ? ['ios-device', 'ios-simulator'] : [target];
  const closure = resolveNativeComponentClosure(components, {
    extension: member.sqlName,
    family: 'native',
    kind: 'native-static-registry',
    target,
  });
  const units = components.components.flatMap((component: any) => component.linkUnits);
  const dependencies = closure.linkUnits
    .flatMap((identity: string) => {
      const unit = units.find((item: any) => item.id === identity);
      const names = [
        ...new Set(unit.archiveCandidates.map((file: string) => path.posix.basename(file))),
      ];
      assert.equal(names.length, 1, 'canonical mobile link unit requires one archive basename');
      return targets.map(
        (cohort) =>
          `${cohort}:${identity}:mobile-static/${cohort}/dependencies/${identity}/${names[0]}`,
      );
    })
    .sort();
  const stem = member.nativeModuleStem;
  return {
    target,
    archives:
      stem === null
        ? []
        : targets
            .map(
              (cohort) =>
                `${cohort}:mobile-static/${cohort}/extensions/${stem}/liboliphaunt_extension_${stem}.a`,
            )
            .sort(),
    dependencies,
    symbolPrefix:
      stem === null ? '' : `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`,
    ...(target === 'ios-xcframework'
      ? {
          symbolAliases: (member.iosRegistration?.symbols ?? [])
            .filter((row: any) => row.name !== row.address)
            .map((row: any) => `${row.name}:${row.address}`)
            .sort(),
        }
      : {}),
  };
}

function assertAsset(asset: any, file: string) {
  assert.equal(path.basename(file), asset.name, 'final asset name differs from its manifest');
  assert.equal(
    digest(readFileSync(file)),
    asset.sha256,
    'final asset SHA differs from its manifest',
  );
  assert.equal(statSync(file).size, asset.bytes, 'final asset size differs from its manifest');
}

function copyAsset(asset: any, file: string, destination: string, root: string) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(file, destination);
  return {
    ...asset,
    path: relative(root, destination),
    source: asset.source ?? relative(root, destination),
  };
}

function compareFinalRegistryFiles(expected: string[], actual: string[], label: string) {
  const inventory = (files: string[]) =>
    files
      .flatMap(filesAt)
      .map((file) => ({
        name: path.basename(file),
        sha256: digest(readFileSync(file)),
        bytes: statSync(file).size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    inventory(actual),
    inventory(expected),
    `${label} final packages differ from the canonical writer applied to the verified public payload`,
  );
}

/** Validate one actual native target, including registry leaves and nested legal bytes. */
export function validateNativeFinalLeaf(spec: NativeOwnerSpec, leaf: FinalLeaf, root: string) {
  for (const [key, wanted] of [
    ['product', spec.product],
    ['owner', spec.owner],
    ['version', spec.version],
    ['family', 'native'],
  ])
    assert.equal(leaf[key as keyof FinalLeaf], wanted);
  const profile = spec.profiles.find((row) => row.target === leaf.target);
  assert(profile, 'final leaf target is absent from canonical native profiles');
  if (leaf.receipt) validateFinalFileReceipt(leaf);
  const frozen = json(leaf.frozen);
  const release = json(leaf.manifest);
  const bundle = spec.members.length > 1;
  assert.equal(frozen.schema, `oliphaunt-extension-ci-artifacts-v${bundle ? 2 : 1}`);
  assert.equal(release.schema, `oliphaunt-extension-release-manifest-v${bundle ? 2 : 1}`);
  for (const document of [frozen, release]) {
    assert.equal(document.product, spec.product);
    assert.equal(document.version, spec.version);
    assert.equal(document.releaseProduct ?? document.product, spec.owner);
    assert.deepEqual(document.compatibility, spec.releaseMetadata.compatibility);
  }
  assert.deepEqual(
    release.sourceIdentity,
    spec.releaseMetadata.sourceIdentity,
    'final leaf source identity differs from canonical immutable acquisition',
  );
  assert.equal(release.extensionClass, spec.releaseMetadata.class);
  assert.equal(release.versioning, spec.releaseMetadata.versioning);
  const members = bundle ? frozen.extensions : [frozen];
  assert.deepEqual(
    members.map((member: any) => member.sqlName).sort(),
    spec.members.map((member) => member.sqlName).sort(),
    'final leaf member set differs from canonical distribution',
  );
  const physical = new Map(leaf.github.flatMap(filesAt).map((file) => [path.basename(file), file]));
  assert.equal(physical.size, leaf.github.flatMap(filesAt).length);
  const directAssets = bundle ? frozen.carrierAssets : members[0].assets;
  assert.equal(frozen.family ?? 'native', 'native');
  const declaredRelease = composeExtensionReleaseDocuments({
    product: spec.product,
    releaseProduct: spec.owner,
    family: frozen.family ?? null,
    version: spec.version,
    members,
    directAssets,
    releaseMetadata: spec.releaseMetadata,
  }).releaseData;
  assert.deepEqual(
    release,
    JSON.parse(JSON.stringify(declaredRelease)),
    'transported public manifest differs from its frozen member/assets contract',
  );
  assert.equal(new Set(directAssets.map((asset: any) => asset.name)).size, directAssets.length);
  assert.deepEqual(
    [...physical.keys()].sort(),
    directAssets.map((asset: any) => asset.name).sort(),
    'declared GitHub files must cover the frozen assets exactly',
  );
  const productRoot = path.join(root, 'product');
  mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
  const direct = directAssets.map((asset: any) => {
    assert.equal(asset.family, 'native');
    assert.equal(asset.target, leaf.target);
    const file = physical.get(asset.name)!;
    assertAsset(asset, file);
    if (bundle) {
      assert.equal(asset.kind, 'extension-bundle');
      assert.equal(
        asset.name,
        `${spec.product}-${spec.version}-native-${leaf.target}-bundle.tar.gz`,
      );
    }
    return copyAsset(asset, file, path.join(productRoot, 'release-assets', asset.name), root);
  });
  const nested = new Map<string, string>();
  if (bundle) {
    assert.equal(direct.length, 1, 'one target cohort requires one closed final contrib bundle');
    const outer = readPortableArchiveEntries(physical.get(direct[0].name)!);
    const prefix = path.basename(direct[0].name, '.tar.gz');
    const index = JSON.parse(outer.get(`${prefix}/bundle-manifest.json`)!.data().toString('utf8'));
    assert.equal(index.schema, 'oliphaunt-extension-bundle-v1');
    for (const [key, wanted] of [
      ['product', spec.product],
      ['version', spec.version],
      ['family', 'native'],
      ['target', leaf.target],
    ])
      assert.equal(index[key], wanted);
    assert.deepEqual(index.compatibility, spec.releaseMetadata.compatibility);
    const legal = extensionCarrierLegalContract(
      spec.product,
      spec.members.map((member) => member.sqlName),
      {
        family: 'native',
        target: leaf.target,
        memberContracts: members.map((member: any) => {
          const asset = member.assets.find(
            (row: any) =>
              row.family === 'native' && row.kind === 'runtime' && row.target === leaf.target,
          );
          return projectNativeRuntimeAssetMember(member, asset);
        }),
      },
    );
    assert.equal(index.licenseProfile, legal.profile);
    assert.deepEqual(index.licenseFiles, legal.licenseFiles);
    assert.equal(
      index.members.length,
      members.reduce((count: number, member: any) => count + member.assets.length, 0),
    );
    assertReleaseNoticesInArchive(physical.get(direct[0].name)!, {
      prefix,
      profile: index.licenseProfile,
    });
    assert.deepEqual(
      [...outer.keys()].sort(),
      [
        `${prefix}/bundle-manifest.json`,
        ...index.members.map((member: any) => `${prefix}/${member.path}`),
        ...releaseNoticeRows({ profile: index.licenseProfile }).map(
          (row) => `${prefix}/${row.member}`,
        ),
      ].sort(),
      'contrib outer archive contains undeclared files',
    );
    for (const member of members)
      for (const asset of member.assets) {
        const row = index.members.find(
          (item: any) =>
            item.sqlName === member.sqlName &&
            item.kind === asset.kind &&
            item.identity === asset.identity,
        );
        assert(row, 'nested frozen asset is missing from its closed bundle');
        assert.equal(asset.carrierAsset, direct[0].name);
        assert.equal(asset.carrierRoot, prefix);
        assert.equal(asset.memberPath, row.path);
        assert.equal(asset.sha256, row.sha256);
        assert.equal(asset.bytes, row.bytes);
        assert.equal(row.path, `extensions/${member.sqlName}/${asset.name}`);
        const bytes = outer.get(`${prefix}/${row.path}`)!.data();
        assert.equal(digest(bytes), row.sha256);
        assert.equal(bytes.length, row.bytes);
        const destination = path.join(productRoot, 'member-assets', member.sqlName, asset.name);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        nested.set(`${member.sqlName}\0${role(asset)}`, destination);
      }
  }
  const components = componentContract(spec);
  const staged = members.map((member: any) => {
    const canonical = spec.members.find((item) => item.sqlName === member.sqlName)!;
    const expected = expectedMember(canonical, leaf.target);
    const runtimeAsset = member.assets.find(
      (asset: any) =>
        asset.family === 'native' && asset.kind === 'runtime' && asset.target === leaf.target,
    );
    assert(runtimeAsset, 'final leaf requires its actual native runtime asset');
    const selectedMember = projectNativeRuntimeAssetMember(member, runtimeAsset);
    for (const [key, wanted] of Object.entries(expected)) {
      assert.deepEqual(
        selectedMember[key] ?? (Array.isArray(wanted) ? [] : wanted),
        wanted,
        `${member.sqlName}.${key} differs from canonical source contract`,
      );
    }
    const iosNativeDependencies = member.iosNativeDependencies ?? [];
    const iosRegistration = member.iosRegistration ?? null;
    const ios = leaf.target === 'ios-xcframework';
    const dependencyIds = ios
      ? resolveNativeComponentClosure(components, {
          extension: member.sqlName,
          family: 'native',
          kind: 'native-static-registry',
          target: leaf.target,
        }).linkUnits.sort()
      : [];
    assert.deepEqual(
      iosNativeDependencies,
      dependencyIds,
      'iOS dependency identities differ from the canonical component closure',
    );
    if (!ios || expected.nativeModuleStem === null) assert.equal(iosRegistration, null);
    else assert(iosRegistration, 'compiled iOS member requires build-derived registration');
    const normalized = { ...expected, iosNativeDependencies, iosRegistration, wasixInstall: null };
    if (normalized.nativeDependencyModules.length === 0) delete normalized.nativeDependencyModules;
    if (normalized.nativeConstructionLicenseFiles.length === 0)
      delete normalized.nativeConstructionLicenseFiles;
    const actualRoles = member.assets.map(role).sort();
    assert.equal(new Set(actualRoles).size, actualRoles.length, 'repeated final member role');
    assert.deepEqual(
      actualRoles,
      expectedExtensionRoles(normalized, [leaf.target]),
      'final member roles differ from canonical profiles and component closure',
    );
    const assets = member.assets.map((asset: any) => {
      if (
        ['nativeDependencyModules', 'nativeConstructionLicenseFiles'].some((field) =>
          Object.hasOwn(asset, field),
        )
      )
        frozenExtensionMemberInventory(member, {
          product: spec.product,
          version: spec.version,
          target: asset.target,
          asset,
        });
      const file = bundle
        ? nested.get(`${member.sqlName}\0${role(asset)}`)!
        : physical.get(asset.name)!;
      assert.equal(
        asset.name,
        nativeAssetNameForRow(spec.product, spec.version, { ...asset, asset: file }),
      );
      assertAsset(asset, file);
      if (asset.kind === 'runtime') {
        const mobileContract =
          profile.kind === 'native-static-registry'
            ? mobileRuntimeContract(normalized, leaf.target, components)
            : undefined;
        const runtime = validateExtensionArtifactArchive({
          file,
          metadata: normalized,
          product: spec.product,
          target: leaf.target,
          nativeRuntimeVersion: spec.runtimeVersion,
          mobileContract,
        });
        const hostTarget =
          mobileContract === undefined
            ? leaf.target
            : leaf.target === 'ios-xcframework'
              ? 'macos-arm64'
              : 'linux-x64-gnu';
        for (const [name, entry] of runtime.entries) {
          if (name.startsWith('files/lib/'))
            validateNativeMemberModule(entry.data, hostTarget, name.slice('files/'.length));
        }
        for (const row of [
          ...(mobileContract?.archives ?? []),
          ...(mobileContract?.dependencies ?? []),
        ]) {
          const cohort = row.slice(0, row.indexOf(':'));
          const name = row.slice(row.lastIndexOf(':') + 1);
          const entry = runtime.entries.get(name)!;
          const apple = cohort === 'ios-device' || cohort === 'ios-simulator';
          inspectPlatformBinaryEntries([{ name, data: entry.data, isFile: true }], {
            target: apple ? 'ios-xcframework' : cohort,
            rootLabel: asset.name,
            ...(apple
              ? { requiredApplePlatforms: [cohort === 'ios-device' ? 'ios' : 'ios-simulator'] }
              : {}),
          });
        }
      } else {
        inspectPlatformBinaryEntries(
          [...readPortableArchiveEntries(file)].map(([name, entry]) => ({ ...entry, name })),
          {
            target: 'ios-xcframework',
            rootLabel: asset.name,
            requiredApplePlatforms: ['macos', 'ios', 'ios-simulator'],
          },
        );
      }
      return {
        ...asset,
        path: relative(root, bundle ? file : path.join(productRoot, 'release-assets', asset.name)),
      };
    });
    return { ...normalized, assets };
  });
  const documents = composeExtensionReleaseDocuments({
    product: spec.product,
    releaseProduct: spec.owner,
    family: 'native',
    version: spec.version,
    members: staged,
    directAssets: direct,
    releaseMetadata: spec.releaseMetadata,
  });
  writeJson(path.join(productRoot, 'extension-artifacts.json'), documents.manifest);
  writeJson(
    path.join(productRoot, 'release-assets', `${spec.product}-${spec.version}-manifest.json`),
    documents.releaseData,
  );
  if (leaf.target === 'ios-xcframework')
    buildSwiftExtensionCarrierManifest({
      extensionManifest: path.join(productRoot, 'extension-artifacts.json'),
      assetRoot: root,
      nativeRuntimeVersion: spec.runtimeVersion,
      ...declaredApple(spec),
    });
  if (profile.kind === 'native-dynamic') {
    const canonical = spec.members[0];
    const facades = spec.carriers.filter(
      (row) => row.ecosystem === 'npm' && row.target === null && row.role === 'facade',
    );
    assert.equal(facades.length, 1, 'native registry cohort requires its canonical npm facade');
    const npm = spec.carriers.filter(
      (row) =>
        row.ecosystem === 'npm' &&
        row.target === leaf.target &&
        row.name === `${facades[0].name}-${leaf.target}`,
    );
    const cargo = spec.carriers.filter(
      (row) =>
        row.ecosystem === 'cargo' &&
        row.target === leaf.target &&
        row.name === `${spec.product}-${leaf.target}`,
    );
    assert.equal(npm.length, 1);
    assert.equal(cargo.length, 1);
    const outputs = {
      github: physical.get(direct[0].name)!,
      npm: path.join(
        root,
        'registry',
        npm[0].name.replace('@', '').replace('/', '-') + '-' + spec.version + '.tgz',
      ),
      cargo: path.join(root, 'registry', 'cargo'),
      manifest: '',
      frozen: '',
    };
    mkdirSync(path.dirname(outputs.npm), { recursive: true });
    const registrySpec = {
      ...canonical,
      product: spec.product,
      owner: spec.owner,
      target: leaf.target,
      version: spec.version,
      runtimeVersion: spec.runtimeVersion,
      carriers: spec.carriers,
      outputs,
    };
    stageNativeRegistryCarriers(registrySpec, productRoot, root);
    compareFinalRegistryFiles([outputs.npm], leaf.npm, 'npm');
    compareFinalRegistryFiles([outputs.cargo], leaf.cargo, 'Cargo');
  } else {
    assert.equal(leaf.npm.length, 0, 'mobile cohort has no native npm target leaf');
    assert.equal(leaf.cargo.length, 0, 'mobile cohort has no native Cargo target leaf');
  }
  return {
    leaf,
    members: staged,
    directAssets: direct,
    inventory: finalFileInventory(leaf),
    productRoot,
  };
}

export function nativeFamilyCompleteness(spec: NativeOwnerSpec, targets: string[]) {
  assert.equal(new Set(targets).size, targets.length, 'repeated final target cohort');
  const wanted = spec.profiles.map((row) => row.target).sort();
  assert(
    targets.every((target) => wanted.includes(target)),
    'undeclared native final target',
  );
  const missingNativeTargets = wanted.filter((target) => !targets.includes(target));
  return {
    completeNativeFamily: missingNativeTargets.length === 0,
    missingNativeTargets,
    completeExtensionDistribution:
      missingNativeTargets.length === 0 && spec.ownerFamilies.length === 1,
    missingOwnerFamilies: spec.ownerFamilies.filter((family) => family !== 'native'),
  };
}

/** Keep common SQL metadata once and bind construction facts to their payload. */
export function mergeNativeFinalMembers(spec: NativeOwnerSpec, cohorts: { members: any[] }[]) {
  return spec.members.map((canonical) => {
    const rows = cohorts.map((cohort) =>
      cohort.members.find((member: any) => member.sqlName === canonical.sqlName),
    );
    assert(rows.every(Boolean), 'final join is missing a canonical SQL member');
    const ios = rows.find((member: any) =>
      member.assets.some((asset: any) => asset.target === 'ios-xcframework'),
    );
    const base = { ...(ios ?? rows[0]) };
    delete base.nativeConstructionLicenseFiles;
    delete base.nativeDependencyModules;
    const assets = rows.flatMap((member: any) =>
      member.assets.map((asset: any) => {
        if (asset.family !== 'native' || asset.kind !== 'runtime') return asset;
        const inventory = frozenExtensionMemberInventory(member, {
          product: spec.product,
          version: spec.version,
          target: asset.target,
          asset,
        });
        const result = { ...asset };
        for (const field of ['nativeDependencyModules', 'nativeConstructionLicenseFiles']) {
          if (inventory[field] !== undefined) result[field] = inventory[field];
        }
        return result;
      }),
    );
    return { ...base, assets };
  });
}

export function composeNativeFinalCarriers(spec: NativeOwnerSpec) {
  assert.equal(spec.schema, 'oliphaunt-native-extension-final-join-inputs-v1');
  assert(spec.leaves.length > 0, 'final join requires actual declared final files');
  const completeness = nativeFamilyCompleteness(
    spec,
    spec.leaves.map((leaf) => leaf.target),
  );
  if (spec.operation === 'compose')
    assert(
      completeness.completeNativeFamily,
      `missing native final targets: ${completeness.missingNativeTargets.join(', ')}`,
    );
  const root = mkdtempSync(path.join(tmpdir(), 'native-extension-final-join-'));
  try {
    const validated = spec.leaves.map((leaf, index) =>
      validateNativeFinalLeaf(spec, leaf, path.join(root, String(index))),
    );
    const collection = {
      schema: 'oliphaunt-native-extension-final-collection-v1',
      scope: 'construction',
      product: spec.product,
      releaseProduct: spec.owner,
      version: spec.version,
      ...completeness,
      targets: spec.leaves.map((leaf) => leaf.target).sort(),
      members: spec.members.map((member) => member.sqlName).sort(),
      compatibility: spec.releaseMetadata.compatibility,
      sourceIdentity: spec.releaseMetadata.sourceIdentity,
      imports: spec.leaves
        .filter((leaf) => leaf.receipt)
        .map((leaf) => ({ target: leaf.target, source: leaf.expectedOrigin })),
      files: validated.flatMap(({ leaf, inventory }) =>
        inventory.map((row) => ({ target: leaf.target, ...row })),
      ),
    };
    if (spec.operation === 'compose') {
      assert(
        spec.baseCarrierManifest,
        'complete native npm facade requires actual frozen base Apple carriers',
      );
      const productRoot = path.resolve(spec.outputs.github);
      const outputRoot = path.dirname(productRoot);
      mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
      const directAssets = validated.flatMap((cohort) =>
        cohort.directAssets.map((asset) =>
          copyAsset(
            asset,
            path.join(path.dirname(cohort.productRoot), asset.path),
            path.join(productRoot, 'release-assets', asset.name),
            outputRoot,
          ),
        ),
      );
      const members = mergeNativeFinalMembers(spec, validated).map((member) => ({
        ...member,
        assets: member.assets.map((asset: any) => {
          if (spec.members.length === 1)
            return { ...asset, ...directAssets.find((item) => role(item) === role(asset)) };
          const cohort = validated.find((item) => item.leaf.target === asset.target)!;
          const file = path.join(path.dirname(cohort.productRoot), asset.path);
          return copyAsset(
            asset,
            file,
            path.join(productRoot, 'member-assets', member.sqlName, asset.name),
            outputRoot,
          );
        }),
      }));
      const documents = composeExtensionReleaseDocuments({
        product: spec.product,
        releaseProduct: spec.owner,
        family: 'native',
        version: spec.version,
        members,
        directAssets,
        releaseMetadata: spec.releaseMetadata,
      });
      const controls = writeReleaseControls({
        product: spec.product,
        releaseProduct: spec.owner,
        family: 'native',
        version: spec.version,
        productRoot,
        root: outputRoot,
        ...documents,
        releaseMetadata: spec.releaseMetadata,
        directAssets,
        swiftOptions: { ...declaredApple(spec), assetRoot: outputRoot },
      });
      const iosCarrier = buildIosCarrierManifest({
        assetRoot: outputRoot,
        baseCarrierManifest: spec.baseCarrierManifest,
        baseRuntimeVersion: spec.runtimeVersion,
        extensionManifests: [path.join(productRoot, 'extension-artifacts.json')],
        ...declaredApple(spec),
      });
      const result = { staged: [], skipped: [] };
      const facade = stageExtensionNativeNpmFacade(
        path.join(root, 'npm-source'),
        spec.outputs.npm,
        {
          product: spec.product,
          version: spec.version,
          members: members.map((member) => member.sqlName),
          targets: spec.profiles
            .filter((profile) => profile.kind === 'native-dynamic')
            .map((profile) => profile.target)
            .sort(),
          iosCarrier,
          liboliphauntVersion: spec.runtimeVersion,
          runtimeBound: spec.releaseMetadata.versioning === 'runtime-bound',
        },
        result,
      );
      assert(facade, 'canonical npm facade exceeded the shipping size cap');
      if (spec.outputs.cargo) {
        assert(
          completeness.completeExtensionDistribution,
          'external Cargo facade also requires the genuine WASIX final leaves',
        );
        packageExtensionCargoFacades([spec.product], spec.outputs.cargo, {
          metadataByProduct: { [spec.product]: spec.cargoFacadeMetadata },
        });
      }
      collection['controls'] = Object.fromEntries(
        Object.entries(controls)
          .filter(([, file]) => file !== null)
          .map(([kind, file]) => [kind, path.basename(file as string)]),
      );
    }
    writeJson(spec.outputs.collection, collection);
    return collection;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: owner_carriers.mts <declared-final-inputs.json>');
  composeNativeFinalCarriers(json(process.argv[2]));
}
