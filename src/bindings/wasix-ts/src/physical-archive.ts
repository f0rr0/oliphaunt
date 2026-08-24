import {
  PHYSICAL_FORMAT as WASIX_PHYSICAL_FORMAT,
  POSTGRES_MAJOR as WASIX_POSTGRES_MAJOR,
} from '@oliphaunt/liboliphaunt-wasix';

import { extractTar } from './archive.js';
import { WasixStorageError } from './errors.js';
import { simpleQuery } from './protocol.js';
import { PostgresError, parseQueryResponse, type QueryResult } from './query.js';
import type { StorageDirectory } from './storage-provider.js';
import {
  type StoredSnapshot,
  snapshotStorageDirectory,
  validateStoredSnapshot,
} from './storage-snapshot.js';

const TAR_BLOCK_BYTES = 512;
const ARCHIVE_MANIFEST_PATH = '.oliphaunt/backup-manifest.properties';
const ARCHIVE_MANIFEST =
  'archiveLayout=oliphaunt-physical-archive-v1\n' +
  'product=oliphaunt\n' +
  'engineFamily=wasix\n' +
  `physicalFormat=${WASIX_PHYSICAL_FORMAT}\n` +
  `postgresMajor=${WASIX_POSTGRES_MAJOR}\n`;
const encoder = new TextEncoder();

type ExecProtocol = (input: Uint8Array) => Promise<Uint8Array>;

type BackupModeState = 'not-entered' | 'exit-required' | 'exited' | 'exit-unconfirmed';

type StopBackupFiles = Readonly<{
  stopWal: string;
  backupLabel: string;
  tablespaceMap: string | null;
}>;

type StopBackupAttempt =
  | Readonly<{ state: 'exited'; files?: StopBackupFiles; validationError?: unknown }>
  | Readonly<{ state: 'exit-unconfirmed'; error: unknown }>;

/** @internal Identifies the only backup failure that makes the session unsafe to reuse. */
export class BackupModeExitUnconfirmedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'BackupModeExitUnconfirmedError';
  }
}

/** Create one PostgreSQL online physical backup without restarting its session. */
export async function createPhysicalArchive(
  exec: ExecProtocol,
  directory: StorageDirectory,
): Promise<Uint8Array> {
  let state: BackupModeState = 'not-entered';
  try {
    let startResponse: Uint8Array;
    try {
      startResponse = await exec(
        simpleQuery(
          "SELECT pg_walfile_name(pg_backup_start(label => 'oliphaunt physical backup', fast => true)), pg_size_bytes(current_setting('wal_segment_size'))::text",
        ),
      );
    } catch (error) {
      state = 'exit-unconfirmed';
      throw error;
    }
    let start: QueryResult;
    try {
      start = parseQueryResponse(startResponse);
      state = 'exit-required';
    } catch (error) {
      if (error instanceof PostgresError) throw error;
      state = 'exit-required';
      throw error;
    }
    if (start.commandTag !== 'SELECT 1') {
      throw new Error('pg_backup_start did not return a successful PostgreSQL command tag');
    }
    if (start.rows.length !== 1 || start.rows[0]?.values.length !== 2) {
      throw new Error('pg_backup_start returned an unexpected result');
    }
    const startWal = start.rows[0].text(0);
    const walSegmentSizeText = start.rows[0].text(1);
    if (startWal === null || walSegmentSizeText === null) {
      throw new Error('pg_backup_start returned an unexpected result');
    }
    const walSegmentSize = Number(walSegmentSizeText);

    const beforeStop = refreshBackupPgControl(
      await snapshotPhysicalBackupBulk(directory),
      await directory.readFile('global/pg_control'),
    );
    const stop = await stopPhysicalBackup(exec);
    state = stop.state;
    if (stop.state === 'exit-unconfirmed') {
      throw stop.error;
    }
    if (stop.files === undefined) throw stop.validationError;
    const { stopWal, backupLabel, tablespaceMap } = stop.files;

    const walNames = requiredBackupWalNames(startWal, stopWal, walSegmentSize);
    const walFiles = await Promise.all(
      walNames.map(async (name) => {
        const bytes = await directory.readFile(`pg_wal/${name}`);
        if (bytes.length !== walSegmentSize) {
          throw new Error(`physical backup WAL segment ${name} has the wrong size`);
        }
        return { path: `pg_wal/${name}`, bytes };
      }),
    );
    const snapshot = mergeBackupSnapshots(beforeStop, walFiles, backupLabel, tablespaceMap);
    return encodePhysicalArchive(snapshot);
  } catch (primaryError) {
    if (state === 'exit-required' || state === 'exit-unconfirmed') {
      const cleanup = await stopPhysicalBackup(exec);
      state = cleanup.state;
      if (cleanup.state === 'exit-unconfirmed') {
        throw backupModeExitUnconfirmed(primaryError, cleanup.error);
      }
      if (cleanup.validationError !== undefined) {
        throw backupCleanupFailure(primaryError, cleanup.validationError);
      }
    }
    throw primaryError;
  }
}

async function stopPhysicalBackup(exec: ExecProtocol): Promise<StopBackupAttempt> {
  let response: Uint8Array;
  try {
    response = await exec(
      simpleQuery(
        'SELECT pg_walfile_name(lsn), labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)',
      ),
    );
  } catch (error) {
    return { state: 'exit-unconfirmed', error };
  }

  const exitConfirmed = responseConfirmsCommandCompletion(response);
  let result: QueryResult;
  try {
    result = parseQueryResponse(response);
  } catch (error) {
    if (exitConfirmed && !(error instanceof PostgresError)) {
      return { state: 'exited', validationError: error };
    }
    return { state: 'exit-unconfirmed', error };
  }

  if (!exitConfirmed) {
    return {
      state: 'exit-unconfirmed',
      error: new Error('pg_backup_stop did not return a successful PostgreSQL command completion'),
    };
  }
  if (result.commandTag !== 'SELECT 1') {
    return {
      state: 'exited',
      validationError: new Error('pg_backup_stop returned an unexpected PostgreSQL command tag'),
    };
  }

  try {
    const row = result.rows[0];
    if (row === undefined || row.values.length !== 3) {
      throw new Error('pg_backup_stop returned an unexpected result');
    }
    const stopWal = row.text(0);
    const backupLabel = row.text(1);
    const tablespaceMap = row.text(2);
    if (stopWal === null) throw new Error('pg_backup_stop returned an unexpected result');
    if (backupLabel === null || backupLabel.length === 0) {
      throw new Error('pg_backup_stop returned an empty backup label');
    }
    return { state: 'exited', files: { stopWal, backupLabel, tablespaceMap } };
  } catch (validationError) {
    // A fully parsed response without ErrorResponse proves pg_backup_stop ran.
    return { state: 'exited', validationError };
  }
}

function responseConfirmsCommandCompletion(response: Uint8Array): boolean {
  let offset = 0;
  let sawCommandComplete = false;
  while (offset < response.length) {
    if (response.length - offset < 5) return false;
    const length = new DataView(response.buffer, response.byteOffset + offset + 1, 4).getUint32(0);
    if (length < 4 || length + 1 > response.length - offset) return false;
    const tag = response[offset];
    if (tag === 0x45) return false;
    if (tag === 0x43) sawCommandComplete = true;
    const next = offset + length + 1;
    if (tag === 0x5a) {
      const status = response[offset + 5];
      return (
        sawCommandComplete &&
        length === 5 &&
        next === response.length &&
        (status === 0x49 || status === 0x54 || status === 0x45)
      );
    }
    offset = next;
  }
  return false;
}

function backupCleanupFailure(primary: unknown, cleanup: unknown): AggregateError {
  return new AggregateError(
    [primary, cleanup],
    `physical backup failed: ${backupFailureMessage(primary)}; PostgreSQL left backup mode but cleanup validation also failed: ${backupFailureMessage(cleanup)}`,
  );
}

function backupModeExitUnconfirmed(
  primary: unknown,
  cleanup: unknown,
): BackupModeExitUnconfirmedError {
  return new BackupModeExitUnconfirmedError(
    `physical backup failed: ${backupFailureMessage(primary)}; PostgreSQL could not confirm leaving backup mode cleanly: ${backupFailureMessage(cleanup)}`,
    new AggregateError([primary, cleanup], 'physical backup and cleanup both failed'),
  );
}

function backupFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @internal Read the bulk backup tree without reading transient or pre-stop WAL contents. */
export async function snapshotPhysicalBackupBulk(
  directory: StorageDirectory,
): Promise<StoredSnapshot> {
  return withoutPostStopState(
    await snapshotStorageDirectory(directory, {
      skipFile: isTransientBackupEntry,
      skipDirectoryContents: (path) => path === 'pg_wal' || TRANSIENT_STATE_DIRECTORIES.has(path),
    }),
  );
}

/** @internal Prove the online backup contains every required start-to-stop WAL segment. */
export function validateBackupWalRange(
  snapshot: StoredSnapshot,
  startName: string,
  stopName: string,
  segmentSize: number,
): void {
  const names = requiredBackupWalNames(startName, stopName, segmentSize);
  const files = new Map(snapshot.files.map(({ path, bytes }) => [path, bytes.length]));
  for (const name of names) {
    const length = files.get(`pg_wal/${name}`);
    if (length === undefined) throw new Error(`physical backup is missing WAL segment ${name}`);
    if (length !== segmentSize)
      throw new Error(`physical backup WAL segment ${name} has the wrong size`);
  }
}

/** @internal Enumerate PostgreSQL's inclusive start-to-stop WAL range. */
export function requiredBackupWalNames(
  startName: string,
  stopName: string,
  segmentSize: number,
): string[] {
  if (
    !Number.isSafeInteger(segmentSize) ||
    segmentSize < 1024 * 1024 ||
    segmentSize > 1024 * 1024 * 1024 ||
    (segmentSize & (segmentSize - 1)) !== 0
  ) {
    throw new Error('PostgreSQL returned an invalid WAL segment size');
  }
  const start = parseWalName(startName, segmentSize);
  const stop = parseWalName(stopName, segmentSize);
  if (start.timeline !== stop.timeline) {
    throw new Error('physical backup WAL range crosses timelines');
  }
  if (start.segment > stop.segment) {
    throw new Error('physical backup WAL range is reversed');
  }
  const segmentsPerLog = 0x1_0000_0000 / segmentSize;
  const names: string[] = [];
  for (let segment = start.segment; segment <= stop.segment; segment += 1) {
    const log = Math.floor(segment / segmentsPerLog);
    const index = segment % segmentsPerLog;
    const name = `${start.timeline.toString(16).padStart(8, '0')}${log
      .toString(16)
      .padStart(8, '0')}${index.toString(16).padStart(8, '0')}`.toUpperCase();
    names.push(name);
  }
  return names;
}

function parseWalName(name: string, segmentSize: number): { timeline: number; segment: number } {
  if (!/^[0-9A-F]{24}$/u.test(name)) {
    throw new Error(`PostgreSQL returned an invalid WAL filename ${JSON.stringify(name)}`);
  }
  const timeline = Number.parseInt(name.slice(0, 8), 16);
  const log = Number.parseInt(name.slice(8, 16), 16);
  const index = Number.parseInt(name.slice(16), 16);
  const segmentsPerLog = 0x1_0000_0000 / segmentSize;
  if (index >= segmentsPerLog) {
    throw new Error(`PostgreSQL returned an invalid WAL filename ${JSON.stringify(name)}`);
  }
  return { timeline, segment: log * segmentsPerLog + index };
}

/** Validate one Oliphaunt physical tar and return its provider-neutral PGDATA snapshot. */
export function decodePhysicalArchive(bytes: Uint8Array): StoredSnapshot {
  try {
    validateTarFraming(bytes);
    const archive = extractTar(bytes);
    const manifest = archive.files.get(ARCHIVE_MANIFEST_PATH);
    if (manifest === undefined || new TextDecoder().decode(manifest) !== ARCHIVE_MANIFEST) {
      throw corruptArchive('has a missing or incompatible backup manifest');
    }

    const directories: string[] = [];
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const path of archive.directories) {
      if (path === 'pgdata') continue;
      if (path === '.oliphaunt') continue;
      if (!path.startsWith('pgdata/')) {
        throw corruptArchive(`contains unexpected directory ${JSON.stringify(path)}`);
      }
      directories.push(path.slice('pgdata/'.length));
    }
    for (const [path, contents] of archive.files) {
      if (path === ARCHIVE_MANIFEST_PATH) continue;
      if (!path.startsWith('pgdata/')) {
        throw corruptArchive(`contains unexpected file ${JSON.stringify(path)}`);
      }
      const relative = path.slice('pgdata/'.length);
      if (relative === '.oliphaunt.json') {
        throw corruptArchive('contains destination-owned database-root metadata');
      }
      files.push({ path: relative, bytes: contents.slice() });
    }
    const backupLabel = files.find((file) => file.path === 'backup_label');
    if (backupLabel === undefined || backupLabel.bytes.length === 0) {
      throw corruptArchive('has a missing or empty pgdata/backup_label');
    }
    if (!directories.includes('base')) {
      throw corruptArchive('is missing pgdata/base');
    }
    return validateStoredSnapshot(
      { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
      String(WASIX_POSTGRES_MAJOR),
      {
        label: 'physical archive',
        corrupt: (detail, cause) => corruptArchive(detail, cause),
      },
    );
  } catch (error) {
    if (error instanceof WasixStorageError) throw error;
    throw corruptArchive('is malformed', error);
  }
}

/** @internal Apply PostgreSQL's standard online-backup transient-state exclusions. */
export function withoutPostStopState(snapshot: StoredSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    directories: snapshot.directories.filter(
      (path) => !pathWithin(path, 'pg_wal') && !isTransientBackupEntry(path),
    ),
    files: snapshot.files.filter(
      ({ path }) =>
        !pathWithin(path, 'pg_wal') &&
        path !== 'backup_label' &&
        path !== 'tablespace_map' &&
        !isTransientBackupEntry(path),
    ),
  };
}

/** @internal Replace the bulk-scan control file with the final pre-stop read. */
export function refreshBackupPgControl(
  snapshot: StoredSnapshot,
  pgControl: Uint8Array,
): StoredSnapshot {
  if (pgControl.length === 0) throw new Error('final PGDATA global/pg_control is empty');
  const files = snapshot.files.filter(({ path }) => path !== 'global/pg_control');
  files.push({ path: 'global/pg_control', bytes: pgControl.slice() });
  files.sort(compareFile);
  return { ...snapshot, files };
}

function isTransientBackupEntry(path: string): boolean {
  if (
    [
      'postmaster.pid',
      'postmaster.opts',
      'postgresql.auto.conf.tmp',
      'current_logfiles.tmp',
      'backup_label',
      'tablespace_map',
      'backup_manifest',
    ].includes(path)
  ) {
    return true;
  }
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (name === '.DS_Store' || name.startsWith('pg_internal.init') || name.startsWith('pgsql_tmp')) {
    return true;
  }
  return parts.length > 1 && TRANSIENT_STATE_DIRECTORIES.has(parts[0] ?? '');
}

const TRANSIENT_STATE_DIRECTORIES = new Set<string>([
  'pg_dynshmem',
  'pg_notify',
  'pg_replslot',
  'pg_serial',
  'pg_snapshots',
  'pg_stat_tmp',
  'pg_subtrans',
]);

/** @internal Merge only the proven required WAL files into the bulk PGDATA scan. */
export function mergeBackupSnapshots(
  beforeStop: StoredSnapshot,
  walFiles: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  backupLabel: string,
  tablespaceMap: string | null,
): StoredSnapshot {
  const directories = new Set(beforeStop.directories.filter((path) => !pathWithin(path, 'pg_wal')));
  const files = new Map(
    beforeStop.files
      .filter((file) => !pathWithin(file.path, 'pg_wal'))
      .map((file) => [file.path, file.bytes]),
  );
  directories.add('pg_wal');
  for (const file of walFiles) files.set(file.path, file.bytes);
  files.set('backup_label', encoder.encode(backupLabel));
  if (tablespaceMap !== null && tablespaceMap.length > 0) {
    files.set('tablespace_map', encoder.encode(tablespaceMap));
  }
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories: [...directories].sort(compareDirectoryDepth),
    files: [...files].map(([path, contents]) => ({ path, bytes: contents })).sort(compareFile),
  };
}

/** @internal Strict ustar writer shared by backup and conformance tests. */
export function encodePhysicalArchive(snapshot: StoredSnapshot): Uint8Array {
  const chunks: Uint8Array[] = [];
  appendTarEntry(chunks, 'pgdata/', new Uint8Array(), '5');
  for (const path of snapshot.directories) {
    appendTarEntry(chunks, `pgdata/${path}/`, new Uint8Array(), '5');
  }
  for (const { path, bytes } of snapshot.files) {
    appendTarEntry(chunks, `pgdata/${path}`, bytes, '0');
  }
  appendTarEntry(chunks, ARCHIVE_MANIFEST_PATH, encoder.encode(ARCHIVE_MANIFEST), '0');
  chunks.push(new Uint8Array(TAR_BLOCK_BYTES * 2));
  return concatenate(chunks);
}

function appendTarEntry(
  chunks: Uint8Array[],
  path: string,
  contents: Uint8Array,
  type: '0' | '5',
): void {
  if (splitUstarPath(path) === undefined) {
    throw new Error(`physical archive path cannot be represented by ustar: ${path}`);
  }
  appendRawTarEntry(chunks, path, contents, type);
}

function appendRawTarEntry(
  chunks: Uint8Array[],
  path: string,
  contents: Uint8Array,
  type: '0' | '5',
): void {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const split = splitUstarPath(path);
  if (split === undefined) throw new Error(`tar path cannot be represented: ${path}`);
  writeAscii(header, 0, 100, split.name);
  writeOctal(header, 100, 8, type === '5' ? 0o700 : 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  writeAscii(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  chunks.push(header, contents.slice());
  const padding = (TAR_BLOCK_BYTES - (contents.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
  if (padding > 0) chunks.push(new Uint8Array(padding));
}

function splitUstarPath(path: string): { name: string; prefix: string } | undefined {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: '' };
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
      return { name, prefix };
    }
  }
  return undefined;
}

function validateTarFraming(bytes: Uint8Array): void {
  if (bytes.length < TAR_BLOCK_BYTES * 2 || bytes.length % TAR_BLOCK_BYTES !== 0) {
    throw corruptArchive('has invalid tar framing');
  }
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      if (
        bytes.length - offset < TAR_BLOCK_BYTES * 2 ||
        bytes.subarray(offset).some((byte) => byte !== 0)
      ) {
        throw corruptArchive('has trailing data after its tar terminator');
      }
      return;
    }
    const expected = parseTarOctal(header.subarray(148, 156), 'checksum');
    let actual = 0;
    for (let index = 0; index < header.length; index += 1) {
      actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (expected !== actual) throw corruptArchive('contains an invalid tar checksum');
    const mode = parseTarOctal(header.subarray(100, 108), 'mode');
    parseTarOctal(header.subarray(108, 116), 'uid', true);
    parseTarOctal(header.subarray(116, 124), 'gid', true);
    const size = parseTarOctal(header.subarray(124, 136), 'size');
    parseTarOctal(header.subarray(136, 148), 'mtime', true);
    if (mode > 0o777) {
      throw corruptArchive('contains unsupported tar permission bits');
    }
    const magic = decodeTarText(header.subarray(257, 263));
    const version = decodeTarText(header.subarray(263, 265));
    if (!((magic === 'ustar\0' && version === '00') || (magic === 'ustar ' && version === ' \0'))) {
      throw corruptArchive('contains an unsupported tar header');
    }
    const type = String.fromCharCode(header[156] ?? 0).replace('\0', '') || '0';
    if (type !== '0' && type !== '5') {
      throw corruptArchive(`contains unsupported tar entry type ${JSON.stringify(type)}`);
    }
    if (decodeTarText(header.subarray(157, 257)).replace(/\0.*$/s, '').length > 0) {
      throw corruptArchive('contains a tar link target');
    }
    if (type === '5' && size !== 0) {
      throw corruptArchive('contains a directory entry with data');
    }
    offset += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset > bytes.length) throw corruptArchive('ends in the middle of an entry');
  }
  throw corruptArchive('is missing a tar terminator');
}

function decodeTarText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw corruptArchive('contains non-UTF-8 tar metadata', error);
  }
}

function parseTarOctal(bytes: Uint8Array, label: string, allowEmpty = false): number {
  const text = new TextDecoder().decode(bytes).replace(/^[\0 ]+|[\0 ]+$/g, '');
  if (text.length === 0 && allowEmpty) return 0;
  if (!/^[0-7]+$/.test(text)) throw corruptArchive(`contains an invalid tar ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw corruptArchive(`contains an oversized tar ${label}`);
  return value;
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number): void {
  const text = `${value.toString(8).padStart(width - 1, '0')}\0`;
  if (text.length !== width) throw new Error('tar numeric field overflow');
  writeAscii(target, offset, width, text);
}

function writeAscii(target: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > width) throw new Error(`tar field is too long: ${value}`);
  target.set(bytes, offset);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function compareDirectoryDepth(left: string, right: string): number {
  return left.split('/').length - right.split('/').length || left.localeCompare(right);
}

function compareFile(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

function corruptArchive(detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`physical archive ${detail}`, {
    code: 'corrupt',
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}
