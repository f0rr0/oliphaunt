/** Bounded identities for exact declared Files, independent of release discovery. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';

export function safeRelative(value: string) {
  if (
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.normalize('NFC') !== value ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe native staging path: ${JSON.stringify(value)}`);
  return value;
}

export function fileIdentity(file: string, destination?: string) {
  requireSafeDirectoryChain(path.dirname(file), { label: 'native output' });
  const source = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let target;
  try {
    const before = fstatSync(source);
    if (!before.isFile()) throw new Error(`native output must be a regular file: ${file}`);
    if (destination !== undefined) {
      requireSafeDirectoryChain(path.dirname(destination), { create: true, label: 'native stage' });
      target = openSync(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (!count) break;
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      size += count;
      if (target !== undefined) {
        let offset = 0;
        while (offset < count) offset += writeSync(target, bytes, offset, count - offset);
      }
    }
    const after = fstatSync(source);
    const named = lstatSync(file);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      [after, named].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== size ||
          stat.mode !== before.mode ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs,
      )
    )
      throw new Error(`native output changed while being read: ${file}`);
    if (destination !== undefined) chmodSync(destination, before.mode & 0o777);
    return { type: 'file', mode: before.mode & 0o777, size, sha256: hash.digest('hex') };
  } finally {
    closeSync(source);
    if (target !== undefined) closeSync(target);
  }
}

/** Copy an exact declared input with the bounded reader, retaining its captured link identity. */
export function copyNativeInputFile(executionRoot: string, input: string, destination: string) {
  if (!path.isAbsolute(executionRoot ?? ''))
    throw new Error('native input requires the captured absolute executionRoot');
  const root = realpathSync(executionRoot);
  const declared = path.join(root, safeRelative(input));
  const physical = realpathSync(declared);
  const identity = fileIdentity(physical, destination);
  if (realpathSync(declared) !== physical)
    throw new Error('native input path changed while being copied');
  return identity;
}
