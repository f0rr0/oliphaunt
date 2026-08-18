import {
  decompressIfNeeded,
  type ExtractedArchive,
  extractTar,
  layoutRuntime,
  loadAsset,
  type WasixRuntimeLayout,
} from './archive.js';
import type { SerializedOpenOptions, SerializedRuntimeDescriptor } from './rpc.js';
import { canonicalStorageContract, type WasixStorageCompatibility } from './storage-provider.js';
import type { WasixAssetManifest } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHARED_PRELOAD_LIBRARIES = 'shared_preload_libraries';

/** Internal kebab-case projection used while installing an imported carrier. */
type ProjectedExtensionLifecycle = {
  'create-extension': boolean;
  'create-schema'?: string | null;
  'load-sql': readonly string[];
  'post-create-sql': readonly string[];
  'startup-config': readonly string[];
  'preload-required': boolean;
  'restart-required': boolean;
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
  startupGUCs: Record<string, string>;
  setupSql: string[];
  storageCompatibility: WasixStorageCompatibility;
};

/**
 * Loads and verifies one exact runtime/PGDATA/extension asset set. Extension
 * bytes are overlaid before Wasmer sees the mounts, while lifecycle SQL stays
 * separate for execution after PostgreSQL reaches ReadyForQuery.
 */
export async function prepareWasixRuntime(
  options: SerializedOpenOptions,
): Promise<PreparedWasixRuntime> {
  const descriptor = options.runtime;
  const [manifestBytes, runtimeBytes, pgdataBytes] = await Promise.all([
    loadAsset(descriptor.manifest.source, 'WASIX asset manifest'),
    loadAsset(descriptor.runtimeArchive.source, 'WASIX runtime archive'),
    loadAsset(descriptor.pgdataArchive.source, 'WASIX PGDATA template'),
  ]);
  await verifyRuntimeDescriptorBytes(descriptor, manifestBytes, runtimeBytes, pgdataBytes);
  const manifest = parseWasixAssetManifest(manifestBytes);
  assertRuntimeDescriptorMatchesManifest(descriptor, manifest);
  verifyCoreIdentity(manifest);

  const runtime = extractTar(decompressIfNeeded(runtimeBytes));
  const pgdata = extractTar(decompressIfNeeded(pgdataBytes));
  const layout = layoutRuntime(runtime, pgdata);
  await assertSha256(layout.module, manifest.runtime['module-sha256'], 'WASIX runtime module');
  verifyPostgresIdentity(manifest, pgdata.files.get('PG_VERSION'));
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
    startupGUCs: mergeExtensionStartupGUCs(options.startupGUCs, resolved.extensions),
    setupSql: extensionSetupSql(resolved),
    storageCompatibility: storageCompatibility(descriptor, manifest, options.extensionCarriers),
  };
}

function storageCompatibility(
  runtime: SerializedRuntimeDescriptor,
  manifest: WasixAssetManifest,
  carriers: SerializedOpenOptions['extensionCarriers'],
): WasixStorageCompatibility {
  return {
    schema: 'oliphaunt-wasix-pgdata-compatibility-v1',
    runtime: {
      product: runtime.product,
      version: runtime.version,
      manifestSha256: runtime.manifest.sha256,
      runtimeArchiveSha256: runtime.runtimeArchive.sha256,
      pgdataTemplateSha256: runtime.pgdataArchive.sha256,
      moduleSha256: manifest.runtime['module-sha256'],
      sourceFingerprint: manifest['source-fingerprint'],
      postgresVersion: manifest.runtime['postgres-version'],
    },
    extensions: Object.values(carriers)
      .sort((left, right) => left.sqlName.localeCompare(right.sqlName))
      .map((carrier) => ({
        sqlName: carrier.sqlName,
        product: carrier.product,
        version: carrier.version,
        archiveSha256: carrier.sha256,
        installContract: canonicalStorageContract({
          compatibility: carrier.compatibility,
          install: carrier.install,
        }),
      })),
  };
}

/** Require the package-authored archive identities to match the canonical manifest. */
export function assertRuntimeDescriptorMatchesManifest(
  descriptor: SerializedRuntimeDescriptor,
  manifest: WasixAssetManifest,
): void {
  assertRuntimeArchiveMatchesManifest(
    descriptor.runtimeArchive,
    manifest.runtime,
    'WASIX runtime archive',
  );
  assertRuntimeArchiveMatchesManifest(
    descriptor.pgdataArchive,
    manifest['pgdata-template'],
    'WASIX PGDATA archive',
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
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`WASIX asset manifest is not valid UTF-8 JSON: ${describeError(error)}`);
  }
  const manifest = requireObject(parsed, 'WASIX asset manifest');
  if (manifest['format-version'] !== 1) {
    throw new Error('WASIX asset manifest must use format-version 1');
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

  const pgdata = requireObject(manifest['pgdata-template'], 'WASIX asset manifest PGDATA template');
  requireAssetPath(pgdata.archive, 'WASIX PGDATA archive');
  requireSha256(pgdata.sha256, 'WASIX PGDATA archive');
  requireSafeInteger(pgdata.size, 'WASIX PGDATA archive size');
  requireSha256(pgdata['runtime-module-sha256'], 'WASIX PGDATA runtime module');
  requireString(pgdata['postgres-version'], 'WASIX PGDATA PostgreSQL version');
  requireString(pgdata['source-fingerprint'], 'WASIX PGDATA source fingerprint');
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
  return { extensions: resolved, runtimeDependencies: [...runtimeDependencies].sort() };
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
      'preload-required': lifecycle.preloadRequired,
      'restart-required': lifecycle.restartRequired,
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

export function extensionSetupSql(resolved: ResolvedWasixExtensions): string[] {
  const statements = resolved.runtimeDependencies.map(
    (dependency) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(dependency)};`,
  );
  const loadedModules = new Set<string>();
  for (const extension of resolved.extensions) {
    const lifecycle = extension.lifecycle;
    for (const path of extension['load-order']) {
      if (!loadedModules.has(path)) {
        statements.push(`LOAD ${quoteLiteral(`/${path}`)};`);
        loadedModules.add(path);
      }
    }
    if (lifecycle['create-extension']) {
      const schema = lifecycle['create-schema'] ?? undefined;
      if (schema !== undefined && schema !== 'pg_catalog') {
        statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
      }
      statements.push(
        `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension['sql-name'])}` +
          `${schema === undefined ? '' : ` WITH SCHEMA ${quoteIdentifier(schema)}`};`,
      );
    }
    statements.push(...lifecycle['load-sql'], ...lifecycle['post-create-sql']);
  }
  return statements;
}

async function verifyRuntimeDescriptorBytes(
  descriptor: SerializedRuntimeDescriptor,
  manifestBytes: Uint8Array,
  runtimeBytes: Uint8Array,
  pgdataBytes: Uint8Array,
): Promise<void> {
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
    assertDeclaredAssetBytes(
      pgdataBytes,
      descriptor.pgdataArchive.size,
      descriptor.pgdataArchive.sha256,
      'WASIX PGDATA archive',
    ),
  ]);
}

function verifyCoreIdentity(manifest: WasixAssetManifest): void {
  if (manifest.runtime['module-sha256'] !== manifest['pgdata-template']['runtime-module-sha256']) {
    throw new Error('WASIX runtime and PGDATA template identify different runtime modules');
  }
  if (manifest['source-fingerprint'] !== manifest['pgdata-template']['source-fingerprint']) {
    throw new Error('WASIX runtime and PGDATA template identify different source fingerprints');
  }
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
  pgVersionBytes: Uint8Array | undefined,
): void {
  if (pgVersionBytes === undefined) {
    throw new Error('WASIX PGDATA template is missing PG_VERSION');
  }
  const pgVersion = decoder.decode(pgVersionBytes).trim();
  const runtimeMajor = manifest.runtime['postgres-version'].split('.')[0];
  const templateMajor = manifest['pgdata-template']['postgres-version'].split('.')[0];
  if (pgVersion !== runtimeMajor || pgVersion !== templateMajor) {
    throw new Error(
      `WASIX runtime/PGDATA PostgreSQL major mismatch: runtime ${runtimeMajor}, template ${templateMajor}, PG_VERSION ${pgVersion}`,
    );
  }
}

async function assertSha256(bytes: Uint8Array, expected: string, label: string): Promise<void> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error(`Web Crypto is required to verify ${label}`);
  }
  const source =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice().buffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`);
  }
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

function quoteIdentifier(identifier: string): string {
  if (identifier.includes('\0')) {
    throw new Error('PostgreSQL identifier contains a NUL byte');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new Error('PostgreSQL string literal contains a NUL byte');
  }
  return `'${value.replaceAll("'", "''")}'`;
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
