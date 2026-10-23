/** Public mobile member envelopes from declared host and target producers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeExtensionReleaseDocuments,
  nativeAssetNameForRow,
} from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { bundleCarrierAssets } from '../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import {
  EXTENSION_ARTIFACT_PROPERTY_KEYS,
  nativeModuleHostTarget,
  validateExtensionArtifactArchive,
} from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import {
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import {
  resolveNativeComponentClosure,
  validateNativeComponentContract,
} from '../../src/extensions/tools/native-component-contract.mts';
import { validateAppleXcframeworkAsset } from '../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import { inspectPlatformBinaryEntries } from '../../tools/packaging/platform-binary-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import {
  deriveStaticRegistration,
  type StaticRegistration,
  staticSymbolPrefix,
} from './mobile_registration.mts';
import {
  exactArchive,
  frozenNativeMember,
  type NativeCarrierSpec,
  nativeCarrierCompatibility,
  validateNativeShippingModule,
  writeJson,
} from './native_carriers.mts';
import { inspect, inspectStaticArchiveBytes } from './validate_member_payload.mts';

export interface MobileStaticArchive {
  target: string;
  archive: string;
  registration: string;
  nm: { path: string; apple: boolean };
  aliases?: Record<string, string>;
  sqlName: string;
  owner: string;
  version: string;
  runtimeVersion: string;
  source: Record<string, unknown>;
}
export interface MobileDependencyArchive {
  target: string;
  identity: string;
  archive: string;
  source: Record<string, unknown>;
}
export interface MobileCarrierSpec extends Omit<NativeCarrierSpec, 'archive' | 'outputs'> {
  hostArchive: string;
  components: string;
  catalogSqlNames: string[];
  allProfiles: { target: string; family: string; kind: string }[];
  staticArchives: MobileStaticArchive[];
  dependencyArchives: MobileDependencyArchive[];
  dependencySources: Record<string, Record<string, unknown>>;
  frameworks?: {
    kind: 'ios-xcframework' | 'ios-dependency-xcframework';
    identity: string;
    file: string;
    bundleName: string;
  }[];
}

const mobileTargets = new Set(['ios-xcframework', 'android-arm64-v8a', 'android-x86_64']);
const sorted = (values: string[]) => [...values].sort();
const runtimeCohorts = (target: string) =>
  target === 'ios-xcframework' ? ['ios-device', 'ios-simulator'] : [target];
const staticCohorts = (target: string) =>
  target === 'ios-xcframework' ? ['macos-arm64', ...runtimeCohorts(target)] : [target];

/** Resolve paths from the canonical graph, never from an independently authored recipe. */
export function mobileArchivePlan(spec: MobileCarrierSpec, components: any) {
  assert(mobileTargets.has(spec.target), 'mobile member requires a canonical static target');
  const moduleFile = spec.descriptor['native-module-file'];
  assert(
    moduleFile === undefined || (typeof moduleFile === 'string' && moduleFile.endsWith('.so')),
    'canonical mobile module must declare its .so stem',
  );
  const stem = moduleFile === undefined ? null : moduleFile.slice(0, -3);
  assert(stem === null || /^[a-z_][a-z0-9_-]*$/u.test(stem), 'mobile module stem must be portable');
  const closure = resolveNativeComponentClosure(components, {
    extension: spec.sqlName,
    family: 'native',
    kind: 'native-static-registry',
    target: spec.target,
  });
  const cohorts = stem === null ? [] : staticCohorts(spec.target);
  assert.deepEqual(
    sorted(spec.staticArchives.map((row) => row.target)),
    sorted(cohorts),
    'static member must cover its exact target cohorts once',
  );
  const files: { source: string; destination: string; target: string }[] = [];
  for (const row of spec.staticArchives) {
    for (const [key, wanted] of Object.entries({
      sqlName: spec.sqlName,
      owner: spec.owner ?? spec.product,
      version: spec.version,
      runtimeVersion: spec.runtimeVersion,
      source: spec.source,
    }))
      assert.deepEqual(
        row[key as keyof MobileStaticArchive],
        wanted,
        `static producer ${key} differs from canonical member`,
      );
    assert.equal(
      row.nm.apple,
      spec.target === 'ios-xcframework',
      'nm convention differs from target',
    );
    if (runtimeCohorts(spec.target).includes(row.target))
      files.push({
        source: row.archive,
        destination: `mobile-static/${row.target}/extensions/${stem}/liboliphaunt_extension_${stem}.a`,
        target: row.target,
      });
  }
  const expectedDependencies = cohorts.flatMap((target) =>
    closure.linkUnits.map((identity: string) => `${target}:${identity}`),
  );
  assert.deepEqual(
    sorted(spec.dependencyArchives.map((row) => `${row.target}:${row.identity}`)),
    sorted(expectedDependencies),
    'dependency archives differ from the exact target component closure',
  );
  for (const row of spec.dependencyArchives) {
    const component = components.components.find((item: any) =>
      item.linkUnits.some((unit: any) => unit.id === row.identity),
    );
    assert(component, 'static dependency must have a canonical component owner');
    const source =
      component.sourcePath === null
        ? spec.dependencySources[component.source]
        : { path: component.sourcePath };
    assert(source, `component ${component.id} requires its canonical source identity`);
    assert.deepEqual(
      row.source,
      source,
      'static dependency source differs from canonical acquisition',
    );
    const unit = component.linkUnits.find((item: any) => item.id === row.identity);
    const basenames = [
      ...new Set(unit.archiveCandidates.map((name: string) => path.posix.basename(name))),
    ];
    assert.equal(
      basenames.length,
      1,
      'component link unit requires one canonical archive basename',
    );
    if (runtimeCohorts(spec.target).includes(row.target))
      files.push({
        source: row.archive,
        destination: `mobile-static/${row.target}/dependencies/${row.identity}/${basenames[0]}`,
        target: row.target,
      });
  }
  files.sort((a, b) =>
    a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
  );
  return {
    stem,
    closure,
    files,
    mobileContract: {
      target: spec.target,
      archives: files
        .filter((row) => row.destination.includes('/extensions/'))
        .map((row) => `${row.target}:${row.destination}`)
        .sort(),
      dependencies: files
        .filter((row) => row.destination.includes('/dependencies/'))
        .map((row) => `${row.target}:${row.destination.split('/')[3]}:${row.destination}`)
        .sort(),
      symbolPrefix: stem === null ? '' : staticSymbolPrefix(stem),
    },
  };
}

function actualRegistration(row: MobileStaticArchive, stem: string, work: string) {
  inspectStaticArchiveBytes(readFileSync(realpathSync(row.archive)), row.target, row.archive);
  const receipt = JSON.parse(
    readFileSync(realpathSync(row.registration), 'utf8'),
  ) as StaticRegistration;
  assert(
    Array.isArray(receipt.symbols),
    'static producer requires a registration symbol inventory',
  );
  const result = Bun.spawnSync(
    [
      realpathSync(row.nm.path),
      ...(row.nm.apple ? ['-g', '-U', '-m'] : ['-g', '--defined-only']),
      realpathSync(row.archive),
    ],
    { cwd: work, env: { LC_ALL: 'C', LANG: 'C' }, stdout: 'pipe', stderr: 'pipe' },
  );
  assert.equal(result.exitCode, 0, `declared nm failed: ${result.stderr.toString('utf8')}`);
  const registration = deriveStaticRegistration(
    row.sqlName,
    stem,
    result.stdout.toString('utf8'),
    row.nm.apple,
    Object.entries(row.aliases ?? {}).map(([name, address]) => ({ name, address })),
  );
  assert.deepEqual(receipt, registration, 'registration differs from actual archive definitions');
  return registration;
}

/** Final binary and inventory readers inspect the bytes written by the shared archive writer. */
export function assemblePublicMobileMember(spec: MobileCarrierSpec, output: string) {
  const components = validateNativeComponentContract(
    Bun.TOML.parse(readFileSync(spec.components, 'utf8')),
    {
      checkSourcePaths: false,
      knownExtensions: new Set(spec.catalogSqlNames),
      targetProfiles: new Map(
        spec.allProfiles.map((row) => [row.target, `${row.family}\0${row.kind}`]),
      ),
    },
  );
  const plan = mobileArchivePlan(spec, components);
  const hostTarget = nativeModuleHostTarget(spec.target);
  const actual = inspect(spec.hostArchive, spec.sqlName, spec.owner ?? spec.product);
  const metadata = frozenNativeMember(
    { ...spec, archive: spec.hostArchive, target: hostTarget } as NativeCarrierSpec,
    actual,
  );
  assert.equal(metadata.nativeModuleStem, plan.stem);
  assert(
    plan.closure.runtimeFiles.every((file: string) => metadata.dataFiles.includes(file)),
    'component runtime data is missing from the canonical host member',
  );
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-extension-member-'));
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  try {
    const registrations = spec.staticArchives.map((row) => {
      assert(plan.stem !== null, 'compiled static member requires its canonical stem');
      return actualRegistration(row, plan.stem, root);
    });
    for (const registration of registrations)
      assert.deepEqual(
        registration,
        registrations[0],
        'target slice registration metadata differs',
      );
    for (const row of spec.dependencyArchives)
      inspectStaticArchiveBytes(readFileSync(realpathSync(row.archive)), row.target, row.archive);
    const iosRegistration = spec.target === 'ios-xcframework' ? (registrations[0] ?? null) : null;
    const aliases =
      registrations[0]?.symbols
        .filter((row) => row.name !== row.address)
        .map((row) => `${row.name}:${row.address}`)
        .sort() ?? [];
    const mobileContract = { ...plan.mobileContract, symbolAliases: aliases };
    const publicRoot = path.join(root, 'public');
    mkdirSync(publicRoot);
    for (const [name, entry] of readPortableArchiveEntries(realpathSync(spec.hostArchive))) {
      if (name === 'extension.json' || name.startsWith('lib/modules/')) continue;
      const destination = path.join(publicRoot, 'files', name);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, entry.data(), { mode: name.startsWith('lib/') ? 0o755 : 0o644 });
      if (name.startsWith('lib/')) validateNativeShippingModule(entry.data(), hostTarget, name);
    }
    for (const row of plan.files) {
      const destination = path.join(publicRoot, row.destination);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(realpathSync(row.source)), { mode: 0o644 });
    }
    stageExtensionUpstreamLicenses(spec.sqlName, path.join(publicRoot, 'files'));
    const legal = extensionCarrierLegalContract(spec.product, [spec.sqlName], {
      family: 'native',
      target: spec.target,
      memberContracts: [metadata],
    });
    stageReleaseNotices(publicRoot, { profile: legal.profile });
    const compatibility = nativeCarrierCompatibility(spec as NativeCarrierSpec);
    const properties: Record<string, string> = {
      packageLayout: 'oliphaunt-extension-artifact-v1',
      pgMajor: '18',
      sqlName: spec.sqlName,
      createsExtension: metadata.createsExtension ? 'yes' : 'no',
      nativeModuleStem: metadata.nativeModuleStem ?? '',
      nativeModuleFile: String(actual.module_file),
      sqlMembers: metadata.sqlMembers.join(','),
      nativeModuleStems: metadata.nativeModuleStems.join(','),
      nativeTarget: spec.target,
      nativeRuntimeProduct: compatibility.nativeRuntimeProduct,
      nativeRuntimeVersion: compatibility.nativeRuntimeVersion,
      dependencies: metadata.dependencies.join(','),
      dataFiles: metadata.dataFiles.join(','),
      extensionSqlFileNames: metadata.extensionSqlFileNames.join(','),
      extensionSqlFilePrefixes: metadata.extensionSqlFilePrefixes.join(','),
      sharedPreloadLibraries: metadata.sharedPreloadLibraries.join(','),
      mobilePrebuilt: metadata.nativeModuleStem === null ? 'no' : 'yes',
      mobileStaticArchives: mobileContract.archives.join(','),
      mobileStaticDependencyArchives: mobileContract.dependencies.join(','),
      staticSymbolPrefix: mobileContract.symbolPrefix,
      staticSymbolAliases: aliases.join(','),
      licenseFiles: [
        ...legal.licenseFiles,
        ...(metadata.nativeConstructionLicenseFiles ?? []).map((row) => row.path),
      ]
        .sort()
        .join(','),
      licenseProfile: legal.profile,
      files: 'files',
    };
    writeFileSync(
      path.join(publicRoot, 'manifest.properties'),
      EXTENSION_ARTIFACT_PROPERTY_KEYS.map((key) => `${key}=${properties[key]}\n`).join(''),
    );
    exactArchive(publicRoot, output);
    const final = validateExtensionArtifactArchive({
      file: output,
      metadata,
      product: spec.product,
      target: spec.target,
      nativeRuntimeVersion: compatibility.nativeRuntimeVersion,
      mobileContract,
    });
    for (const row of plan.files) {
      const entry = final.entries.get(row.destination);
      assert(entry, 'written mobile archive is missing a declared static input');
      inspectStaticArchiveBytes(entry.data, row.target, row.destination);
    }
    const bytes = readFileSync(output);
    const name = nativeAssetNameForRow(spec.product, spec.version, {
      target: spec.target,
      kind: 'runtime',
      asset: output,
    });
    assert.equal(
      path.basename(output),
      name,
      'mobile runtime asset requires its canonical filename',
    );
    return {
      metadata: {
        ...metadata,
        iosRegistration,
        iosNativeDependencies:
          spec.target === 'ios-xcframework' ? sorted(plan.closure.linkUnits) : [],
        wasixInstall: null,
      },
      asset: {
        name,
        family: 'native',
        target: spec.target,
        kind: 'runtime',
        identity: null,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function packageMobileCarriers(spec: {
  product: string;
  owner: string;
  version: string;
  target: string;
  expectedMembers: string[];
  members: MobileCarrierSpec[];
  releaseMetadata: any;
  outputs: { github: string; manifest: string; frozen: string };
}) {
  assert.deepEqual(spec.members.map((row) => row.sqlName).sort(), spec.expectedMembers);
  assert.equal(new Set(spec.expectedMembers).size, spec.expectedMembers.length);
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-extension-envelopes-'));
  try {
    const productRoot = path.join(root, 'product');
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    mkdirSync(spec.outputs.github, { recursive: true });
    const members = [];
    for (const member of spec.members) {
      assert.equal(member.product, spec.product);
      assert.equal(member.owner ?? member.product, spec.owner);
      assert.equal(member.version, spec.version);
      assert.equal(member.target, spec.target);
      const directory = path.join(productRoot, 'member-assets', member.sqlName);
      mkdirSync(directory, { recursive: true });
      const name = nativeAssetNameForRow(spec.product, spec.version, {
        target: spec.target,
        kind: 'runtime',
        asset: 'runtime.tar.gz',
      });
      const archive = path.join(directory, name);
      const { metadata, asset } = assemblePublicMobileMember(member, archive);
      const assets = [{ ...asset, path: path.relative(root, archive).split(path.sep).join('/') }];
      const frameworks = member.frameworks ?? [];
      const required =
        spec.target === 'ios-xcframework' && metadata.nativeModuleStem !== null
          ? [
              `ios-xcframework:${metadata.nativeModuleStem}`,
              ...metadata.iosNativeDependencies.map(
                (identity: string) => `ios-dependency-xcframework:${identity}`,
              ),
            ].sort()
          : [];
      assert.deepEqual(
        frameworks.map((row) => `${row.kind}:${row.identity}`).sort(),
        required,
        'iOS final member requires each canonical framework role once',
      );
      for (const framework of frameworks) {
        const physicalFramework = realpathSync(framework.file);
        await validateAppleXcframeworkAsset(physicalFramework, framework.bundleName);
        inspectPlatformBinaryEntries(
          [...readPortableArchiveEntries(physicalFramework)].map(([entryName, entry]) => ({
            ...entry,
            name: entryName,
          })),
          {
            target: 'ios-xcframework',
            rootLabel: framework.file,
          },
        );
        const frameworkName = nativeAssetNameForRow(spec.product, spec.version, {
          ...framework,
          target: spec.target,
          asset: framework.file,
        });
        const output = path.join(directory, frameworkName);
        copyFileSync(physicalFramework, output);
        const bytes = readFileSync(output);
        assets.push({
          name: frameworkName,
          family: 'native',
          target: spec.target,
          kind: framework.kind,
          identity: framework.identity,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          path: path.relative(root, output).split(path.sep).join('/'),
        });
      }
      members.push({ ...metadata, assets });
    }
    const directAssets =
      spec.members.length > 1
        ? bundleCarrierAssets(
            spec.product,
            spec.version,
            productRoot,
            members,
            nativeCarrierCompatibility(spec.members[0] as NativeCarrierSpec),
            { root },
          )
        : members[0].assets;
    for (const asset of directAssets)
      copyFileSync(path.join(root, asset.path), path.join(spec.outputs.github, asset.name));
    const documents = composeExtensionReleaseDocuments({
      product: spec.product,
      releaseProduct: spec.owner,
      family: 'native',
      version: spec.version,
      members,
      directAssets,
      releaseMetadata: spec.releaseMetadata,
    });
    writeJson(spec.outputs.frozen, documents.manifest);
    writeJson(spec.outputs.manifest, documents.releaseData);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: mobile_carriers.mts <declared-inputs.json>');
  const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (inputs.operation === 'package') await packageMobileCarriers(inputs);
  else writeJson(inputs.inventory, assemblePublicMobileMember(inputs.spec, inputs.output));
}
