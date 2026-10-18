import { optionRecord, positiveInteger } from '@oliphaunt/ts-query/internal/resource-options';

/** Acceptance limits, not eager allocations or a bound on total process memory. */
export type ArchiveLimits = Readonly<{
  /** Complete uncompressed TAR bytes, including headers and padding. */
  maxArchiveBytes?: number;
  maxEntryBytes?: number;
  /** Includes directory and TAR metadata entries. */
  maxEntries?: number;
  /** UTF-8 bytes of one normalized relative path. */
  maxPathBytes?: number;
  maxPathDepth?: number;
}>;

export const PACKAGE_ARCHIVE_LIMITS: Required<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxEntries: 65_536,
  maxPathBytes: 1_024,
  maxPathDepth: 64,
});

// Separate ownership: package ceilings must not silently redefine physical backup capacity.
export const PHYSICAL_ARCHIVE_LIMITS: Required<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxEntries: 65_536,
  maxPathBytes: 1_024,
  maxPathDepth: 64,
});

export function normalizeArchiveLimits(
  value: unknown,
  defaults: Required<ArchiveLimits> = PHYSICAL_ARCHIVE_LIMITS,
): Required<ArchiveLimits> {
  if (value === undefined) return { ...defaults };
  const options = optionRecord(value, Object.keys(defaults), 'archiveLimits');
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      options[key] === undefined ? fallback : positiveInteger(options[key], `archiveLimits.${key}`),
    ]),
  ) as Required<ArchiveLimits>;
}

export function checkArchiveLimit(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value > maximum)
    throw new Error(`${label} exceeds the ${maximum} limit`);
}

/** Snapshot call options before any archive or storage work. Empty options preserve host defaults. */
export function physicalArchiveOptions(value: unknown): Required<ArchiveLimits> | undefined {
  if (value === undefined) return undefined;
  const options = optionRecord(value, ['archiveLimits'], 'physical archive options');
  return options.archiveLimits === undefined
    ? undefined
    : normalizeArchiveLimits(options.archiveLimits);
}
