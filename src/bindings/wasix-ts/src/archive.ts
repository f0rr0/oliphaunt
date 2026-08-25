import { readPackageAsset } from './asset-source.js';
import type { SerializedAssetSource } from './rpc.js';
import { decompressZstd } from './zstd.js';

export type DirectoryFiles = Record<string, Uint8Array>;

export type ExtractedArchive = {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
};

export type WasixDirectoryMount = {
  files: DirectoryFiles;
  directories: string[];
};

export type WasixRuntimeLayout = {
  module: Uint8Array;
  mounts: Record<string, WasixDirectoryMount>;
};

const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 65_536;
const MAX_PATH_BYTES = 1_024;
const MAX_PATH_DEPTH = 64;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function extractTar(archive: Uint8Array): ExtractedArchive {
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`tar archive exceeds the ${MAX_ARCHIVE_BYTES}-byte extraction limit`);
  }
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const explicitPaths = new Set<string>();
  let offset = 0;
  let nextPax: Record<string, string> | undefined;
  let globalPax: Record<string, string> = {};
  let nextLongName: string | undefined;
  let entries = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(header)) {
      if (nextPax !== undefined || nextLongName !== undefined) {
        throw new Error('tar archive ends with dangling per-entry path metadata');
      }
      if (
        offset + BLOCK_SIZE > archive.length ||
        !isZeroBlock(archive.subarray(offset, offset + BLOCK_SIZE)) ||
        archive.subarray(offset + BLOCK_SIZE).some((byte) => byte !== 0)
      ) {
        throw new Error('tar archive has an invalid terminator');
      }
      return { files, directories };
    }

    validateTarHeaderFormat(header);
    entries += 1;
    if (entries > MAX_ENTRIES)
      throw new Error(`tar archive exceeds the ${MAX_ENTRIES}-entry limit`);
    const type = String.fromCharCode(header[156] ?? 0).replace('\0', '') || '0';
    const size = parseOctal(header.subarray(124, 136), 'tar entry size');
    if (size > MAX_ENTRY_BYTES) {
      throw new Error(`tar entry exceeds the ${MAX_ENTRY_BYTES}-byte size limit`);
    }
    const payloadEnd = offset + size;
    if (payloadEnd > archive.length) {
      throw new Error('tar archive ended in the middle of an entry payload');
    }
    const payload = archive.subarray(offset, payloadEnd);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset > archive.length) {
      throw new Error('tar archive ended in the middle of entry padding');
    }

    const linkName = decodeTarString(header.subarray(157, 257)).replace(/\0.*$/, '');
    if (linkName.length > 0) {
      throw new Error('tar archive contains a non-empty link target');
    }

    if (type === 'x') {
      if (nextPax !== undefined || nextLongName !== undefined) {
        throw new Error('tar archive repeats per-entry path metadata before an entry');
      }
      nextPax = parsePaxPayload(payload);
      validatePaxSemantics(nextPax);
      continue;
    }
    if (type === 'g') {
      const additions = parsePaxPayload(payload);
      validatePaxSemantics(additions);
      for (const key of Object.keys(additions)) {
        if (Object.hasOwn(globalPax, key)) {
          throw new Error(`tar archive repeats global pax key: ${key}`);
        }
      }
      globalPax = { ...globalPax, ...additions };
      continue;
    }
    if (type === 'L') {
      if (nextPax !== undefined || nextLongName !== undefined) {
        throw new Error('tar archive repeats per-entry path metadata before an entry');
      }
      nextLongName = decodeTarString(payload).replace(/\0+$/, '');
      continue;
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) };
    nextPax = undefined;
    if ((pax.linkpath ?? '').length > 0) {
      throw new Error('tar archive contains a non-empty pax link target');
    }
    const path = sanitizeTarPath(pax.path ?? nextLongName ?? tarHeaderPath(header));
    nextLongName = undefined;
    if (path === undefined) {
      continue;
    }
    if (explicitPaths.has(path)) {
      throw new Error(`tar archive repeats entry path: ${path}`);
    }
    explicitPaths.add(path);
    const fileAncestor = parentPaths(path).find((ancestor) => files.has(ancestor));
    if (fileAncestor !== undefined) {
      throw new Error(`tar entry ${path} is nested below file: ${fileAncestor}`);
    }
    if (type === '5') {
      if (size !== 0) {
        throw new Error(`tar directory entry has a non-empty payload: ${path}`);
      }
      if (files.has(path)) {
        throw new Error(`tar entry repeats an existing file as a directory: ${path}`);
      }
      addDirectoryWithAncestors(directories, path);
      continue;
    }
    if (type !== '0') {
      throw new Error(`unsupported tar entry type '${type}' for ${path}`);
    }
    if (directories.has(path)) {
      throw new Error(`tar archive repeats entry path: ${path}`);
    }
    files.set(path, payload);
  }

  throw new Error('tar archive is missing its two-block terminator');
}

function validateTarHeaderFormat(header: Uint8Array): void {
  const magic = decodeTarString(header.subarray(257, 263));
  const version = decodeTarString(header.subarray(263, 265));
  const posix = magic === 'ustar\0' && version === '00';
  const gnu = magic === 'ustar ' && version === ' \0';
  if (!posix && !gnu) {
    throw new Error('tar entry does not use a supported ustar header');
  }
}

function parentPaths(path: string): string[] {
  const segments = path.split('/');
  const parents: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    parents.push(segments.slice(0, length).join('/'));
  }
  return parents;
}

/** @internal Validate and project an extracted cluster seed for a `/base` mount. */
export function clusterSeedMount(clusterSeed: ExtractedArchive): WasixDirectoryMount {
  const pgdataFiles = clusterSeed.files;
  if (!pgdataFiles.has('PG_VERSION') || !pgdataFiles.has('global/pg_control')) {
    throw new Error('cluster seed is missing PG_VERSION or global/pg_control');
  }
  return {
    files: mapToDirectory(pgdataFiles),
    directories: [...clusterSeed.directories],
  };
}

/** @internal Materialize runtime support mounts without loading a cluster seed. */
export function layoutRuntimeSupport(runtime: ExtractedArchive): WasixRuntimeLayout {
  const runtimeFiles = runtime.files;
  const module = runtimeFiles.get('oliphaunt/bin/postgres');
  if (module === undefined || module.length === 0) {
    throw new Error('runtime archive is missing oliphaunt/bin/postgres');
  }

  const mounts: Record<string, WasixDirectoryMount> = {
    '/home': { files: {}, directories: ['postgres'] },
    '/tmp': { files: {}, directories: [] },
  };
  for (const [path, bytes] of runtimeFiles) {
    const relative = stripPrefix(path, 'oliphaunt/');
    const slash = relative.indexOf('/');
    if (slash <= 0) {
      continue;
    }
    const root = relative.slice(0, slash);
    const child = relative.slice(slash + 1);
    const mountPath = `/${root}`;
    let mount = mounts[mountPath];
    if (mount === undefined) {
      mount = { files: {}, directories: [] };
      mounts[mountPath] = mount;
    }
    mount.files[child] = bytes;
  }
  for (const path of runtime.directories) {
    if (path === 'oliphaunt') {
      continue;
    }
    const relative = stripPrefix(path, 'oliphaunt/');
    const slash = relative.indexOf('/');
    if (slash <= 0) {
      continue;
    }
    const root = relative.slice(0, slash);
    const child = relative.slice(slash + 1);
    const mountPath = `/${root}`;
    let mount = mounts[mountPath];
    if (mount === undefined) {
      mount = { files: {}, directories: [] };
      mounts[mountPath] = mount;
    }
    mount.directories.push(child);
  }

  if (mounts['/base'] !== undefined) {
    throw new Error('runtime archive must not provide the storage-owned /base mount');
  }

  for (const required of ['/bin', '/lib', '/share']) {
    if (mounts[required] === undefined) {
      throw new Error(`runtime archive did not produce required ${required} mount`);
    }
  }
  return { module, mounts };
}

function addDirectoryWithAncestors(directories: Set<string>, path: string): void {
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    directories.add(segments.slice(0, index).join('/'));
  }
}

export async function loadAsset(source: SerializedAssetSource, label: string): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source.startsWith('file:')) {
    return readPackageAsset(source, label);
  }
  let response: Response;
  try {
    response = await fetch(source);
  } catch (cause) {
    throw new Error(`failed to fetch ${label} from ${JSON.stringify(source)}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`failed to fetch ${label} (${response.status} ${response.statusText})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function decompressIfNeeded(bytes: Uint8Array): Uint8Array {
  const isZstd = ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
  return isZstd ? decompressZstd(bytes) : bytes;
}

function mapToDirectory(files: ReadonlyMap<string, Uint8Array>): DirectoryFiles {
  return Object.fromEntries(files);
}

function stripPrefix(path: string, prefix: string): string {
  if (!path.startsWith(prefix)) {
    throw new Error(`runtime tar entry is outside ${prefix}: ${path}`);
  }
  return path.slice(prefix.length);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function parseOctal(bytes: Uint8Array, label: string): number {
  const text = decodeTarString(bytes).replace(/\0.*$/, '').trim();
  if (text.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`${label} is not an octal tar field`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return value;
}

function tarHeaderPath(header: Uint8Array): string {
  const name = decodeTarString(header.subarray(0, 100)).replace(/\0.*$/, '');
  const prefix = decodeTarString(header.subarray(345, 500)).replace(/\0.*$/, '');
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function sanitizeTarPath(path: string): string | undefined {
  if (path.includes('\\')) {
    throw new Error(`tar entry path contains a backslash: ${path}`);
  }
  const normalized = path.replace(/^\.\/+/, '');
  if (normalized.length === 0 || normalized === '.') {
    return undefined;
  }
  if (normalized.startsWith('/')) {
    throw new Error(`tar entry path must be relative: ${path}`);
  }
  if (normalized.includes('\0')) {
    throw new Error('tar entry path contains a NUL byte');
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (textByteLength(normalized) > MAX_PATH_BYTES || segments.length > MAX_PATH_DEPTH) {
    throw new Error(`tar entry path exceeds portability limits: ${path}`);
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`tar entry path escapes the install root: ${path}`);
  }
  return segments.join('/');
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parsePaxPayload(payload: Uint8Array): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) {
      throw new Error('malformed pax header record');
    }
    const lengthText = decodeTarString(payload.subarray(offset, space));
    if (!/^[0-9]+$/.test(lengthText)) {
      throw new Error('invalid pax header record length');
    }
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error('invalid pax header record length');
    }
    const recordEnd = offset + length;
    if (recordEnd > payload.length || recordEnd <= space + 1 || payload[recordEnd - 1] !== 0x0a) {
      throw new Error('malformed pax header key/value record');
    }
    const record = decodeTarString(payload.subarray(space + 1, recordEnd));
    const equals = record.indexOf('=');
    if (equals <= 0 || !record.endsWith('\n')) {
      throw new Error('malformed pax header key/value record');
    }
    const key = record.slice(0, equals);
    if (Object.hasOwn(values, key)) {
      throw new Error(`pax header repeats key: ${key}`);
    }
    values[key] = record.slice(equals + 1, -1);
    offset = recordEnd;
  }
  return values;
}

function validatePaxSemantics(values: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(values)) {
    if (key === 'size' || key === 'linkpath' || key.startsWith('GNU.sparse.')) {
      throw new Error(`tar archive contains unsupported pax key: ${key}`);
    }
  }
}

function decodeTarString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
