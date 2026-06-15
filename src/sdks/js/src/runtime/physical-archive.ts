import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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

export async function createPhysicalArchive(options: {
  pgdata: string;
  execSimpleQuery(sql: string): Promise<Uint8Array>;
}): Promise<Uint8Array> {
  await assertQueryOk(
    options.execSimpleQuery(`SELECT pg_backup_start(label => '${BACKUP_LABEL}', fast => true)`),
    'start physical backup',
  );

  const archive = new TarArchive();
  let backupStopped = false;
  try {
    await appendPgdataTree(archive, options.pgdata);
    const stopFiles = await stopPhysicalBackup(options.execSimpleQuery);
    backupStopped = true;
    await appendPgWalTree(archive, options.pgdata);
    archive.appendGeneratedFile('pgdata/backup_label', stopFiles.backupLabel);
    if (stopFiles.tablespaceMap !== undefined && stopFiles.tablespaceMap.length > 0) {
      archive.appendGeneratedFile('pgdata/tablespace_map', stopFiles.tablespaceMap);
    }
    return archive.finish();
  } catch (error) {
    if (!backupStopped) {
      await stopPhysicalBackup(options.execSimpleQuery).catch(() => {});
    }
    throw error;
  }
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
  return (await readdir(path)).sort((left, right) => left.localeCompare(right));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

class TarArchive {
  readonly #chunks: Uint8Array[] = [];
  #finished = false;

  async appendDirectory(path: string, source: string): Promise<void> {
    const metadata = await lstat(source);
    this.#appendHeader({
      path,
      type: 'directory',
      mode: modeOrDefault(metadata.mode, 0o700),
      size: 0,
      mtime: Math.floor(metadata.mtimeMs / 1000),
    });
  }

  async appendFile(path: string, source: string): Promise<void> {
    const metadata = await lstat(source);
    const bytes = await readFile(source);
    this.#appendHeader({
      path,
      type: 'file',
      mode: modeOrDefault(metadata.mode, 0o600),
      size: bytes.byteLength,
      mtime: Math.floor(metadata.mtimeMs / 1000),
    });
    this.#append(new Uint8Array(bytes));
    this.#pad(bytes.byteLength);
  }

  appendGeneratedFile(path: string, contents: string): void {
    const bytes = new TextEncoder().encode(contents);
    this.#appendHeader({
      path,
      type: 'file',
      mode: 0o600,
      size: bytes.byteLength,
      mtime: Math.floor(Date.now() / 1000),
    });
    this.#append(bytes);
    this.#pad(bytes.byteLength);
  }

  finish(): Uint8Array {
    if (!this.#finished) {
      this.#append(new Uint8Array(BLOCK_SIZE * 2));
      this.#finished = true;
    }
    const total = this.#chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  #appendHeader(options: {
    path: string;
    type: 'file' | 'directory';
    mode: number;
    size: number;
    mtime: number;
  }): void {
    if (this.#finished) {
      throw new Error('cannot append to a finished tar archive');
    }
    const header = new Uint8Array(BLOCK_SIZE);
    const nameParts = splitTarPath(options.path);
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
    this.#append(header);
  }

  #append(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
  }

  #pad(size: number): void {
    const remainder = size % BLOCK_SIZE;
    if (remainder !== 0) {
      this.#append(new Uint8Array(BLOCK_SIZE - remainder));
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
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) {
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

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
