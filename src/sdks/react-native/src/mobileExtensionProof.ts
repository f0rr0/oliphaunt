import type { PackageSizeReport } from './client';
import {
  GENERATED_EXTENSION_METADATA,
  GENERATED_EXTENSION_METADATA_SHA256,
  type GeneratedExtensionMetadata,
} from './generated/extensions';

export const MOBILE_RELEASE_EXTENSION_PROOF_COUNT = GENERATED_EXTENSION_METADATA.filter(
  (extension) => extension.mobileReleaseReady,
).length;
export const MOBILE_RELEASE_EXTENSION_CATALOG_SHA256 = GENERATED_EXTENSION_METADATA_SHA256;

export type MobileReleasePlatform = 'android' | 'ios';

export type MobileReleaseExtensionProof = {
  readonly sqlName: string;
  readonly createsExtension: boolean;
  readonly nativeModuleStem: string | null;
  readonly selectedExtensionDependencies: readonly string[];
  readonly activationSql: readonly string[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new Error(`${label} contains duplicate ${sorted[index]}`);
    }
  }
  return sorted;
}

function assertExact(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = sortedUnique(actual, label);
  const expectedSorted = sortedUnique(expected, `expected ${label}`);
  if (actualSorted.length !== expectedSorted.length) {
    throw new Error(
      `${label} count mismatch: expected ${expectedSorted.length}, got ${actualSorted.length}; ` +
        `expected=${expectedSorted.join(',')}; actual=${actualSorted.join(',')}`,
    );
  }
  for (let index = 0; index < expectedSorted.length; index += 1) {
    if (actualSorted[index] !== expectedSorted[index]) {
      throw new Error(
        `${label} mismatch: expected=${expectedSorted.join(',')}; actual=${actualSorted.join(',')}`,
      );
    }
  }
}

function supportsPlatform(
  extension: GeneratedExtensionMetadata,
  platform: MobileReleasePlatform,
): boolean {
  const status = extension.support.mobile?.[platform];
  // `mobileReleaseReady` is the canonical family-level release decision. The
  // optional per-platform table only narrows that decision when it explicitly
  // marks Android or iOS unsupported; an absent entry inherits family support.
  return extension.mobileReleaseReady && (status === undefined || status === 'supported');
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new Error(`generated extension SQL name is not a canonical identifier: ${value}`);
  }
  return `"${value}"`;
}

function activationSql(extension: GeneratedExtensionMetadata): readonly string[] {
  if (extension.createsExtension) {
    return [`CREATE EXTENSION ${quoteIdentifier(extension.sqlName)}`];
  }
  if (extension.sqlName === 'auto_explain') {
    return [
      "LOAD 'auto_explain'",
      "SET auto_explain.log_min_duration = '0'",
      "SET auto_explain.log_analyze = 'true'",
      "SET auto_explain.log_level = 'NOTICE'",
    ];
  }
  throw new Error(
    `generated mobile release extension ${extension.sqlName} does not create an extension and has no activation proof`,
  );
}

function canonicalPlatformRows(platform: MobileReleasePlatform): GeneratedExtensionMetadata[] {
  const rows = GENERATED_EXTENSION_METADATA.filter((extension) =>
    supportsPlatform(extension, platform),
  );
  if (rows.length === 0)
    throw new Error(`${platform} generated mobile release extension set is empty`);
  sortedUnique(
    rows.map((extension) => extension.sqlName),
    `${platform} generated mobile release extension names`,
  );
  return rows;
}

function dependencyOrderedRows(
  rows: readonly GeneratedExtensionMetadata[],
): GeneratedExtensionMetadata[] {
  const byName = new Map(rows.map((row) => [row.sqlName, row]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: GeneratedExtensionMetadata[] = [];

  const visit = (row: GeneratedExtensionMetadata): void => {
    if (visited.has(row.sqlName)) return;
    if (visiting.has(row.sqlName)) {
      throw new Error(`generated mobile extension dependency cycle includes ${row.sqlName}`);
    }
    visiting.add(row.sqlName);
    for (const dependencyName of row.selectedExtensionDependencies) {
      const dependency = byName.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `generated mobile extension ${row.sqlName} depends on absent release extension ${dependencyName}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(row.sqlName);
    visited.add(row.sqlName);
    ordered.push(row);
  };

  for (const row of [...rows].sort((left, right) => compareText(left.sqlName, right.sqlName))) {
    visit(row);
  }
  return ordered;
}

/**
 * Produces the installed-app extension proof only after the native package
 * report exactly matches the generated mobile release catalog. This is
 * intentionally fail-closed: missing metadata, pending static registration,
 * omitted SQL-only resources, extra carriers, and dependency drift all stop
 * the smoke before it can report success.
 */
export function mobileReleaseExtensionProofPlan(
  packageSize: PackageSizeReport | null,
  platform: MobileReleasePlatform,
): readonly MobileReleaseExtensionProof[] {
  if (packageSize === null) {
    throw new Error(`${platform} installed app did not return a package-size report`);
  }
  if (packageSize.mobileStaticRegistryState !== 'complete') {
    throw new Error(
      `${platform} mobile static registry is not complete: ${packageSize.mobileStaticRegistryState ?? 'missing'}`,
    );
  }
  if (packageSize.mobileStaticRegistryPending.length !== 0) {
    throw new Error(
      `${platform} mobile static registry has pending extensions: ${packageSize.mobileStaticRegistryPending.join(',')}`,
    );
  }

  const rows = canonicalPlatformRows(platform);
  const expectedNames = rows.map((row) => row.sqlName);
  const expectedRegistered = rows
    .filter((row) => row.nativeModuleStem !== null)
    .map((row) => row.sqlName);
  const expectedStems = rows.flatMap((row) =>
    row.nativeModuleStem === null ? [] : [row.nativeModuleStem],
  );

  assertExact(
    packageSize.extensions.map((extension) => extension.name),
    expectedNames,
    `${platform} packaged extension resources`,
  );
  assertExact(
    packageSize.mobileStaticRegistryRegistered,
    expectedRegistered,
    `${platform} registered native extension modules`,
  );
  assertExact(
    packageSize.nativeModuleStems,
    expectedStems,
    `${platform} packaged native module stems`,
  );

  const rowsBySqlName = new Map(rows.map((row) => [row.sqlName, row]));
  for (const extension of packageSize.extensions) {
    const row = rowsBySqlName.get(extension.name);
    if (row === undefined) {
      throw new Error(`${platform} packaged extension ${extension.name} is absent from generated metadata`);
    }
    const isFullyRegisteredStaticModuleOnly =
      !row.createsExtension &&
      row.nativeModuleStem !== null &&
      row.dataFiles.length === 0 &&
      row.runtimeShareDataFiles.length === 0 &&
      row.extensionSqlFileNames.length === 0 &&
      row.extensionSqlFilePrefixes.length === 0 &&
      packageSize.mobileStaticRegistryRegistered.includes(row.sqlName) &&
      packageSize.nativeModuleStems.includes(row.nativeModuleStem);
    const isValidEmptyStaticModuleReport =
      isFullyRegisteredStaticModuleOnly && extension.fileCount === 0 && extension.bytes === 0;
    const isValidResourceReport =
      Number.isInteger(extension.fileCount) &&
      extension.fileCount > 0 &&
      Number.isInteger(extension.bytes) &&
      extension.bytes > 0;
    if (!isValidEmptyStaticModuleReport && !isValidResourceReport) {
      throw new Error(
        `${platform} packaged extension ${extension.name} has invalid resource size: ` +
          `files=${extension.fileCount}, bytes=${extension.bytes}`,
      );
    }
  }
  if (packageSize.selectedExtensionBytes <= 0) {
    throw new Error(`${platform} installed app reports no packaged extension bytes`);
  }

  return dependencyOrderedRows(rows).map((row) => ({
    sqlName: row.sqlName,
    createsExtension: row.createsExtension,
    nativeModuleStem: row.nativeModuleStem,
    selectedExtensionDependencies: row.selectedExtensionDependencies,
    activationSql: activationSql(row),
  }));
}
