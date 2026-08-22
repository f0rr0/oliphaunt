import {
  requireAssetSource,
  requireExactObject,
  requireSafeRelativeAssetPath,
  requireSha256,
  requireSize,
  requireString,
  requireVersion,
  serializeAssetSource,
} from './descriptor-validation.js';
import type { SerializedExtensionCarrier } from './rpc.js';
import type {
  WasixExtensionCarrier,
  WasixExtensionCompatibility,
  WasixExtensionDescriptor,
  WasixExtensionDescriptorInput,
  WasixExtensionImport,
  WasixExtensionInstall,
  WasixExtensionLifecycle,
  WasixExtensionNativeModule,
} from './types.js';

const DESCRIPTOR_FIELDS = [
  'carriers',
  'compatibility',
  'product',
  'runtime',
  'schema',
  'sqlName',
  'version',
];
const COMPATIBILITY_FIELDS = [
  'extensionRuntimeContract',
  'postgresMajor',
  'wasixRuntimeProduct',
  'wasixRuntimeVersion',
];
const CARRIER_FIELDS = [
  'archive',
  'install',
  'product',
  'sha256',
  'size',
  'source',
  'sqlName',
  'version',
];
const INSTALL_FIELDS = [
  'coreExportsRequired',
  'dependencies',
  'installedFiles',
  'lifecycle',
  'loadOrder',
  'name',
  'nativeModule',
  'nativeModules',
  'schema',
  'unresolvedImports',
];
const NATIVE_MODULE_FIELDS = ['moduleSha256', 'name', 'path', 'sha256', 'size'];
const IMPORT_FIELDS = ['kind', 'module', 'name'];
const LIFECYCLE_FIELDS = [
  'createExtension',
  'createSchema',
  'loadSql',
  'postCreateSql',
  'preloadRequired',
  'restartRequired',
  'sharedMemoryRequired',
  'startupConfig',
];
const PRODUCT = /^oliphaunt-extension-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const POSTGRES_MAJOR = /^(?:[1-9]\d*)$/;
const EXTENSION_RUNTIME_CONTRACT = 'oliphaunt-extension-runtime-contract-v1';

export type SerializedWasixExtensions = {
  selectedSqlNames: string[];
  carriers: Record<string, SerializedExtensionCarrier>;
};

/** Optional package-author helper that validates and deeply freezes a descriptor. */
export function defineWasixExtension(
  input: WasixExtensionDescriptorInput,
): WasixExtensionDescriptor {
  validateDescriptor(input, 'WASIX extension descriptor');
  return Object.freeze({
    ...input,
    compatibility: Object.freeze({ ...input.compatibility }),
    carriers: Object.freeze(input.carriers.map(freezeCarrier)),
  });
}

/**
 * Validates imported package values and converts roots plus carrier closures to
 * the worker wire shape. Imported carriers own their exact install metadata;
 * the core runtime manifest deliberately owns no extension rows.
 */
export function serializeWasixExtensionDescriptors(
  descriptors: readonly WasixExtensionDescriptor[],
): SerializedWasixExtensions {
  if (!Array.isArray(descriptors)) {
    throw new Error('WASIX extensions must be an array of imported extension descriptors');
  }

  const selectedSqlNames: string[] = [];
  const rootSqlNames = new Set<string>();
  const carrierBySqlName = new Map<
    string,
    {
      carrier: WasixExtensionCarrier;
      compatibility: WasixExtensionCompatibility;
    }
  >();
  const sqlNameByArchive = new Map<string, string>();

  for (const [index, descriptor] of descriptors.entries()) {
    const label = `WASIX extension descriptor ${index}`;
    validateDescriptor(descriptor, label);
    if (rootSqlNames.has(descriptor.sqlName)) {
      throw new Error(`WASIX extension descriptors repeat root SQL name '${descriptor.sqlName}'`);
    }
    rootSqlNames.add(descriptor.sqlName);
    selectedSqlNames.push(descriptor.sqlName);

    for (const carrier of descriptor.carriers) {
      const archiveOwner = sqlNameByArchive.get(carrier.archive);
      if (archiveOwner !== undefined && archiveOwner !== carrier.sqlName) {
        throw new Error(
          `WASIX extension carriers '${archiveOwner}' and '${carrier.sqlName}' conflict on archive '${carrier.archive}'`,
        );
      }
      sqlNameByArchive.set(carrier.archive, carrier.sqlName);

      const existing = carrierBySqlName.get(carrier.sqlName);
      if (existing === undefined) {
        carrierBySqlName.set(carrier.sqlName, {
          carrier,
          compatibility: descriptor.compatibility,
        });
      } else if (
        !sameCarrierIdentity(existing.carrier, carrier) ||
        !structurallyEqual(existing.compatibility, descriptor.compatibility)
      ) {
        throw new Error(
          `WASIX extension carrier '${carrier.sqlName}' has conflicting identity, install, or compatibility metadata`,
        );
      }
    }
  }

  return {
    selectedSqlNames: selectedSqlNames.sort(),
    carriers: Object.fromEntries(
      [...carrierBySqlName]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([sqlName, { carrier, compatibility }]) => [
          sqlName,
          serializeCarrier(carrier, compatibility),
        ]),
    ),
  };
}

function validateDescriptor(
  value: unknown,
  label: string,
): asserts value is WasixExtensionDescriptorInput {
  const descriptor = requireExactObject(value, DESCRIPTOR_FIELDS, label);
  if (descriptor.schema !== 'oliphaunt-wasix-extension-v1') {
    throw new Error(`${label} has unsupported schema`);
  }
  if (descriptor.runtime !== 'wasix') {
    throw new Error(`${label} must target runtime 'wasix'`);
  }
  const product = requireProduct(descriptor.product, `${label} product`);
  const version = requireVersion(descriptor.version, `${label} version`);
  const sqlName = requireSqlName(descriptor.sqlName, `${label} SQL name`);
  validateCompatibility(descriptor.compatibility, `${label} compatibility`);
  if (!Array.isArray(descriptor.carriers) || descriptor.carriers.length === 0) {
    throw new Error(`${label} carriers must be a non-empty array`);
  }

  let root: WasixExtensionCarrier | undefined;
  const carrierSqlNames = new Set<string>();
  const carrierSqlNameByArchive = new Map<string, string>();
  const carrierBySqlName = new Map<string, WasixExtensionCarrier>();
  for (const [index, carrier] of descriptor.carriers.entries()) {
    validateCarrier(carrier, `${label} carrier ${index}`);
    if (carrierSqlNames.has(carrier.sqlName)) {
      throw new Error(`${label} repeats carrier SQL name '${carrier.sqlName}'`);
    }
    carrierSqlNames.add(carrier.sqlName);
    carrierBySqlName.set(carrier.sqlName, carrier);
    const archiveOwner = carrierSqlNameByArchive.get(carrier.archive);
    if (archiveOwner !== undefined) {
      throw new Error(
        `${label} carriers '${archiveOwner}' and '${carrier.sqlName}' conflict on archive '${carrier.archive}'`,
      );
    }
    carrierSqlNameByArchive.set(carrier.archive, carrier.sqlName);
    if (carrier.sqlName === sqlName) {
      root = carrier;
    }
  }
  if (root === undefined) {
    throw new Error(`${label} carriers do not contain root SQL name '${sqlName}'`);
  }
  if (root.product !== product || root.version !== version) {
    throw new Error(`${label} product and version must match its root carrier '${sqlName}'`);
  }
  validateExactDescriptorClosure(carrierBySqlName, sqlName, label);
}

function validateCompatibility(
  value: unknown,
  label: string,
): asserts value is WasixExtensionCompatibility {
  const compatibility = requireExactObject(value, COMPATIBILITY_FIELDS, label);
  if (compatibility.extensionRuntimeContract !== EXTENSION_RUNTIME_CONTRACT) {
    throw new Error(`${label} has an unsupported extension runtime contract`);
  }
  const postgresMajor = requireString(compatibility.postgresMajor, `${label} PostgreSQL major`);
  if (!POSTGRES_MAJOR.test(postgresMajor)) {
    throw new Error(`${label} PostgreSQL major must be a positive integer string`);
  }
  if (compatibility.wasixRuntimeProduct !== 'liboliphaunt-wasix') {
    throw new Error(`${label} WASIX runtime product must be 'liboliphaunt-wasix'`);
  }
  requireVersion(compatibility.wasixRuntimeVersion, `${label} WASIX runtime version`);
}

function validateCarrier(value: unknown, label: string): asserts value is WasixExtensionCarrier {
  const carrier = requireExactObject(value, CARRIER_FIELDS, label);
  requireProduct(carrier.product, `${label} product`);
  requireVersion(carrier.version, `${label} version`);
  const sqlName = requireSqlName(carrier.sqlName, `${label} SQL name`);
  const archive = requireExtensionArchive(carrier.archive, `${label} archive`);
  if (archive !== `extensions/${sqlName}.tar.zst`) {
    throw new Error(`${label} archive must be extensions/${sqlName}.tar.zst`);
  }
  requireSha256(carrier.sha256, `${label} SHA-256`);
  const size = requireSize(carrier.size, `${label} size`);
  requireAssetSource(carrier.source, `${label} source`, size, 'carrier');
  validateInstall(carrier.install, `${label} install`, sqlName);
}

function validateInstall(
  value: unknown,
  label: string,
  sqlName: string,
): asserts value is WasixExtensionInstall {
  const install = requireExactObject(value, INSTALL_FIELDS, label);
  if (install.schema !== 'oliphaunt-wasix-extension-install-v1') {
    throw new Error(`${label} has unsupported schema`);
  }
  requireString(install.name, `${label} name`);
  if (install.nativeModule !== null) {
    requireSafeRelativeAssetPath(install.nativeModule, `${label} native module`);
  }
  if (!Array.isArray(install.nativeModules)) {
    throw new Error(`${label} native modules must be an array`);
  }
  install.nativeModules.forEach((module, index) => {
    validateNativeModule(module, `${label} native module ${index}`);
  });
  requireUnique(
    install.nativeModules.map((module) => module.name),
    `${label} native module names`,
  );
  requireUnique(
    install.nativeModules.map((module) => module.path),
    `${label} native module paths`,
  );
  if ((install.nativeModule === null) !== (install.nativeModules.length === 0)) {
    throw new Error(`${label} nativeModule must be null exactly when nativeModules is empty`);
  }
  const dependencies = requireUniqueSqlNameArray(install.dependencies, `${label} dependencies`);
  if (dependencies.includes(sqlName)) {
    throw new Error(`${label} dependencies must not include its own SQL name '${sqlName}'`);
  }
  requireUniqueStringArray(install.coreExportsRequired, `${label} core exports required`);
  const loadOrder = requireUniquePathArray(install.loadOrder, `${label} load order`);
  validateLifecycle(install.lifecycle, `${label} lifecycle`);
  const installedFiles = requireUniquePathArray(install.installedFiles, `${label} installed files`);
  for (const module of install.nativeModules) {
    if (!installedFiles.includes(module.path)) {
      throw new Error(`${label} native module path is absent from installedFiles: ${module.path}`);
    }
  }
  for (const path of loadOrder) {
    if (!installedFiles.includes(path)) {
      throw new Error(`${label} load-order path is absent from installedFiles: ${path}`);
    }
  }
  if (!Array.isArray(install.unresolvedImports)) {
    throw new Error(`${label} unresolved imports must be an array`);
  }
  install.unresolvedImports.forEach((entry, index) => {
    validateImport(entry, `${label} unresolved import ${index}`);
  });
}

function validateImport(value: unknown, label: string): asserts value is WasixExtensionImport {
  const entry = requireExactObject(value, IMPORT_FIELDS, label);
  requireString(entry.module, `${label} module`);
  requireString(entry.name, `${label} name`);
  requireString(entry.kind, `${label} kind`);
}

function validateNativeModule(
  value: unknown,
  label: string,
): asserts value is WasixExtensionNativeModule {
  const module = requireExactObject(value, NATIVE_MODULE_FIELDS, label);
  requireString(module.name, `${label} name`);
  requireSafeRelativeAssetPath(module.path, `${label} path`);
  requireSha256(module.sha256, `${label} SHA-256`);
  requireSha256(module.moduleSha256, `${label} module SHA-256`);
  requireSize(module.size, `${label} size`);
}

function validateLifecycle(
  value: unknown,
  label: string,
): asserts value is WasixExtensionLifecycle {
  const lifecycle = requireExactObject(value, LIFECYCLE_FIELDS, label);
  for (const field of [
    'createExtension',
    'preloadRequired',
    'restartRequired',
    'sharedMemoryRequired',
  ] as const) {
    if (typeof lifecycle[field] !== 'boolean') {
      throw new Error(`${label} ${field} must be a boolean`);
    }
  }
  if (lifecycle.createSchema !== null) {
    requireString(lifecycle.createSchema, `${label} createSchema`);
  }
  for (const field of ['loadSql', 'postCreateSql', 'startupConfig'] as const) {
    requireUniqueStringArray(lifecycle[field], `${label} ${field}`);
  }
}

function serializeCarrier(
  carrier: WasixExtensionCarrier,
  compatibility: WasixExtensionCompatibility,
): SerializedExtensionCarrier {
  return {
    product: carrier.product,
    version: carrier.version,
    sqlName: carrier.sqlName,
    archive: carrier.archive,
    sha256: carrier.sha256,
    size: carrier.size,
    source: serializeAssetSource(carrier.source),
    compatibility: { ...compatibility },
    install: {
      schema: carrier.install.schema,
      name: carrier.install.name,
      nativeModule: carrier.install.nativeModule,
      nativeModules: [...carrier.install.nativeModules],
      dependencies: [...carrier.install.dependencies],
      coreExportsRequired: [...carrier.install.coreExportsRequired],
      loadOrder: [...carrier.install.loadOrder],
      lifecycle: {
        ...carrier.install.lifecycle,
        loadSql: [...carrier.install.lifecycle.loadSql],
        postCreateSql: [...carrier.install.lifecycle.postCreateSql],
        startupConfig: [...carrier.install.lifecycle.startupConfig],
      },
      installedFiles: [...carrier.install.installedFiles],
      unresolvedImports: carrier.install.unresolvedImports.map((entry) => ({
        ...entry,
      })),
    },
  };
}

function freezeCarrier(carrier: WasixExtensionCarrier): WasixExtensionCarrier {
  const lifecycle = carrier.install.lifecycle;
  return Object.freeze({
    ...carrier,
    install: Object.freeze({
      ...carrier.install,
      nativeModules: Object.freeze(
        carrier.install.nativeModules.map((module) => Object.freeze({ ...module })),
      ),
      dependencies: Object.freeze([...carrier.install.dependencies]),
      coreExportsRequired: Object.freeze([...carrier.install.coreExportsRequired]),
      loadOrder: Object.freeze([...carrier.install.loadOrder]),
      lifecycle: Object.freeze({
        ...lifecycle,
        loadSql: Object.freeze([...lifecycle.loadSql]),
        postCreateSql: Object.freeze([...lifecycle.postCreateSql]),
        startupConfig: Object.freeze([...lifecycle.startupConfig]),
      }),
      installedFiles: Object.freeze([...carrier.install.installedFiles]),
      unresolvedImports: Object.freeze(
        carrier.install.unresolvedImports.map((entry) => Object.freeze({ ...entry })),
      ),
    }),
  });
}

function requireProduct(value: unknown, label: string): string {
  const product = requireString(value, label);
  if (!PRODUCT.test(product)) {
    throw new Error(`${label} must be an Oliphaunt extension product id`);
  }
  return product;
}

function requireSqlName(value: unknown, label: string): string {
  const sqlName = requireString(value, label);
  if (!SQL_NAME.test(sqlName)) {
    throw new Error(`${label} must be a portable PostgreSQL extension name`);
  }
  return sqlName;
}

function requireExtensionArchive(value: unknown, label: string): string {
  const archive = requireSafeRelativeAssetPath(value, label);
  if (!archive.startsWith('extensions/')) {
    throw new Error(`${label} must be a safe relative path under extensions/`);
  }
  return archive;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${label} entry ${index}`));
}

function requireUniqueSqlNameArray(value: unknown, label: string): string[] {
  const values = requireStringArray(value, label).map((entry, index) =>
    requireSqlName(entry, `${label} entry ${index}`),
  );
  requireUnique(values, label);
  return values;
}

function requireUniqueStringArray(value: unknown, label: string): string[] {
  const values = requireStringArray(value, label);
  requireUnique(values, label);
  return values;
}

function requireUniquePathArray(value: unknown, label: string): string[] {
  const values = requireStringArray(value, label).map((path, index) =>
    requireSafeRelativeAssetPath(path, `${label} entry ${index}`),
  );
  requireUnique(values, label);
  return values;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not repeat values`);
  }
}

function validateExactDescriptorClosure(
  carriers: ReadonlyMap<string, WasixExtensionCarrier>,
  rootSqlName: string,
  label: string,
): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (sqlName: string): void => {
    if (visited.has(sqlName)) {
      return;
    }
    if (visiting.has(sqlName)) {
      throw new Error(`${label} has cyclic carrier dependencies involving '${sqlName}'`);
    }
    const carrier = carriers.get(sqlName);
    if (carrier === undefined) {
      return;
    }
    visiting.add(sqlName);
    for (const dependency of carrier.install.dependencies) {
      if (carriers.has(dependency)) {
        visit(dependency);
      }
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
  };
  visit(rootSqlName);
  const unexpected = [...carriers.keys()].filter((sqlName) => !visited.has(sqlName)).sort();
  if (unexpected.length > 0) {
    throw new Error(
      `${label} carriers must be the exact dependency closure for '${rootSqlName}'; unexpected ${unexpected.join(', ')}`,
    );
  }
}

function sameCarrierIdentity(left: WasixExtensionCarrier, right: WasixExtensionCarrier): boolean {
  return (
    left.product === right.product &&
    left.version === right.version &&
    left.sqlName === right.sqlName &&
    left.archive === right.archive &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    structurallyEqual(left.install, right.install)
  );
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
