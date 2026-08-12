import { decompress } from 'fzstd';

import { readPackageAsset } from './asset-source.js';
import type { SerializedAssetSource } from './rpc.js';

export type DirectoryFiles = Record<string, Uint8Array>;

export type ExtractedArchive = {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
};

export type BrowserDirectoryMount = {
  files: DirectoryFiles;
  directories: string[];
};

export type BrowserRuntimeLayout = {
  module: Uint8Array;
  mounts: Record<string, BrowserDirectoryMount>;
};

const BLOCK_SIZE = 512;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const decoder = new TextDecoder();

export async function loadBrowserRuntime(
  runtimeSource: SerializedAssetSource,
  pgdataSource: SerializedAssetSource,
): Promise<BrowserRuntimeLayout> {
  const [runtimeBytes, pgdataBytes] = await Promise.all([
    loadAsset(runtimeSource, 'WASIX runtime archive'),
    loadAsset(pgdataSource, 'WASIX PGDATA template'),
  ]);
  const runtime = extractTar(decompressIfNeeded(runtimeBytes));
  const pgdata = extractTar(decompressIfNeeded(pgdataBytes));
  return layoutRuntime(runtime, pgdata);
}

export function extractTar(archive: Uint8Array): ExtractedArchive {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let offset = 0;
  let nextPax: Record<string, string> | undefined;
  let globalPax: Record<string, string> = {};
  let nextLongName: string | undefined;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(header)) {
      break;
    }

    const type = String.fromCharCode(header[156] ?? 0).replace('\0', '') || '0';
    const size = parseOctal(header.subarray(124, 136), 'tar entry size');
    const payloadEnd = offset + size;
    if (payloadEnd > archive.length) {
      throw new Error('tar archive ended in the middle of an entry payload');
    }
    const payload = archive.subarray(offset, payloadEnd);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (type === 'x') {
      nextPax = parsePaxPayload(payload);
      continue;
    }
    if (type === 'g') {
      globalPax = { ...globalPax, ...parsePaxPayload(payload) };
      continue;
    }
    if (type === 'L') {
      nextLongName = decodeTarString(payload).replace(/\0+$/, '');
      continue;
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) };
    nextPax = undefined;
    const path = sanitizeTarPath(pax.path ?? nextLongName ?? tarHeaderPath(header));
    nextLongName = undefined;
    if (path === undefined) {
      continue;
    }
    if (type === '5') {
      if (files.has(path)) {
        throw new Error(`tar entry repeats an existing file as a directory: ${path}`);
      }
      addDirectoryWithAncestors(directories, path);
      continue;
    }
    if (type !== '0') {
      throw new Error(`unsupported tar entry type '${type}' for ${path}`);
    }
    if (files.has(path) || directories.has(path)) {
      throw new Error(`tar archive repeats entry path: ${path}`);
    }
    files.set(path, payload.slice());
  }

  return { files, directories };
}

export function layoutRuntime(
  runtime: ExtractedArchive,
  pgdata: ExtractedArchive,
): BrowserRuntimeLayout {
  const runtimeFiles = runtime.files;
  const pgdataFiles = pgdata.files;
  const module = runtimeFiles.get('oliphaunt/bin/oliphaunt');
  if (module === undefined || module.length === 0) {
    throw new Error('runtime archive is missing oliphaunt/bin/oliphaunt');
  }
  if (!pgdataFiles.has('PG_VERSION') || !pgdataFiles.has('global/pg_control')) {
    throw new Error('PGDATA template is missing PG_VERSION or global/pg_control');
  }

  const mounts: Record<string, BrowserDirectoryMount> = {
    '/base': {
      files: mapToDirectory(pgdataFiles),
      directories: [...pgdata.directories],
    },
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
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`failed to fetch ${label} (${response.status} ${response.statusText})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function decompressIfNeeded(bytes: Uint8Array): Uint8Array {
  const isZstd = ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
  return isZstd ? decompress(bytes) : bytes;
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
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
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
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`tar entry path escapes the install root: ${path}`);
  }
  return segments.join('/');
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
    values[record.slice(0, equals)] = record.slice(equals + 1, -1);
    offset = recordEnd;
  }
  return values;
}

function decodeTarString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
