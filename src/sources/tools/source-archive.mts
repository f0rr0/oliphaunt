import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import {
  portableMemberName,
  readSourceArchiveEntries,
} from '../../shared/artifact-packaging/portable-archive.mts';

export function sourceArchiveEntries(archive: string, prefix: string) {
  const size = lstatSync(archive).size;
  const limits = {
    maxEntries: 200_000,
    maxArchiveBytes: 1024 ** 3,
    maxEntryBytes: 2 * 1024 ** 3,
    maxExpandedBytes: Math.min(4 * 1024 ** 3, Math.max(64 * 1024 ** 2, size * 200)),
  };
  const zip = archive.endsWith('.zip');
  assert(
    (zip && prefix === '.') ||
      (portableMemberName(prefix, 'file', archive) === prefix && !prefix.includes('/')),
    'strip prefix must be one portable top-level directory',
  );
  // ponytail: pinned source tarballs use V7/ustar; add PAX only when a source pin needs it.
  const entries = readSourceArchiveEntries(archive, limits);
  const relative = (name: string) => {
    if (prefix === '.') return name;
    assert(
      name === prefix || name.startsWith(`${prefix}/`),
      `source member ${name} is outside required root ${prefix}`,
    );
    return name === prefix ? '' : name.slice(prefix.length + 1);
  };
  const portable = new Set<string>();
  const members = [...entries.values()].map((entry) => {
    const name = relative(entry.name);
    assert(
      !['.git', '.oliphaunt-source-pin'].includes(name.split('/')[0]),
      'reserved source-spine path',
    );
    const key = name.normalize('NFC').toUpperCase().toLowerCase();
    assert(!portable.has(key), `source paths collide on a portable filesystem: ${name}`);
    portable.add(key);
    if (name === '') assert(entry.isDirectory, 'archive root must be a directory');
    let target: string | undefined;
    if (entry.type === 'symlink' || entry.type === 'hardlink') {
      const link = entry.linkTarget;
      assert(
        typeof link === 'string' &&
          link &&
          !/[\\\u0000-\u001f\u007f]/.test(link) &&
          !posix.isAbsolute(link) &&
          !/^[A-Za-z]:/.test(link),
        `unsafe source link ${entry.name}`,
      );
      const resolved = posix.normalize(
        entry.type === 'symlink' ? posix.join(posix.dirname(entry.name), link) : link,
      );
      portableMemberName(resolved, 'file', archive);
      target = relative(resolved);
      assert(
        target && entries.has(resolved),
        `source link ${entry.name} has a missing or escaping target`,
      );
      if (entry.type === 'hardlink')
        assert(entries.get(resolved)?.isFile, `hard link ${entry.name} must target a regular file`);
    }
    return { ...entry, relative: name, target };
  });
  return members;
}

export function extractSourceArchive(archive: string, prefix: string, destination: string) {
  const members = sourceArchiveEntries(archive, prefix);
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination, { mode: 0o755 }); // Exclusive: never remove or overwrite a caller's existing checkout.
  try {
    const parent = (name: string) => {
      const directory = dirname(join(destination, name));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      return join(destination, name);
    };
    // Create links last, so no archive path can be written through a link.
    for (const entry of members) {
      if (!entry.relative || !['file', 'directory'].includes(entry.type)) continue;
      const output = parent(entry.relative);
      if (entry.isDirectory) mkdirSync(output, { recursive: true, mode: 0o755 });
      else {
        writeFileSync(output, entry.data(), { flag: 'wx', mode: (entry.mode & 0o755) | 0o600 });
        chmodSync(output, (entry.mode & 0o755) | 0o600);
      }
    }
    for (const entry of members)
      if (entry.type === 'hardlink')
        linkSync(join(destination, entry.target!), parent(entry.relative));
    for (const entry of members)
      if (entry.type === 'symlink') symlinkSync(entry.linkTarget, parent(entry.relative));
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    const [mode, archive, prefix, destination, extra] = Bun.argv.slice(2);
    assert(
      archive &&
        prefix &&
        !extra &&
        ((mode === 'validate' && !destination) || (mode === 'extract' && destination)),
      'usage: source-archive.mts validate|extract ARCHIVE PREFIX [DESTINATION]',
    );
    if (mode === 'validate') sourceArchiveEntries(archive, prefix);
    else extractSourceArchive(archive, prefix, destination);
  } catch (error) {
    console.error(`unsafe source archive: ${error.message}`);
    process.exitCode = 1;
  }
}
