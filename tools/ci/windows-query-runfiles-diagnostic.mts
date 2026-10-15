import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const [executionRoot, executableFile, archiveFile, archiveShortPath] = process.argv.slice(2);
assert(executionRoot && executableFile && archiveFile && archiveShortPath);
assert(isAbsolute(executionRoot), 'Bazel execution_root must be absolute');
assert(executableFile.endsWith('.exe'), 'cquery must return the Windows test executable');
assert(archiveFile.endsWith('.crate'), 'cquery must return the declared source archive');
assert(!isAbsolute(archiveShortPath) && !archiveShortPath.startsWith('../'));

const executable = resolve(executionRoot, executableFile);
const declaredArchive = resolve(executionRoot, archiveFile);
const runfiles = `${executable}.runfiles`;
const logicalArchive = `_main/${archiveShortPath.replaceAll('\\', '/')}`;
const projectedArchive = join(runfiles, logicalArchive);
const maxBytes = 16 * 1024 * 1024;

function failure(error: unknown) {
  const value = error as NodeJS.ErrnoException;
  return { name: value.name, code: value.code, errno: value.errno, syscall: value.syscall };
}

function capture(operation: () => unknown) {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function metadata(value: Stats) {
  return {
    file: value.isFile(),
    directory: value.isDirectory(),
    symlink: value.isSymbolicLink(),
    size: value.size,
    mode: value.mode.toString(8),
    nlink: value.nlink,
  };
}

function bytes(path: string) {
  const descriptor = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (size < maxBytes) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes - size), null);
      if (count === 0) return { size, sha256: hash.digest('hex'), complete: true };
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    return {
      size,
      sha256: hash.digest('hex'),
      complete: readSync(descriptor, buffer, 0, 1, null) === 0,
    };
  } finally {
    closeSync(descriptor);
  }
}

async function probe(label: string, path: string, readBytes: boolean) {
  let asyncRealpath;
  try {
    asyncRealpath = { ok: true, value: await realpath(path) };
  } catch (error) {
    asyncRealpath = { ok: false, error: failure(error) };
  }
  console.log(
    JSON.stringify({
      label,
      path,
      lstat: capture(() => metadata(lstatSync(path))),
      stat: capture(() => metadata(statSync(path))),
      readlink: capture(() => readlinkSync(path)),
      realpathSync: capture(() => realpathSync(path)),
      realpathNative: capture(() => realpathSync.native(path)),
      realpathAsync: asyncRealpath,
      ...(readBytes ? { bytes: capture(() => bytes(path)) } : {}),
    }),
  );
}

function decodeManifest(value: string) {
  return value.replace(/\\([snb])/g, (_, escaped: string) =>
    escaped === 's' ? ' ' : escaped === 'n' ? '\n' : '\\',
  );
}

console.log(
  JSON.stringify({
    runtime: { node: process.versions.node, bun: process.versions.bun },
    runfiles,
    logicalArchive,
  }),
);
await probe('runfiles root', runfiles, false);
await probe('archive parent', dirname(projectedArchive), false);
await probe('projected archive', projectedArchive, true);
await probe('declared archive', declaredArchive, true);

for (const manifest of [join(runfiles, 'MANIFEST'), `${executable}.runfiles_manifest`]) {
  const result = capture(() => {
    assert(statSync(manifest).size <= maxBytes, 'diagnostic manifest exceeds 16 MiB');
    const rows = [];
    for (const line of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
      const escaped = line.startsWith(' ');
      const record = escaped ? line.slice(1) : line;
      const separator = record.indexOf(' ');
      const key = separator === -1 ? record : record.slice(0, separator);
      if ((escaped ? decodeManifest(key) : key) !== logicalArchive) continue;
      assert(
        rows.length < 1 && line.length <= 8192,
        'unexpected duplicate or oversized archive entry',
      );
      const target = separator === -1 ? key : record.slice(separator + 1);
      rows.push({ record: line, target: escaped ? decodeManifest(target) : target });
    }
    return rows;
  });
  console.log(JSON.stringify({ manifest, archiveEntry: result }));
  if (result.ok && Array.isArray(result.value)) {
    for (const row of result.value) {
      if (row.target) await probe('manifest physical archive', row.target, true);
    }
  }
}
