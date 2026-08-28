import {
  clusterSeedMount,
  decompressIfNeeded,
  type ExtractedArchive,
  extractTar,
  layoutRuntimeSupport,
  loadAsset,
  type WasixDirectoryMount,
  type WasixRuntimeLayout,
} from './archive.js';
import type {
  SerializedOpenOptions,
  SerializedRuntimeDescriptor,
  SerializedToolRuntimeDescriptor,
} from './rpc.js';
import { WASIX_PHYSICAL_IDENTITY, type WasixPhysicalIdentity } from './storage-provider.js';
import type { WasixAssetManifest } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHARED_PRELOAD_LIBRARIES = 'shared_preload_libraries';

type CatalogProfile = 'standard' | 'icu';

type ClusterSeedManifest = {
  schema: 'oliphaunt-cluster-seed-v1';
  artifactRole: 'cluster-seed-standard' | 'cluster-seed-icu';
  catalogProfile: CatalogProfile;
  runtime: {
    product: string;
    version: string;
    engineFamily: string;
    physicalFormat: string;
    postgresMajor: number;
    compatibilityKey: string;
    consumerSha256: string;
    producerSha256: string;
    initdbSha256: string;
  };
  source: {
    fingerprint: string;
    catalogVersion: string;
    lane: string;
    producer: string;
  };
  initProfile: string;
  archive: {
    path: string;
    sha256: string;
    compressedBytes: number;
    expandedBytes: number;
    regularFiles: number;
    directories: number;
  };
  requiredRuntimeFeatures: string[];
  extensions: {
    selected: string[];
    startupConfiguration: string[];
  };
  icu: null | {
    artifactRole: string;
    upstreamVersion: string;
    sourceCommit: string;
    dataTreeSha256: string;
    dataVersion: string;
    dataForm: string;
  };
};

/** Internal kebab-case projection used while installing an imported carrier. */
type ProjectedExtensionLifecycle = {
  'create-extension': boolean;
  'create-schema'?: string | null;
  'load-sql': readonly string[];
  'post-create-sql': readonly string[];
  'startup-config': readonly string[];
  'shared-memory-required': boolean;
};

/** Internal install shape projected solely from extension-owned carrier metadata. */
type ProjectedExtensionInstall = {
  name: string;
  'sql-name': string;
  archive: string;
  sha256: string;
  size: number;
  'native-module'?: string | null;
  'native-modules': readonly unknown[];
  dependencies: readonly string[];
  'load-order': readonly string[];
  lifecycle: ProjectedExtensionLifecycle;
  'installed-files': readonly string[];
  'unresolved-imports': readonly unknown[];
};

export type ResolvedWasixExtensions = {
  extensions: ProjectedExtensionInstall[];
  runtimeDependencies: string[];
};

export type PreparedWasixRuntime = {
  layout: WasixRuntimeLayout;
  loadClusterSeed(): Promise<WasixDirectoryMount>;
  moduleSha256: string;
  catalogProfile: 'standard' | 'icu';
  icuEnabled: boolean;
  startupGUCs: Record<string, string>;
  physicalIdentity: WasixPhysicalIdentity;
};

/**
 * Loads and verifies one exact runtime/ICU/extension closure. The matching
 * cluster seed stays lazy until an exclusively leased storage provider reports
 * a new root. Selection materializes exact artifacts and required startup
 * configuration; database-local installation remains explicit application SQL.
 */
export async function prepareWasixRuntime(
  options: SerializedOpenOptions,
): Promise<PreparedWasixRuntime> {
  const descriptor = options.runtime;
  const profile = options.icu === undefined ? 'standard' : 'icu';
  const seedArchiveDescriptor = options.icu?.clusterSeedArchive ?? descriptor.standardSeedArchive;
  const seedManifestDescriptor =
    options.icu?.clusterSeedManifest ?? descriptor.standardSeedManifest;
  const prefetchedSeedAssets =
    options.storage.kind === 'memory'
      ? loadClusterSeedAssets(profile, seedArchiveDescriptor, seedManifestDescriptor)
      : undefined;
  // Memory storage is always new, so overlap its required seed download with
  // the runtime closure. Persistent providers must inspect storage first.
  void prefetchedSeedAssets?.catch(() => undefined);
  const [manifestBytes, runtimeBytes, icuDataBytes] = await Promise.all([
    loadAsset(descriptor.manifest.source, 'WASIX asset manifest'),
    loadAsset(descriptor.runtimeArchive.source, 'WASIX runtime archive'),
    options.icu === undefined
      ? Promise.resolve(undefined)
      : loadAsset(options.icu.dataArchive.source, 'WASIX ICU data archive'),
  ]);
  await Promise.all([
    assertDeclaredAssetBytes(
      manifestBytes,
      descriptor.manifest.size,
      descriptor.manifest.sha256,
      'WASIX asset manifest',
    ),
    assertDeclaredAssetBytes(
      runtimeBytes,
      descriptor.runtimeArchive.size,
      descriptor.runtimeArchive.sha256,
      'WASIX runtime archive',
    ),
    ...(options.icu === undefined || icuDataBytes === undefined
      ? []
      : [
          assertDeclaredAssetBytes(
            icuDataBytes,
            options.icu.dataArchive.size,
            options.icu.dataArchive.sha256,
            'WASIX ICU data archive',
          ),
        ]),
  ]);
  const manifest = parseWasixAssetManifest(manifestBytes);
  assertRuntimeDescriptorMatchesManifest(descriptor, manifest);
  const selectedSeed = manifest['cluster-seeds'][profile];
  assertRuntimeArchiveMatchesManifest(
    seedArchiveDescriptor,
    selectedSeed,
    `WASIX ${profile} cluster seed archive`,
  );
  if (options.icu !== undefined) {
    assertIcuDescriptorMatchesRuntime(options.runtime, options.icu, manifest);
  }
  const eagerClusterSeed =
    prefetchedSeedAssets === undefined
      ? undefined
      : loadClusterSeed(
          options,
          manifest,
          selectedSeed,
          profile,
          seedArchiveDescriptor,
          seedManifestDescriptor,
          prefetchedSeedAssets,
        );
  void eagerClusterSeed?.catch(() => undefined);
  const runtime = extractTar(decompressIfNeeded(runtimeBytes));
  if (options.icu !== undefined && icuDataBytes !== undefined) {
    const icuArchive = extractTar(decompressIfNeeded(icuDataBytes));
    overlayIcuArchive(runtime, icuArchive);
  }
  const layout = layoutRuntimeSupport(runtime);
  assertExtensionCarriersCompatible(descriptor, manifest, options.extensionCarriers);

  const resolved = resolveWasixExtensions(manifest, options.extensionCarriers, options.extensions);
  assertExactCarrierClosure(resolved.extensions, options.extensionCarriers);
  const loaded = await Promise.all(
    resolved.extensions.map(async (extension) => {
      if (extension['unresolved-imports'].length > 0) {
        throw new Error(
          `WASIX extension '${extension['sql-name']}' carrier has unresolved imports`,
        );
      }
      const carrier = Object.hasOwn(options.extensionCarriers, extension['sql-name'])
        ? options.extensionCarriers[extension['sql-name']]
        : undefined;
      if (carrier === undefined) {
        throw new Error(
          `selected WASIX extension '${extension['sql-name']}' requires exact carrier ${extension.archive}`,
        );
      }
      const bytes = await loadAsset(
        carrier.source,
        `WASIX extension ${extension['sql-name']} from ${carrier.product}@${carrier.version}`,
      );
      if (bytes.length !== extension.size) {
        throw new Error(
          `WASIX extension '${extension['sql-name']}' carrier size mismatch: expected ${extension.size}, received ${bytes.length}`,
        );
      }
      await assertSha256(
        bytes,
        extension.sha256,
        `WASIX extension '${extension['sql-name']}' carrier`,
      );
      return [extension, extractTar(decompressIfNeeded(bytes))] as const;
    }),
  );
  for (const [extension, archive] of loaded) {
    overlayExtensionArchive(layout, archive, extension);
  }

  return {
    layout,
    loadClusterSeed: lazyClusterSeedLoader(
      options,
      manifest,
      selectedSeed,
      profile,
      seedArchiveDescriptor,
      seedManifestDescriptor,
      eagerClusterSeed,
    ),
    moduleSha256: manifest.runtime['module-sha256'],
    catalogProfile: profile,
    icuEnabled: options.icu !== undefined,
    startupGUCs: mergeExtensionStartupGUCs(options.startupGUCs, resolved.extensions),
    physicalIdentity: WASIX_PHYSICAL_IDENTITY,
  };
}

function lazyClusterSeedLoader(
  options: SerializedOpenOptions,
  manifest: WasixAssetManifest,
  selectedSeed: WasixAssetManifest['cluster-seeds'][CatalogProfile],
  profile: CatalogProfile,
  archiveDescriptor: SerializedRuntimeDescriptor['standardSeedArchive'],
  manifestDescriptor: SerializedRuntimeDescriptor['standardSeedManifest'],
  eager?: Promise<WasixDirectoryMount>,
): () => Promise<WasixDirectoryMount> {
  let cached = eager;
  const forgetRejectedAttempt = (attempt: Promise<WasixDirectoryMount>) => {
    void attempt.catch(() => {
      if (cached === attempt) cached = undefined;
    });
  };
  if (cached !== undefined) forgetRejectedAttempt(cached);
  return () => {
    if (cached === undefined) {
      const attempt = loadClusterSeed(
        options,
        manifest,
        selectedSeed,
        profile,
        archiveDescriptor,
        manifestDescriptor,
      );
      cached = attempt;
      forgetRejectedAttempt(attempt);
    }
    return cached;
  };
}

type ClusterSeedAssets = readonly [archive: Uint8Array, manifest: Uint8Array];

function loadClusterSeedAssets(
  profile: CatalogProfile,
  archiveDescriptor: SerializedRuntimeDescriptor['standardSeedArchive'],
  manifestDescriptor: SerializedRuntimeDescriptor['standardSeedManifest'],
): Promise<ClusterSeedAssets> {
  return Promise.all([
    loadAsset(archiveDescriptor.source, `WASIX ${profile} cluster seed`),
    loadAsset(manifestDescriptor.source, `WASIX ${profile} cluster seed manifest`),
  ]);
}

async function loadClusterSeed(
  options: SerializedOpenOptions,
  manifest: WasixAssetManifest,
  selectedSeed: WasixAssetManifest['cluster-seeds'][CatalogProfile],
  profile: CatalogProfile,
  archiveDescriptor: SerializedRuntimeDescriptor['standardSeedArchive'],
  manifestDescriptor: SerializedRuntimeDescriptor['standardSeedManifest'],
  assets?: Promise<ClusterSeedAssets>,
): Promise<WasixDirectoryMount> {
  const [archiveBytes, manifestBytes] = await (assets ??
    loadClusterSeedAssets(profile, archiveDescriptor, manifestDescriptor));
  await Promise.all([
    assertDeclaredAssetBytes(
      archiveBytes,
      archiveDescriptor.size,
      archiveDescriptor.sha256,
      `WASIX ${profile} cluster seed`,
    ),
    assertDeclaredAssetBytes(
      manifestBytes,
      manifestDescriptor.size,
      manifestDescriptor.sha256,
      `WASIX ${profile} cluster seed manifest`,
    ),
  ]);
  const seedManifest = parseClusterSeedManifest(manifestBytes, profile);
  verifyClusterSeedIdentity(options, manifest, selectedSeed, seedManifest, archiveDescriptor);
  const seed = extractTar(decompressIfNeeded(archiveBytes));
  verifyPostgresIdentity(manifest, selectedSeed, seed.files.get('PG_VERSION'));
  return clusterSeedMount(seed);
}

/** Require the package-authored archive identities to match the canonical manifest. */
export function assertRuntimeDescriptorMatchesManifest(
  descriptor: SerializedRuntimeDescriptor,
  manifest: WasixAssetManifest,
): void {
  assertToolRuntimeDescriptorMatchesManifest(descriptor, manifest);
  assertRuntimeArchiveMatchesManifest(
    descriptor.standardSeedArchive,
    manifest['cluster-seeds'].standard,
    'WASIX standard cluster seed archive',
  );
}

/** Verify only the runtime assets consumed by PostgreSQL frontend tools. */
export function assertToolRuntimeDescriptorMatchesManifest(
  descriptor: SerializedToolRuntimeDescriptor,
  manifest: WasixAssetManifest,
): void {
  assertRuntimeArchiveMatchesManifest(
    descriptor.runtimeArchive,
    manifest.runtime,
    'WASIX runtime archive',
  );
}

export function assertExactCarrierClosure(
  resolved: readonly ProjectedExtensionInstall[],
  carriers: SerializedOpenOptions['extensionCarriers'],
): void {
  const expected = new Set(resolved.map((extension) => extension['sql-name']));
  const actual = new Set(Object.keys(carriers));
  const missing = [...expected].filter((sqlName) => !actual.has(sqlName)).sort();
  const unexpected = [...actual].filter((sqlName) => !expected.has(sqlName)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      'WASIX extension carrier closure does not match imported dependency resolution' +
        `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` +
        `${unexpected.length > 0 ? `; unexpected ${unexpected.join(', ')}` : ''}`,
    );
  }
}

export function parseWasixAssetManifest(bytes: Uint8Array): WasixAssetManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw new Error(`WASIX asset manifest is not valid UTF-8 JSON: ${describeError(error)}`);
  }
  const manifest = requireObject(parsed, 'WASIX asset manifest');
  if (manifest['format-version'] !== 2) {
    throw new Error('WASIX asset manifest must use format-version 2');
  }

  const runtime = requireObject(manifest.runtime, 'WASIX asset manifest runtime');
  requireAssetPath(runtime.archive, 'WASIX runtime archive');
  requireSha256(runtime.sha256, 'WASIX runtime archive');
  if (runtime.size !== undefined) {
    requireSafeInteger(runtime.size, 'WASIX runtime archive size');
  }
  requireSha256(runtime['module-sha256'], 'WASIX runtime module');
  requireString(runtime['postgres-version'], 'WASIX runtime PostgreSQL version');
  const link = requireObject(runtime.link, 'WASIX runtime link metadata');
  const exports = requireArray(link.exports, 'WASIX runtime exports');
  for (const [index, value] of exports.entries()) {
    const entry = requireObject(value, `WASIX runtime export ${index}`);
    requireString(entry.name, `WASIX runtime export ${index} name`);
    requireString(entry.kind, `WASIX runtime export ${index} kind`);
  }

  const seeds = requireObject(manifest['cluster-seeds'], 'WASIX asset manifest cluster-seeds');
  requireExactKeys(seeds, ['icu', 'standard'], 'WASIX asset manifest cluster-seeds');
  for (const profile of ['standard', 'icu'] as const) {
    const seed = requireObject(seeds[profile], `WASIX ${profile} cluster seed`);
    const expectedRole = profile === 'standard' ? 'cluster-seed-standard' : 'cluster-seed-icu';
    if (seed['catalog-profile'] !== profile || seed['artifact-role'] !== expectedRole) {
      throw new Error(`WASIX ${profile} cluster seed has a mismatched profile or artifact role`);
    }
    requireAssetPath(seed.archive, `WASIX ${profile} cluster seed archive`);
    requireAssetPath(seed.manifest, `WASIX ${profile} cluster seed manifest`);
    requireSha256(seed.sha256, `WASIX ${profile} cluster seed archive`);
    requireSafeInteger(seed.size, `WASIX ${profile} cluster seed archive size`);
    requireSha256(seed['runtime-module-sha256'], `WASIX ${profile} seed runtime module`);
    requireString(seed['postgres-version'], `WASIX ${profile} seed PostgreSQL version`);
    requireString(seed['source-fingerprint'], `WASIX ${profile} seed source fingerprint`);
    if (
      seed['physical-format'] !== 'wasix-pg18-v1' ||
      seed['compatibility-key'] !== 'wasix-pg18-datum32-v1'
    ) {
      throw new Error(`WASIX ${profile} cluster seed has an incompatible physical identity`);
    }
    if (profile === 'icu') {
      requireSha256(seed['icu-data-tree-sha256'], 'WASIX ICU seed data tree');
    } else if (seed['icu-data-tree-sha256'] !== undefined) {
      throw new Error('WASIX standard cluster seed must not identify ICU data');
    }
  }
  requireString(manifest['source-fingerprint'], 'WASIX asset source fingerprint');

  const runtimeSupport = requireArray(manifest['runtime-support'], 'WASIX runtime-support entries');
  for (const [index, value] of runtimeSupport.entries()) {
    const support = requireObject(value, `WASIX runtime-support entry ${index}`);
    requireSqlName(support.name, `WASIX runtime-support entry ${index} name`);
    requireInstallPath(support.path, `WASIX runtime-support entry ${index} path`);
    requireSha256(support.sha256, `WASIX runtime-support entry ${index}`);
  }

  const extensions = requireArray(manifest.extensions, 'WASIX extension entries');
  if (extensions.length !== 0) {
    throw new Error(
      'WASIX core asset manifest must not contain extension rows; import extension carriers explicitly',
    );
  }

  return parsed as WasixAssetManifest;
}

export function resolveWasixExtensions(
  manifest: WasixAssetManifest,
  carriers: SerializedOpenOptions['extensionCarriers'],
  requested: readonly string[],
): ResolvedWasixExtensions {
  const runtimeSupport = new Set(manifest['runtime-support'].map((entry) => entry.name));
  const bySqlName = new Map(
    Object.entries(carriers).map(([sqlName, carrier]) => {
      if (carrier.sqlName !== sqlName) {
        throw new Error(
          `WASIX extension carrier map key '${sqlName}' does not match carrier SQL name '${carrier.sqlName}'`,
        );
      }
      if (runtimeSupport.has(sqlName)) {
        throw new Error(
          `WASIX extension carrier '${sqlName}' cannot replace runtime-provided support`,
        );
      }
      return [sqlName, extensionFromCarrier(carrier)] as const;
    }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const runtimeDependencies = new Set<string>();
  const resolved: ProjectedExtensionInstall[] = [];

  const visit = (extension: ProjectedExtensionInstall): void => {
    const sqlName = extension['sql-name'];
    if (visited.has(sqlName)) {
      return;
    }
    if (extension.lifecycle['shared-memory-required']) {
      throw new Error(
        `selected WASIX extension '${sqlName}' requires shared-memory behavior that the @oliphaunt/wasix-ts host has not qualified`,
      );
    }
    if (visiting.has(sqlName)) {
      throw new Error(`cyclic WASIX extension dependency involving '${sqlName}'`);
    }
    visiting.add(sqlName);
    for (const dependency of extension.dependencies) {
      if (runtimeSupport.has(dependency)) {
        runtimeDependencies.add(dependency);
      } else {
        const dependencyExtension = bySqlName.get(dependency);
        if (dependencyExtension !== undefined) {
          visit(dependencyExtension);
          continue;
        }
        throw new Error(
          `selected WASIX extension '${sqlName}' depends on unavailable extension '${dependency}'`,
        );
      }
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
    resolved.push(extension);
  };

  for (const sqlName of [...new Set(requested)].sort()) {
    requireSqlName(sqlName, 'selected WASIX extension');
    const extension = bySqlName.get(sqlName);
    if (extension === undefined) {
      throw new Error(`selected WASIX extension '${sqlName}' has no imported carrier`);
    }
    visit(extension);
  }
  return {
    extensions: resolved,
    runtimeDependencies: [...runtimeDependencies].sort(),
  };
}

function extensionFromCarrier(
  carrier: SerializedOpenOptions['extensionCarriers'][string],
): ProjectedExtensionInstall {
  const lifecycle = carrier.install.lifecycle;
  return {
    name: carrier.install.name,
    'sql-name': carrier.sqlName,
    archive: carrier.archive,
    sha256: carrier.sha256,
    size: carrier.size,
    'native-module': carrier.install.nativeModule,
    'native-modules': carrier.install.nativeModules,
    dependencies: carrier.install.dependencies,
    'load-order': carrier.install.loadOrder,
    lifecycle: {
      'create-extension': lifecycle.createExtension,
      ...(lifecycle.createSchema === undefined ? {} : { 'create-schema': lifecycle.createSchema }),
      'load-sql': lifecycle.loadSql,
      'post-create-sql': lifecycle.postCreateSql,
      'startup-config': lifecycle.startupConfig,
      'shared-memory-required': lifecycle.sharedMemoryRequired,
    },
    'installed-files': carrier.install.installedFiles,
    'unresolved-imports': carrier.install.unresolvedImports,
  };
}

export function assertExtensionCarriersCompatible(
  runtime: SerializedRuntimeDescriptor,
  manifest: WasixAssetManifest,
  carriers: SerializedOpenOptions['extensionCarriers'],
): void {
  const postgresMajor = manifest.runtime['postgres-version'].split('.')[0];
  for (const carrier of Object.values(carriers)) {
    const compatibility = carrier.compatibility;
    if (compatibility.extensionRuntimeContract !== 'oliphaunt-extension-runtime-contract-v1') {
      throw new Error(
        `WASIX extension '${carrier.sqlName}' has an unsupported extension runtime contract`,
      );
    }
    if (
      compatibility.wasixRuntimeProduct !== runtime.product ||
      compatibility.wasixRuntimeVersion !== runtime.version
    ) {
      throw new Error(
        `WASIX extension '${carrier.sqlName}' targets ${compatibility.wasixRuntimeProduct}@${compatibility.wasixRuntimeVersion}, not ${runtime.product}@${runtime.version}`,
      );
    }
    if (compatibility.postgresMajor !== postgresMajor) {
      throw new Error(
        `WASIX extension '${carrier.sqlName}' targets PostgreSQL ${compatibility.postgresMajor}, not ${postgresMajor}`,
      );
    }
  }
  const coreExports = new Set(
    manifest.runtime.link.exports
      .filter((entry) => entry.kind === 'func' || entry.kind === 'global')
      .map((entry) => entry.name),
  );
  for (const carrier of Object.values(carriers)) {
    const missing = carrier.install.coreExportsRequired.filter((name) => !coreExports.has(name));
    if (missing.length > 0) {
      throw new Error(
        `WASIX extension '${carrier.sqlName}' requires exports absent from the selected core runtime: ${missing.join(', ')}`,
      );
    }
  }
}

export function overlayExtensionArchive(
  layout: WasixRuntimeLayout,
  archive: ExtractedArchive,
  extension: ProjectedExtensionInstall,
): void {
  const sqlName = extension['sql-name'];
  const expected = new Set(extension['installed-files']);
  if (expected.size !== extension['installed-files'].length) {
    throw new Error(`WASIX extension '${sqlName}' manifest repeats installed file paths`);
  }
  const actual = new Set(archive.files.keys());
  const missing = [...expected].filter((path) => !actual.has(path));
  const unexpected = [...actual].filter((path) => !expected.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `WASIX extension '${sqlName}' archive contents do not match installed-files` +
        `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` +
        `${unexpected.length > 0 ? `; unexpected ${unexpected.join(', ')}` : ''}`,
    );
  }

  for (const [path, bytes] of archive.files) {
    const { mountPath, relative } = extensionMountTarget(path, sqlName);
    const mount = layout.mounts[mountPath];
    if (mount === undefined) {
      throw new Error(`WASIX runtime is missing extension mount ${mountPath}`);
    }
    if (Object.hasOwn(mount.files, relative)) {
      throw new Error(`WASIX extension '${sqlName}' collides with installed file ${path}`);
    }
    mount.files[relative] = bytes;
  }
  for (const path of archive.directories) {
    if (path === 'lib' || path === 'share') {
      continue;
    }
    const { mountPath, relative } = extensionMountTarget(path, sqlName, true);
    const mount = layout.mounts[mountPath];
    if (mount === undefined) {
      throw new Error(`WASIX runtime is missing extension mount ${mountPath}`);
    }
    if (!mount.directories.includes(relative)) {
      mount.directories.push(relative);
    }
  }
}

export function mergeExtensionStartupGUCs(
  configured: Readonly<Record<string, string>>,
  extensions: readonly ProjectedExtensionInstall[],
): Record<string, string> {
  const merged = { ...configured };
  const sharedPreloads: string[] = [];
  const seenSharedPreloads = new Set<string>();
  appendCsv(merged[SHARED_PRELOAD_LIBRARIES], sharedPreloads, seenSharedPreloads);

  for (const extension of extensions) {
    for (const assignment of extension.lifecycle['startup-config']) {
      const equals = assignment.indexOf('=');
      const name = assignment.slice(0, equals).trim();
      const value = assignment.slice(equals + 1).trim();
      if (equals <= 0 || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(name) || value.length === 0) {
        throw new Error(
          `WASIX extension '${extension['sql-name']}' has invalid startup config '${assignment}'`,
        );
      }
      if (name === SHARED_PRELOAD_LIBRARIES) {
        appendCsv(value, sharedPreloads, seenSharedPreloads);
        continue;
      }
      const existing = merged[name];
      if (existing !== undefined && existing !== value) {
        throw new Error(
          `WASIX extension '${extension['sql-name']}' requires ${name}=${value}, but the caller configured ${name}=${existing}`,
        );
      }
      merged[name] = value;
    }
  }
  if (sharedPreloads.length > 0) {
    merged[SHARED_PRELOAD_LIBRARIES] = sharedPreloads.join(',');
  }
  return merged;
}

function parseClusterSeedManifest(
  bytes: Uint8Array,
  expectedProfile: CatalogProfile,
): ClusterSeedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw new Error(
      `WASIX ${expectedProfile} cluster seed manifest is not valid UTF-8 JSON: ${describeError(error)}`,
    );
  }
  const label = `WASIX ${expectedProfile} cluster seed manifest`;
  const root = requireObject(parsed, label);
  requireExactKeys(
    root,
    [
      'archive',
      'artifactRole',
      'catalogProfile',
      'extensions',
      'icu',
      'initProfile',
      'requiredRuntimeFeatures',
      'runtime',
      'schema',
      'source',
    ],
    label,
  );
  assertClusterSeedProfileContract(root, expectedProfile);
  requireString(root.initProfile, `${label} init profile`);

  const runtime = requireObject(root.runtime, `${label} runtime`);
  requireExactKeys(
    runtime,
    [
      'compatibilityKey',
      'consumerSha256',
      'engineFamily',
      'initdbSha256',
      'physicalFormat',
      'postgresMajor',
      'producerSha256',
      'product',
      'version',
    ],
    `${label} runtime`,
  );
  for (const field of [
    'product',
    'version',
    'engineFamily',
    'physicalFormat',
    'compatibilityKey',
  ] as const) {
    requireString(runtime[field], `${label} runtime ${field}`);
  }
  requirePositiveInteger(runtime.postgresMajor, `${label} runtime PostgreSQL major`);
  for (const field of ['consumerSha256', 'producerSha256', 'initdbSha256'] as const) {
    requireSha256(runtime[field], `${label} runtime ${field}`);
  }

  const source = requireObject(root.source, `${label} source`);
  requireExactKeys(
    source,
    ['catalogVersion', 'fingerprint', 'lane', 'producer'],
    `${label} source`,
  );
  for (const field of ['catalogVersion', 'fingerprint', 'lane', 'producer'] as const) {
    requireString(source[field], `${label} source ${field}`);
  }

  const archive = requireObject(root.archive, `${label} archive`);
  requireExactKeys(
    archive,
    ['compressedBytes', 'directories', 'expandedBytes', 'path', 'regularFiles', 'sha256'],
    `${label} archive`,
  );
  requireAssetPath(archive.path, `${label} archive path`);
  requireSha256(archive.sha256, `${label} archive`);
  for (const field of [
    'compressedBytes',
    'directories',
    'expandedBytes',
    'regularFiles',
  ] as const) {
    requirePositiveInteger(archive[field], `${label} archive ${field}`);
  }

  const extensions = requireObject(root.extensions, `${label} extensions`);
  requireExactKeys(extensions, ['selected', 'startupConfiguration'], `${label} extensions`);
  const selected = requireStringArray(extensions.selected, `${label} selected extensions`);
  const startupConfiguration = requireStringArray(
    extensions.startupConfiguration,
    `${label} startup configuration`,
  );
  if (selected.length !== 0 || startupConfiguration.length !== 0) {
    throw new Error(`${label} must be extension-free`);
  }

  return parsed as ClusterSeedManifest;
}

/** @internal Validate the host-independent standard/ICU seed profile contract. */
export function assertClusterSeedProfileContract(
  value: unknown,
  expectedProfile: CatalogProfile,
): void {
  const label = `WASIX ${expectedProfile} cluster seed manifest`;
  const root = requireObject(value, label);
  if (root.schema !== 'oliphaunt-cluster-seed-v1') {
    throw new Error(`${label} has an unsupported schema`);
  }
  if (root.catalogProfile !== expectedProfile) {
    throw new Error(
      `${label} profile mismatch: expected ${expectedProfile}, got ${String(root.catalogProfile)}`,
    );
  }
  const expectedRole =
    expectedProfile === 'standard' ? 'cluster-seed-standard' : 'cluster-seed-icu';
  if (root.artifactRole !== expectedRole) {
    throw new Error(
      `${label} profile mismatch: expected role ${expectedRole}, got ${String(root.artifactRole)}`,
    );
  }

  const requiredFeatures = requireStringArray(
    root.requiredRuntimeFeatures,
    `${label} required features`,
  );
  if (expectedProfile === 'standard') {
    if (requiredFeatures.length !== 0 || root.icu !== null) {
      throw new Error(`${label} must not require or identify ICU data`);
    }
    return;
  }
  if (requiredFeatures.length !== 1 || requiredFeatures[0] !== 'icu') {
    throw new Error(`${label} must require exactly the ICU runtime feature`);
  }
  const icu = requireObject(root.icu, `${label} ICU identity`);
  requireExactKeys(
    icu,
    [
      'artifactRole',
      'dataForm',
      'dataTreeSha256',
      'dataVersion',
      'sourceCommit',
      'upstreamVersion',
    ],
    `${label} ICU identity`,
  );
  for (const field of [
    'artifactRole',
    'dataForm',
    'dataVersion',
    'sourceCommit',
    'upstreamVersion',
  ] as const) {
    requireString(icu[field], `${label} ICU ${field}`);
  }
  requireSha256(icu.dataTreeSha256, `${label} ICU data tree`);
  if (
    icu.artifactRole !== 'icu-data' ||
    icu.upstreamVersion !== '76.1' ||
    icu.dataVersion !== '76.1' ||
    icu.dataForm !== 'files-le'
  ) {
    throw new Error(`${label} has an incompatible ICU identity`);
  }
}

/** @internal Verify that a separately distributed ICU carrier belongs to this runtime. */
export function assertIcuDescriptorMatchesRuntime(
  runtime: SerializedRuntimeDescriptor,
  icu: NonNullable<SerializedOpenOptions['icu']>,
  manifest: WasixAssetManifest,
): void {
  if (
    icu.compatibility.runtimeProduct !== runtime.product ||
    icu.compatibility.runtimeVersion !== runtime.version
  ) {
    throw new Error(
      `WASIX ICU carrier targets ${icu.compatibility.runtimeProduct}@${icu.compatibility.runtimeVersion}, not ${runtime.product}@${runtime.version}`,
    );
  }
  if (icu.compatibility.dataTreeSha256 !== manifest['cluster-seeds'].icu['icu-data-tree-sha256']) {
    throw new Error('WASIX ICU data and ICU cluster seed identify different logical data trees');
  }
}

function verifyClusterSeedIdentity(
  options: SerializedOpenOptions,
  outer: WasixAssetManifest,
  selected: WasixAssetManifest['cluster-seeds'][CatalogProfile],
  seed: ClusterSeedManifest,
  archive: SerializedRuntimeDescriptor['runtimeArchive'],
): void {
  const profile = seed.catalogProfile;
  if (
    seed.runtime.product !== options.runtime.product ||
    seed.runtime.version !== options.runtime.version ||
    seed.runtime.engineFamily !== 'wasix' ||
    seed.runtime.physicalFormat !== 'wasix-pg18-v1' ||
    seed.runtime.compatibilityKey !== 'wasix-pg18-datum32-v1' ||
    seed.runtime.postgresMajor !== 18
  ) {
    throw new Error(`WASIX ${profile} cluster seed has an incompatible runtime identity`);
  }
  if (
    seed.runtime.consumerSha256 !== seed.runtime.producerSha256 ||
    seed.runtime.consumerSha256 !== outer.runtime['module-sha256'] ||
    seed.runtime.consumerSha256 !== selected['runtime-module-sha256']
  ) {
    throw new Error(`WASIX ${profile} cluster seed was produced by a different runtime module`);
  }
  if (
    seed.source.fingerprint !== outer['source-fingerprint'] ||
    seed.source.fingerprint !== selected['source-fingerprint']
  ) {
    throw new Error(`WASIX ${profile} cluster seed has a different source fingerprint`);
  }
  if (
    seed.archive.path !== archive.archive ||
    seed.archive.path !== selected.archive ||
    seed.archive.sha256 !== archive.sha256 ||
    seed.archive.sha256 !== selected.sha256 ||
    seed.archive.compressedBytes !== archive.size ||
    seed.archive.compressedBytes !== selected.size
  ) {
    throw new Error(`WASIX ${profile} cluster seed archive identity is inconsistent`);
  }
  if (seed.archive.path !== `cluster-seeds/${profile}.tar.zst`) {
    throw new Error(`WASIX ${profile} cluster seed has a non-canonical archive path`);
  }
  if (profile === 'icu') {
    const icu = options.icu;
    if (
      icu === undefined ||
      seed.icu === null ||
      seed.icu.artifactRole !== 'icu-data' ||
      seed.icu.upstreamVersion !== icu.compatibility.dataVersion ||
      seed.icu.dataVersion !== icu.compatibility.dataVersion ||
      seed.icu.dataForm !== icu.compatibility.dataForm ||
      seed.icu.dataTreeSha256 !== icu.compatibility.dataTreeSha256
    ) {
      throw new Error('WASIX ICU cluster seed does not match the selected ICU data carrier');
    }
  }
}

/** @internal Validate and add exact-archive-verified ICU files to the runtime tree. */
export function overlayIcuArchive(runtime: ExtractedArchive, icu: ExtractedArchive): void {
  const prefix = 'share/icu/';
  const rows: { path: string; bytes: Uint8Array }[] = [];
  const directories: string[] = [];
  let hasDataFile = false;
  for (const [path, bytes] of icu.files) {
    if (!path.startsWith(prefix) || path.length === prefix.length) {
      throw new Error(`WASIX ICU data archive contains a file outside share/icu: ${path}`);
    }
    const relative = path.slice(prefix.length);
    if (relative.split('/').some((segment) => segment.startsWith('icudt'))) hasDataFile = true;
    rows.push({ path: relative, bytes });
    const target = `oliphaunt/${path}`;
    if (runtime.files.has(target) || runtime.directories.has(target)) {
      throw new Error(`WASIX ICU data collides with runtime path ${target}`);
    }
  }
  if (rows.length === 0 || !hasDataFile) {
    throw new Error('WASIX ICU data archive contains no ICU data files under share/icu');
  }
  for (const path of icu.directories) {
    if (path !== 'share' && path !== 'share/icu' && !path.startsWith(prefix)) {
      throw new Error(`WASIX ICU data archive contains a directory outside share/icu: ${path}`);
    }
    if (path === 'share') continue;
    const target = `oliphaunt/${path}`;
    if (runtime.files.has(target)) {
      throw new Error(`WASIX ICU data collides with runtime path ${target}`);
    }
    directories.push(target);
  }
  for (const { path, bytes } of rows) runtime.files.set(`oliphaunt/share/icu/${path}`, bytes);
  for (const path of directories) runtime.directories.add(path);
}

function assertRuntimeArchiveMatchesManifest(
  descriptor: SerializedRuntimeDescriptor['runtimeArchive'],
  manifest: { archive: string; sha256: string; size?: number },
  label: string,
): void {
  if (descriptor.archive !== manifest.archive) {
    throw new Error(
      `${label} path does not match the canonical manifest: expected ${manifest.archive}, received ${descriptor.archive}`,
    );
  }
  if (descriptor.sha256 !== manifest.sha256) {
    throw new Error(`${label} SHA-256 does not match the canonical manifest`);
  }
  if (manifest.size !== undefined && descriptor.size !== manifest.size) {
    throw new Error(
      `${label} size does not match the canonical manifest: expected ${manifest.size}, received ${descriptor.size}`,
    );
  }
}

async function assertDeclaredAssetBytes(
  bytes: Uint8Array,
  expectedSize: number,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (bytes.length !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, received ${bytes.length}`);
  }
  await assertSha256(bytes, expectedSha256, label);
}

function verifyPostgresIdentity(
  manifest: WasixAssetManifest,
  seed: WasixAssetManifest['cluster-seeds'][CatalogProfile],
  pgVersionBytes: Uint8Array | undefined,
): void {
  if (pgVersionBytes === undefined) {
    throw new Error('WASIX cluster seed is missing PG_VERSION');
  }
  const pgVersion = decodeUtf8(pgVersionBytes).trim();
  const runtimeMajor = manifest.runtime['postgres-version'].split('.')[0];
  const seedMajor = seed['postgres-version'].split('.')[0];
  if (pgVersion !== runtimeMajor || pgVersion !== seedMajor) {
    throw new Error(
      `WASIX runtime/cluster seed PostgreSQL major mismatch: runtime ${runtimeMajor}, seed ${seedMajor}, PG_VERSION ${pgVersion}`,
    );
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  const input =
    typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
      ? Uint8Array.from(bytes)
      : bytes;
  return decoder.decode(input);
}

/** @internal Shared verification for separately carried WASIX tool modules. */
export async function assertSha256(
  bytes: Uint8Array,
  expected: string,
  label: string,
): Promise<void> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error(`Web Crypto is required to verify ${label}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('Web Crypto is required to calculate SHA-256');
  }
  const source =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice().buffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function extensionMountTarget(
  path: string,
  sqlName: string,
  directory = false,
): { mountPath: '/lib' | '/share'; relative: string } {
  const allowed = [
    'lib/postgresql/',
    'share/proj/',
    'share/postgresql/extension/',
    'share/postgresql/tsearch_data/',
  ];
  const allowedDirectory = new Set([
    'lib/postgresql',
    'share/proj',
    'share/postgresql',
    'share/postgresql/extension',
    'share/postgresql/tsearch_data',
  ]);
  if (
    !allowed.some((prefix) => path.startsWith(prefix)) &&
    !(directory && allowedDirectory.has(path))
  ) {
    throw new Error(`WASIX extension '${sqlName}' contains non-canonical install path ${path}`);
  }
  const slash = path.indexOf('/');
  return {
    mountPath: path.slice(0, slash) === 'lib' ? '/lib' : '/share',
    relative: path.slice(slash + 1),
  };
}

function appendCsv(value: string | undefined, ordered: string[], seen: Set<string>): void {
  for (const item of value?.split(',') ?? []) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    const missing = canonical.filter((key) => !Object.hasOwn(value, key));
    const unexpected = actual.filter((key) => !canonical.includes(key));
    throw new Error(
      `${label} fields do not match the contract` +
        `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` +
        `${unexpected.length > 0 ? `; unexpected ${unexpected.join(', ')}` : ''}`,
    );
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  const values = requireArray(value, label);
  return values.map((entry, index) => requireString(entry, `${label} entry ${index}`));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireSqlName(value: unknown, label: string): string {
  const name = requireString(value, label);
  if (!SQL_NAME.test(name)) {
    throw new Error(`${label} must be a portable PostgreSQL extension name`);
  }
  return name;
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, `${label} SHA-256`);
  if (!SHA256.test(hash)) {
    throw new Error(`${label} SHA-256 must be 64 lowercase hexadecimal characters`);
  }
  return hash;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireSafeInteger(value, label);
  if (integer === 0) throw new Error(`${label} must be positive`);
  return integer;
}

function requireAssetPath(value: unknown, label: string): string {
  const path = requireString(value, label);
  const segments = path.replaceAll('\\', '/').split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a safe relative asset path`);
  }
  return path;
}

function requireInstallPath(value: unknown, label: string): string {
  const path = requireAssetPath(value, label);
  extensionMountTarget(path, label);
  return path;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
