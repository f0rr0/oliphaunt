import {
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { envVar } from '../native/common.js';
import { assertSuccessfulQueryResponse, parseQueryResponse, type QueryResult } from '../query.js';

const BACKUP_LABEL = 'oliphaunt physical archive';
const TRANSIENT_CONTENT_DIRS = new Set([
  'pg_dynshmem',
  'pg_notify',
  'pg_serial',
  'pg_snapshots',
  'pg_stat_tmp',
  'pg_subtrans',
]);
const BLOCK_SIZE = 512;
const END_BLOCK_BYTES = BLOCK_SIZE * 2;
const DEFAULT_SOURCE_CHUNK_BYTES = 64 * 1024;
const MAX_SOURCE_CHUNK_BYTES = 16 * 1024 * 1024;
const PHYSICAL_ARCHIVE_MAX_BYTES_ENV = 'OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES';
const PHYSICAL_ARCHIVE_TEMP_DIR_ENV = 'OLIPHAUNT_PHYSICAL_ARCHIVE_TEMP_DIR';

// The public backup API returns one Uint8Array, so a final allocation cannot be
// avoided. Keep the default comfortably below common runtime buffer ceilings
// and reject overrides above a conservative signed-32-bit compatibility bound.
export const DEFAULT_PHYSICAL_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const MAX_PHYSICAL_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

export type PhysicalArchiveOptions = {
  pgdata: string;
  execSimpleQuery(sql: string): Promise<Uint8Array>;
  maxArchiveBytes?: number;
  temporaryDirectory?: string;
  sourceChunkBytes?: number;
  onSourceChunkRead?(source: string, bytesRead: number): void;
};

export async function createPhysicalArchive(options: PhysicalArchiveOptions): Promise<Uint8Array> {
  const maxArchiveBytes = resolveMaxArchiveBytes(options.maxArchiveBytes);
  const sourceChunkBytes = validateSourceChunkBytes(options.sourceChunkBytes);
  const temporaryDirectory = await resolveTemporaryDirectory(
    options.temporaryDirectory,
    options.pgdata,
  );
  const workDirectory = await mkdtemp(join(temporaryDirectory, 'oliphaunt-physical-archive-'));
  const archivePath = join(workDirectory, 'archive.tar');
  let sink: BoundedFileSink | undefined;
  let backupStartAttempted = false;
  let backupStopped = false;
  let result: Uint8Array | undefined;
  let primaryError: unknown;

  try {
    sink = await BoundedFileSink.create(archivePath, maxArchiveBytes);
    const archive = new TarArchive(sink, {
      sourceChunkBytes,
      onSourceChunkRead: options.onSourceChunkRead,
    });
    backupStartAttempted = true;
    await assertQueryOk(
      options.execSimpleQuery(`SELECT pg_backup_start(label => '${BACKUP_LABEL}', fast => true)`),
      'start physical backup',
    );
    await appendPgdataTree(archive, options.pgdata);
    const stopFiles = await stopPhysicalBackup(options.execSimpleQuery);
    backupStopped = true;
    await appendPgWalTree(archive, options.pgdata);
    await archive.appendGeneratedFile('pgdata/backup_label', stopFiles.backupLabel);
    if (stopFiles.tablespaceMap !== undefined && stopFiles.tablespaceMap.length > 0) {
      await archive.appendGeneratedFile('pgdata/tablespace_map', stopFiles.tablespaceMap);
    }
    await archive.finish();
    await sink.close();
    sink = undefined;

    // This is the one unavoidable whole-archive allocation required by the
    // existing Uint8Array API. readFile returns a Uint8Array-compatible Buffer,
    // so returning it directly avoids another complete copy.
    result = await readFile(archivePath);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (backupStartAttempted && !backupStopped) {
    try {
      await stopPhysicalBackup(options.execSimpleQuery);
      backupStopped = true;
    } catch (error) {
      cleanupErrors.push(new Error(`physical backup cleanup failed: ${errorString(error)}`));
    }
  }
  if (sink !== undefined) {
    try {
      await sink.close();
    } catch (error) {
      cleanupErrors.push(new Error(`physical archive staging close failed: ${errorString(error)}`));
    }
  }
  try {
    await rm(workDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch (error) {
    cleanupErrors.push(new Error(`physical archive staging cleanup failed: ${errorString(error)}`));
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `physical archive failed: ${errorString(primaryError)}; ${cleanupErrors.length} cleanup operation(s) also failed`,
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'physical archive cleanup failed');
  }
  if (result === undefined) {
    throw new Error('physical archive completed without a result');
  }
  return result;
}

async function assertQueryOk(response: Promise<Uint8Array>, context: string): Promise<void> {
  try {
    assertSuccessfulQueryResponse(await response);
  } catch (error) {
    throw new Error(`${context} failed: ${errorString(error)}`);
  }
}

async function stopPhysicalBackup(
  execSimpleQuery: (sql: string) => Promise<Uint8Array>,
): Promise<{ backupLabel: string; tablespaceMap?: string }> {
  let result: QueryResult;
  try {
    result = parseQueryResponse(
      await execSimpleQuery(
        'SELECT labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)',
      ),
    );
  } catch (error) {
    throw new Error(`stop physical backup failed: ${errorString(error)}`);
  }
  if (result.rowCount !== 1) {
    throw new Error(`stop physical backup returned ${result.rowCount} rows, expected 1`);
  }
  const backupLabel = result.getText(0, 'labelfile');
  if (backupLabel === null || backupLabel.length === 0) {
    throw new Error('pg_backup_stop returned an empty backup label');
  }
  const tablespaceMap = result.getText(0, 'spcmapfile') ?? undefined;
  return { backupLabel, tablespaceMap };
}

async function appendPgdataTree(archive: TarArchive, pgdata: string): Promise<void> {
  await archive.appendDirectory('pgdata', pgdata);
  for (const entry of await sortedEntries(pgdata)) {
    await appendPgdataEntry(archive, pgdata, join(pgdata, entry), false);
  }
}

async function appendPgWalTree(archive: TarArchive, pgdata: string): Promise<void> {
  const pgWal = join(pgdata, 'pg_wal');
  if (!(await isDirectory(pgWal))) {
    return;
  }
  for (const entry of await sortedEntries(pgWal)) {
    await appendPgdataEntry(archive, pgdata, join(pgWal, entry), true);
  }
}

async function appendPgdataEntry(
  archive: TarArchive,
  pgdata: string,
  source: string,
  includeWalContents: boolean,
): Promise<void> {
  const relativePath = toPortablePath(relative(pgdata, source));
  if (shouldSkipPgdataEntry(relativePath, includeWalContents)) {
    return;
  }

  const archivePath = `pgdata/${relativePath}`;
  const metadata = await lstat(source);
  if (metadata.isDirectory()) {
    await archive.appendDirectory(archivePath, source);
    for (const entry of await sortedEntries(source)) {
      await appendPgdataEntry(archive, pgdata, join(source, entry), includeWalContents);
    }
    return;
  }
  if (metadata.isFile()) {
    await archive.appendFile(archivePath, source);
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `physical archive does not support symlinked PGDATA entry ${archivePath}; external tablespaces and linked WAL directories are not portable in liboliphaunt archives`,
    );
  }
  throw new Error(
    `physical archive does not support non-regular PGDATA entry ${archivePath}; liboliphaunt archives only support regular files and directories`,
  );
}

function shouldSkipPgdataEntry(relativePath: string, includeWalContents: boolean): boolean {
  if (relativePath === 'postmaster.pid' || relativePath === 'postmaster.opts') {
    return true;
  }
  const leaf = relativePath.split('/').pop() ?? '';
  if (leaf === 'pg_internal.init' || leaf.startsWith('pgsql_tmp')) {
    return true;
  }
  const [first, ...rest] = relativePath.split('/');
  if (first === undefined || rest.length === 0) {
    return false;
  }
  return TRANSIENT_CONTENT_DIRS.has(first) || (first === 'pg_wal' && !includeWalContents);
}

async function sortedEntries(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

type TarArchiveOptions = {
  sourceChunkBytes: number;
  onSourceChunkRead?: PhysicalArchiveOptions['onSourceChunkRead'];
};

class BoundedFileSink {
  #handle: FileHandle | undefined;
  #bytesWritten = 0;

  private constructor(
    handle: FileHandle,
    readonly maxBytes: number,
  ) {
    this.#handle = handle;
  }

  static async create(path: string, maxBytes: number): Promise<BoundedFileSink> {
    return new BoundedFileSink(await open(path, 'wx', 0o600), maxBytes);
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) {
      throw new Error('cannot write to a closed physical archive sink');
    }
    if (bytes.byteLength > this.maxBytes - this.#bytesWritten) {
      throw new Error(
        `physical archive exceeds the ${this.maxBytes}-byte Uint8Array compatibility limit`,
      );
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
      if (bytesWritten === 0) {
        throw new Error('physical archive staging write made no progress');
      }
      offset += bytesWritten;
      this.#bytesWritten += bytesWritten;
    }
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) {
      return;
    }
    await handle.close();
    this.#handle = undefined;
  }
}

class TarArchive {
  #finished = false;
  readonly #sink: BoundedFileSink;
  readonly #options: TarArchiveOptions;

  constructor(sink: BoundedFileSink, options: TarArchiveOptions) {
    this.#sink = sink;
    this.#options = options;
  }

  async appendDirectory(path: string, source: string): Promise<void> {
    const metadata = await lstat(source);
    await this.#appendEntryHeader({
      path,
      type: 'directory',
      mode: modeOrDefault(metadata.mode, 0o700),
      size: 0,
      mtime: Math.floor(metadata.mtimeMs / 1000),
    });
  }

  async appendFile(path: string, source: string): Promise<void> {
    const pathMetadata = await lstat(source);
    const sourceHandle = await open(source, 'r');
    let operationError: unknown;
    try {
      const metadata = await sourceHandle.stat();
      if (!metadata.isFile()) {
        throw new Error(`physical archive source changed from a regular file: ${source}`);
      }
      if (metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino) {
        throw new Error(`physical archive source changed while it was being opened: ${source}`);
      }
      const header = this.#entryHeader({
        path,
        type: 'file',
        mode: modeOrDefault(metadata.mode, 0o600),
        size: metadata.size,
        mtime: Math.floor(metadata.mtimeMs / 1000),
      });
      this.#assertEntryFits(path, metadata.size);
      await this.#sink.write(header);
      await this.#appendSourceFile(source, sourceHandle, metadata.size);
      await this.#pad(metadata.size);
    } catch (error) {
      operationError = error;
    }
    try {
      await sourceHandle.close();
    } catch (closeError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, closeError],
          `physical archive failed while reading ${source}: ${errorString(operationError)}; closing the source also failed: ${errorString(closeError)}`,
        );
      }
      throw closeError;
    }
    if (operationError !== undefined) {
      throw operationError;
    }
  }

  async appendGeneratedFile(path: string, contents: string): Promise<void> {
    const size = byteLength(contents);
    const header = this.#entryHeader({
      path,
      type: 'file',
      mode: 0o600,
      size,
      // Generated PostgreSQL label contents carry their own backup identity.
      // Avoid adding wall-clock nondeterminism to the tar metadata.
      mtime: 0,
    });
    this.#assertEntryFits(path, size);
    await this.#sink.write(header);
    await this.#sink.write(new TextEncoder().encode(contents));
    await this.#pad(size);
  }

  async finish(): Promise<void> {
    if (!this.#finished) {
      this.#assertCapacity(END_BLOCK_BYTES, 'end-of-archive blocks', false);
      await this.#sink.write(new Uint8Array(END_BLOCK_BYTES));
      this.#finished = true;
    }
  }

  async #appendEntryHeader(options: {
    path: string;
    type: 'file' | 'directory';
    mode: number;
    size: number;
    mtime: number;
  }): Promise<void> {
    const header = this.#entryHeader(options);
    this.#assertEntryFits(options.path, options.size);
    await this.#sink.write(header);
  }

  #entryHeader(options: {
    path: string;
    type: 'file' | 'directory';
    mode: number;
    size: number;
    mtime: number;
  }): Uint8Array {
    if (this.#finished) {
      throw new Error('cannot append to a finished tar archive');
    }
    const header = new Uint8Array(BLOCK_SIZE);
    // POSIX typeflag 5 is authoritative, but the canonical archive spelling
    // also terminates directory paths with `/`. This keeps listings portable
    // across tar implementations and prevents consumers from inferring a file
    // solely because an otherwise-valid directory name lacks the marker.
    const archivePath =
      options.type === 'directory' ? `${options.path.replace(/\/+$/, '')}/` : options.path;
    const nameParts = splitTarPath(archivePath);
    writeString(header, 0, 100, nameParts.name);
    writeOctal(header, 100, 8, options.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, options.size);
    writeOctal(header, 136, 12, options.mtime);
    header.fill(0x20, 148, 156);
    header[156] = options.type === 'directory' ? 0x35 : 0x30;
    writeString(header, 257, 6, 'ustar');
    writeString(header, 263, 2, '00');
    writeString(header, 265, 32, 'oliphaunt');
    writeString(header, 297, 32, 'oliphaunt');
    if (nameParts.prefix !== undefined) {
      writeString(header, 345, 155, nameParts.prefix);
    }
    writeChecksum(header);
    return header;
  }

  async #appendSourceFile(source: string, handle: FileHandle, size: number): Promise<void> {
    const buffer = new Uint8Array(Math.min(this.#options.sourceChunkBytes, Math.max(size, 1)));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new Error(
          `physical archive source shrank while being read: ${source} (expected ${size} bytes, read ${offset})`,
        );
      }
      await this.#sink.write(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      this.#options.onSourceChunkRead?.(source, bytesRead);
    }
  }

  async #pad(size: number): Promise<void> {
    const remainder = size % BLOCK_SIZE;
    if (remainder !== 0) {
      await this.#sink.write(new Uint8Array(BLOCK_SIZE - remainder));
    }
  }

  #assertEntryFits(path: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`physical archive has an invalid file size for ${path}: ${size}`);
    }
    if (size > this.#sink.maxBytes) {
      throw archiveLimitError(this.#sink.maxBytes, path);
    }
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    this.#assertCapacity(BLOCK_SIZE + paddedSize, path, true);
  }

  #assertCapacity(bytes: number, context: string, reserveEndBlocks: boolean): void {
    const reserved = reserveEndBlocks ? END_BLOCK_BYTES : 0;
    if (bytes > this.#sink.maxBytes - this.#sink.bytesWritten - reserved) {
      throw archiveLimitError(this.#sink.maxBytes, context);
    }
  }
}

function splitTarPath(path: string): { name: string; prefix?: string } {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.length === 0 || normalized.includes('/../') || normalized.startsWith('../')) {
    throw new Error(`unsafe physical archive path ${JSON.stringify(path)}`);
  }
  if (byteLength(normalized) <= 100) {
    return { name: normalized };
  }
  const parts = normalized.split('/');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (name.length > 0 && byteLength(prefix) <= 155 && byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`physical archive path is too long for ustar: ${normalized}`);
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) {
    throw new Error(`tar header value is too long: ${value}`);
  }
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error(`tar numeric field overflow: ${value}`);
  }
  writeString(header, offset, length, `${digits.padStart(length - 1, '0')}\0`);
}

function writeChecksum(header: Uint8Array): void {
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const digits = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${digits}\0 `);
}

function modeOrDefault(mode: number, fallback: number): number {
  const permissions = mode & 0o777;
  return permissions === 0 ? fallback : permissions;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function toPortablePath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function resolveMaxArchiveBytes(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return validateMaxArchiveBytes(explicit, 'maxArchiveBytes');
  }
  const configured = envVar(PHYSICAL_ARCHIVE_MAX_BYTES_ENV);
  if (configured === undefined) {
    return DEFAULT_PHYSICAL_ARCHIVE_MAX_BYTES;
  }
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new Error(`${PHYSICAL_ARCHIVE_MAX_BYTES_ENV} must be a positive integer byte count`);
  }
  return validateMaxArchiveBytes(Number(configured), PHYSICAL_ARCHIVE_MAX_BYTES_ENV);
}

function validateMaxArchiveBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer byte count`);
  }
  if (value > MAX_PHYSICAL_ARCHIVE_MAX_BYTES) {
    throw new Error(
      `${label} must not exceed ${MAX_PHYSICAL_ARCHIVE_MAX_BYTES} bytes because physical-archive backup returns one Uint8Array`,
    );
  }
  return value;
}

function validateSourceChunkBytes(value: number | undefined): number {
  const bytes = value ?? DEFAULT_SOURCE_CHUNK_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_SOURCE_CHUNK_BYTES) {
    throw new Error(
      `sourceChunkBytes must be a positive safe integer no greater than ${MAX_SOURCE_CHUNK_BYTES}`,
    );
  }
  return bytes;
}

async function resolveTemporaryDirectory(
  explicit: string | undefined,
  pgdata: string,
): Promise<string> {
  const directory = explicit ?? envVar(PHYSICAL_ARCHIVE_TEMP_DIR_ENV) ?? tmpdir();
  if (directory.trim().length === 0) {
    throw new Error(`${PHYSICAL_ARCHIVE_TEMP_DIR_ENV} must not be empty`);
  }
  if (directory.includes('\0')) {
    throw new Error(`${PHYSICAL_ARCHIVE_TEMP_DIR_ENV} must not contain NUL bytes`);
  }
  const [resolvedDirectory, resolvedPgdata] = await Promise.all([
    realpath(directory),
    realpath(pgdata),
  ]);
  const fromPgdata = relative(resolvedPgdata, resolvedDirectory);
  if (
    fromPgdata === '' ||
    (fromPgdata !== '..' && !fromPgdata.startsWith(`..${sep}`) && !isAbsolute(fromPgdata))
  ) {
    throw new Error(
      `${PHYSICAL_ARCHIVE_TEMP_DIR_ENV} must be outside PGDATA so the staging archive cannot include itself`,
    );
  }
  return resolvedDirectory;
}

function archiveLimitError(maxBytes: number, context: string): Error {
  return new Error(
    `physical archive exceeds the ${maxBytes}-byte Uint8Array compatibility limit while adding ${context}; increase ${PHYSICAL_ARCHIVE_MAX_BYTES_ENV} only when the JavaScript runtime has enough memory for the final contiguous result`,
  );
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
