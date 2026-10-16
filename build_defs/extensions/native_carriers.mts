/** Adapt declared native member bytes to the existing exact extension envelopes. */
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXTENSION_ARTIFACT_PROPERTY_KEYS,
  moduleSuffix,
  nativeDependencyModuleBasenames,
  validateExtensionArtifactArchive,
} from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import {
  packageNativeExtensionCargoCrates,
  stageExtensionNativeNpmPackages,
} from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import {
  extensionCarrierLegalContract,
  nativeExtensionConstructionLicenseInventory,
  stageExtensionUpstreamLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { tarHeader } from '../../tools/packaging/archive-directory.mts';
import { inspectPlatformBinaryBuffer } from '../../tools/packaging/platform-binary-contract.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { inspect, validateNativeMemberModule } from './validate_member_payload.mts';

interface Carrier {
  product: string;
  ecosystem: string;
  name: string;
  version: string;
  target: string | null;
  role: string;
}
export interface NativeCarrierSpec {
  product: string;
  owner?: string;
  contrib?: Record<string, any>;
  version: string;
  sqlName: string;
  target: string;
  runtimeVersion: string;
  descriptor: Record<string, any>;
  recipe: Record<string, any>;
  source: Record<string, any>;
  selectedDependencies: string[];
  compatibility: Record<string, string>;
  carriers: Carrier[];
  releaseMetadata?: Record<string, any>;
  archive: string;
  outputs: { github: string; npm: string; cargo: string; manifest: string; frozen: string };
}

/** Apply the existing release platform policy before accepting a compiled member. */
export function validateNativeShippingModule(bytes: Buffer, target: string, modulePath: string) {
  const result = inspectPlatformBinaryBuffer(bytes, {
    target,
    label: 'native extension shipping module',
  });
  validateNativeMemberModule(bytes, target, modulePath);
  return result;
}

export function frozenNativeMember(spec: NativeCarrierSpec, actual: Record<string, any>) {
  assert.equal(
    actual.owner,
    spec.owner ?? spec.product,
    'member owner differs from its release product',
  );
  assert.equal(actual.version, spec.version, 'member version differs from its release product');
  assert.equal(actual.sql_name, spec.sqlName);
  assert.equal(actual.configuration, spec.target);
  assert.equal(
    spec.runtimeVersion,
    spec.compatibility.native_runtime_version,
    'public native host differs from the declared extension compatibility',
  );
  assert.equal(actual.source_kind, spec.descriptor['source-kind']);
  assert.deepEqual(
    spec.contrib ? actual.postgres_source : actual.source,
    spec.source,
    'member source pin differs from canonical acquisition',
  );
  assert.equal(
    actual.default_version,
    spec.contrib
      ? (spec.contrib['default-version'] ?? null)
      : spec.source['extension-control']['default-version'],
  );
  assert.equal(actual.creates_extension, spec.descriptor.lifecycle['create-extension']);
  const artifact = spec.recipe.artifacts ?? {};
  const canonical = (values: string[] = []) => [...values].sort();
  assert.deepEqual(canonical(actual.dependencies), canonical(spec.descriptor.dependencies));
  assert.deepEqual(
    canonical(actual.data_files),
    canonical(spec.contrib ? spec.contrib['data-files'] : artifact.data_files),
  );
  assert.deepEqual(canonical(actual.sql_files), canonical(artifact.extension_sql_file_names));
  assert.deepEqual(canonical(actual.sql_prefixes), canonical(artifact.extension_sql_file_prefixes));
  const canonicalModule = spec.descriptor['native-module-file'] ?? '';
  assert(
    !canonicalModule || canonicalModule.endsWith('.so'),
    'canonical native module must declare its .so stem',
  );
  const stem = canonicalModule ? canonicalModule.slice(0, -3) : null;
  assert.equal(actual.module_file, stem === null ? '' : stem + moduleSuffix(spec.target));
  const nativeDependencyModules = nativeDependencyModuleBasenames(
    artifact.native_dependency_modules,
    spec.target,
    artifact.native_dependency_modules_by_target,
  );
  assert.deepEqual(
    actual.dependency_modules,
    nativeDependencyModules,
    'native dependency modules differ from the canonical recipe',
  );
  const nativeConstructionLicenseFiles =
    (spec.sqlName === 'vector' && spec.target === 'linux-x64-gnu') ||
    (spec.contrib && spec.sqlName === 'pgcrypto')
      ? nativeExtensionConstructionLicenseInventory(spec.sqlName, spec.target)
      : [];
  assert.deepEqual(
    actual.construction_licenses ?? [],
    nativeConstructionLicenseFiles.map((row) => row.path),
    'construction notices differ from the immutable construction source',
  );
  const startup = spec.descriptor.lifecycle['startup-config'] ?? [];
  const sharedPreloadLibraries = startup
    .flatMap((value: string) =>
      value.startsWith('shared_preload_libraries=')
        ? value.slice('shared_preload_libraries='.length).split(',')
        : [],
    )
    .sort();
  return {
    sqlName: spec.sqlName,
    createsExtension: actual.creates_extension,
    nativeModuleStem: stem,
    dependencies: spec.selectedDependencies,
    dataFiles: canonical(actual.data_files).map((file) => {
      assert(
        file.startsWith('share/postgresql/'),
        'extension data must have its canonical share destination',
      );
      return file.slice('share/postgresql/'.length);
    }),
    extensionSqlFileNames: canonical(actual.sql_files),
    extensionSqlFilePrefixes: canonical(actual.sql_prefixes),
    sharedPreloadLibraries,
    ...(nativeDependencyModules.length === 0 ? {} : { nativeDependencyModules }),
    ...(nativeConstructionLicenseFiles.length === 0 ? {} : { nativeConstructionLicenseFiles }),
  };
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function exactArchive(directory: string, output: string) {
  const rows: { name: string; data: Buffer; mode: number }[] = [];
  const visit = (current: string, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(current, entry.name), name + '/');
      else {
        assert(entry.isFile(), 'exact extension archive requires regular files');
        rows.push({
          name,
          data: readFileSync(path.join(current, entry.name)),
          mode: name.startsWith('files/lib/') ? 0o755 : 0o644,
        });
      }
    }
  };
  visit(directory);
  const blocks = rows
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(({ name, data, mode }) => [
      tarHeader({ name, owner: 'root' }, data.length, mode),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    ]);
  blocks.push(Buffer.alloc(1024));
  writeFileSync(output, canonicalGzipSync(Buffer.concat(blocks)));
}

export function nativeCarrierCompatibility(spec: NativeCarrierSpec) {
  return {
    extensionRuntimeContract: spec.compatibility.extension_runtime_contract,
    nativeRuntimeProduct: spec.compatibility.native_runtime_product,
    nativeRuntimeVersion: spec.compatibility.native_runtime_version,
    postgresMajor: spec.compatibility.postgres_major,
    wasixRuntimeProduct: spec.compatibility.wasix_runtime_product,
    wasixRuntimeVersion: spec.compatibility.wasix_runtime_version,
  };
}

export function nativeCarrierLeaves(spec: NativeCarrierSpec) {
  const facades = spec.carriers.filter((row) => row.ecosystem === 'npm' && row.target === null);
  assert.equal(facades.length, 1, 'canonical extension npm facade must be unique');
  const selected = ['npm', 'cargo'].map((ecosystem) => {
    const name = `${ecosystem === 'npm' ? facades[0].name : spec.product}-${spec.target}`;
    const rows = spec.carriers.filter(
      (row) => row.ecosystem === ecosystem && row.target === spec.target && row.name === name,
    );
    assert.equal(rows.length, 1, `canonical ${ecosystem} extension leaf must be unique`);
    const row = rows[0];
    assert.equal(row.product, spec.owner ?? spec.product);
    assert.equal(row.version, spec.version);
    return row;
  });
  return { npm: selected[0], cargo: selected[1] };
}

export function validateNativeCarrierIdentities(spec: NativeCarrierSpec) {
  const selected = nativeCarrierLeaves(spec);
  assert.equal(
    path.basename(spec.outputs.github),
    `${spec.product}-${spec.version}-native-${spec.target}-runtime.tar.gz`,
  );
  return selected;
}

export function assemblePublicNativeMember(spec: NativeCarrierSpec, output: string) {
  const actual = inspect(spec.archive, spec.sqlName, spec.owner ?? spec.product);
  const metadata = frozenNativeMember(spec, actual);
  const root = mkdtempSync(path.join(tmpdir(), 'native-extension-member-'));
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  try {
    const publicRoot = path.join(root, 'public');
    mkdirSync(publicRoot, { recursive: true });
    for (const [name, entry] of readPortableArchiveEntries(realpathSync(spec.archive))) {
      if (name === 'extension.json') continue;
      const output = path.join(publicRoot, 'files', name);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, entry.data(), { mode: name.startsWith('lib/') ? 0o755 : 0o644 });
      if (name.startsWith('lib/')) validateNativeShippingModule(entry.data(), spec.target, name);
    }
    stageExtensionUpstreamLicenses(spec.sqlName, path.join(publicRoot, 'files'));
    const legal = extensionCarrierLegalContract(spec.product, [spec.sqlName], {
      family: 'native',
      target: spec.target,
      memberContracts: [metadata],
    });
    stageReleaseNotices(publicRoot, { profile: legal.profile });
    const compatibility = nativeCarrierCompatibility(spec);
    const properties: Record<string, string> = {
      packageLayout: 'oliphaunt-extension-artifact-v1',
      pgMajor: '18',
      sqlName: spec.sqlName,
      createsExtension: metadata.createsExtension ? 'yes' : 'no',
      nativeModuleStem: metadata.nativeModuleStem ?? '',
      nativeModuleFile: actual.module_file,
      nativeTarget: spec.target,
      nativeRuntimeProduct: compatibility.nativeRuntimeProduct,
      nativeRuntimeVersion: compatibility.nativeRuntimeVersion,
      dependencies: metadata.dependencies.join(','),
      dataFiles: metadata.dataFiles.join(','),
      extensionSqlFileNames: metadata.extensionSqlFileNames.join(','),
      extensionSqlFilePrefixes: metadata.extensionSqlFilePrefixes.join(','),
      sharedPreloadLibraries: metadata.sharedPreloadLibraries.join(','),
      mobilePrebuilt: 'no',
      mobileStaticArchives: '',
      mobileStaticDependencyArchives: '',
      staticSymbolPrefix: '',
      staticSymbolAliases: '',
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
    validateExtensionArtifactArchive({
      file: output,
      metadata,
      product: spec.product,
      target: spec.target,
      nativeRuntimeVersion: compatibility.nativeRuntimeVersion,
    });
    const asset = {
      name: path.basename(output),
      family: 'native',
      target: spec.target,
      kind: 'runtime',
      identity: null,
      bytes: readFileSync(output).length,
      sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
    };
    return { metadata, asset };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function stageNativeRegistryCarriers(
  spec: NativeCarrierSpec,
  productRoot: string,
  root: string,
) {
  const identities = nativeCarrierLeaves(spec);
  const result = { staged: [], skipped: [] };
  const npmRoot = stageExtensionNativeNpmPackages(
    [productRoot],
    path.join(root, 'npm'),
    spec.target,
    result,
    { metaTargets: [] },
  );
  assert(npmRoot, `native npm packaging failed: ${result.skipped.join('; ')}`);
  const npmFiles = result.staged.filter((file) => file.endsWith('.tgz'));
  assert.equal(npmFiles.length, 1);
  const npm = npmFiles[0];
  const npmManifest = JSON.parse(
    readPortableArchiveEntries(npm).get('package/package.json')!.data().toString('utf8'),
  );
  assert.equal(npmManifest.name, identities.npm.name);
  assert.equal(npmManifest.version, identities.npm.version);
  copyFileSync(npm, spec.outputs.npm);
  const crates = packageNativeExtensionCargoCrates(
    [productRoot],
    path.join(root, 'cargo'),
    spec.target,
    true,
    result,
  );
  assert(crates.length > 0, `native Cargo packaging failed: ${result.skipped.join('; ')}`);
  assert(
    crates.some((file) => path.basename(file) === `${identities.cargo.name}-${spec.version}.crate`),
  );
  mkdirSync(spec.outputs.cargo, { recursive: true });
  for (const crate of crates)
    copyFileSync(crate, path.join(spec.outputs.cargo, path.basename(crate)));
}

export function packageNativeCarriers(spec: NativeCarrierSpec) {
  validateNativeCarrierIdentities(spec);
  const { metadata, asset } = assemblePublicNativeMember(spec, spec.outputs.github);
  const root = mkdtempSync(path.join(tmpdir(), 'native-extension-envelopes-'));
  for (const output of Object.values(spec.outputs))
    mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  try {
    const productRoot = path.join(root, 'product');
    const compatibility = nativeCarrierCompatibility(spec);
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    copyFileSync(spec.outputs.github, path.join(productRoot, 'release-assets', asset.name));
    const member = { ...metadata, assets: [asset] };
    writeJson(path.join(productRoot, 'extension-artifacts.json'), {
      schema: 'oliphaunt-extension-ci-artifacts-v1',
      product: spec.product,
      version: spec.version,
      compatibility,
      ...member,
    });
    writeJson(
      path.join(productRoot, 'release-assets', `${spec.product}-${spec.version}-manifest.json`),
      {
        schema: 'oliphaunt-extension-release-manifest-v1',
        product: spec.product,
        version: spec.version,
        extensionClass: spec.releaseMetadata?.class ?? 'external',
        versioning: 'upstream-bound',
        ...(spec.releaseMetadata ? { sourceIdentity: spec.releaseMetadata.sourceIdentity } : {}),
        compatibility,
        ...member,
      },
    );
    copyFileSync(path.join(productRoot, 'extension-artifacts.json'), spec.outputs.frozen);
    copyFileSync(
      path.join(productRoot, 'release-assets', `${spec.product}-${spec.version}-manifest.json`),
      spec.outputs.manifest,
    );
    stageNativeRegistryCarriers(spec, productRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: native_carriers.mts <declared-inputs.json>');
  packageNativeCarriers(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
