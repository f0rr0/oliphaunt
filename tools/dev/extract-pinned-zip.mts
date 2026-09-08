import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readPortableArchiveEntries } from '../../src/shared/artifact-packaging/portable-archive.mts';

export function extractPinnedZip(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      archive: { type: 'string' },
      destination: { type: 'string' },
      prefix: { type: 'string', default: '' },
      'entry-count': { type: 'string' },
      required: { type: 'string', multiple: true },
      executable: { type: 'string', multiple: true },
    },
  });
  const { archive, destination, prefix, required = [], executable = [] } = values;
  const count = Number(values['entry-count']);
  if (
    !archive ||
    !destination ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    !required.length ||
    !executable.length
  ) {
    throw new Error(
      'archive, destination, entry-count (1..4096), required and executable are required',
    );
  }
  const entries = [
    ...readPortableArchiveEntries(archive, {
      format: 'zip',
      maxArchiveBytes: 220_000_000,
      maxExpandedBytes: 400_000_000,
      maxEntryBytes: 150_000_000,
      maxEntries: 4096,
    }).values(),
  ];
  if (entries.length !== count)
    throw new Error(`archive entry count mismatch: expected ${count}, got ${entries.length}`);
  for (const entry of entries) {
    if (
      /[^\x20-\x7e]/u.test(entry.name) ||
      (prefix && entry.name !== prefix && !entry.name.startsWith(`${prefix}/`))
    ) {
      throw new Error(`archive path is outside the pinned layout: ${entry.name}`);
    }
  }
  for (const name of new Set([...required, ...executable])) {
    const entry = entries.find((entry) => entry.name === name);
    if (!entry?.isFile || !entry.size)
      throw new Error(`required archive path is not a non-empty regular file: ${name}`);
  }
  // Create exclusively: a rejected existing destination must never be removed.
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const target = path.join(destination, entry.name);
      mkdirSync(entry.isDirectory ? target : path.dirname(target), {
        recursive: true,
        mode: 0o755,
      });
      if (entry.isFile) {
        const mode = executable.includes(entry.name) ? 0o755 : 0o644;
        writeFileSync(target, entry.data(), { flag: 'wx', mode });
        chmodSync(target, mode);
      }
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    extractPinnedZip(process.argv.slice(2));
  } catch (error) {
    console.error(`pinned ZIP validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
