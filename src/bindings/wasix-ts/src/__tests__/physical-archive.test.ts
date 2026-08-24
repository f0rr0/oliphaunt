import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractTar } from '../archive.js';
import {
  BackupModeExitUnconfirmedError,
  createPhysicalArchive,
  decodePhysicalArchive,
  encodePhysicalArchive,
  mergeBackupSnapshots,
  refreshBackupPgControl,
  requiredBackupWalNames,
  snapshotPhysicalBackupBulk,
  validateBackupWalRange,
  withoutPostStopState,
} from '../physical-archive.js';
import { PostgresError } from '../query.js';
import type { StorageDirectory } from '../storage-provider.js';
import type { StoredSnapshot } from '../storage-snapshot.js';

describe('WASIX physical archives', () => {
  it('does not stop backup mode when pg_backup_start fails in PostgreSQL', async () => {
    const calls: string[] = [];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return queryError('55000', 'backup is unavailable');
      }, backupDirectory()),
    ).rejects.toBeInstanceOf(PostgresError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('pg_backup_start');
  });

  it('stops backup mode after local validation of the start result fails', async () => {
    const calls: string[] = [];
    const responses = [queryResponse(['000000010000000000000000']), stopResponse()];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('pg_backup_start returned an unexpected result');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('cleans up when pg_backup_start lacks successful command completion', async () => {
    const calls: string[] = [];
    const responses = [withoutCommandComplete(startResponse()), stopResponse()];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('pg_backup_start did not return a successful PostgreSQL command tag');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('preserves a local archive failure after confirmed cleanup', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), stopResponse()];
    const directory = backupDirectory();
    directory.readDir = async () => {
      throw new Error('snapshot failed');
    };
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, directory),
    ).rejects.toThrow('snapshot failed');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('stops backup mode when the final pg_control read fails', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), stopResponse()];
    const directory = backupDirectory();
    const readFile = directory.readFile.bind(directory);
    directory.readFile = async (path) => {
      if (path === 'global/pg_control') throw new Error('pg_control read failed');
      return readFile(path);
    };

    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, directory),
    ).rejects.toThrow('pg_control read failed');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('does not stop twice when archive assembly fails after a confirmed stop', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), stopResponse()];
    const directory = backupDirectory();
    const readFile = directory.readFile.bind(directory);
    directory.readFile = async (path) => {
      if (path.startsWith('pg_wal/')) return new Uint8Array(1024);
      return readFile(path);
    };

    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, directory),
    ).rejects.toThrow('has the wrong size');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('preserves the first stop failure after a fully validated emergency stop', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), queryError('55000', 'first stop failed'), stopResponse()];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('first stop failed');
    expect(calls.map(backupFunction)).toEqual([
      'pg_backup_start',
      'pg_backup_stop',
      'pg_backup_stop',
    ]);
  });

  it('reports both stop failures and identifies unconfirmed cleanup', async () => {
    const responses = [
      startResponse(),
      queryError('55000', 'first stop failed'),
      queryError('55000', 'emergency stop failed'),
    ];
    const failure = await rejection(
      createPhysicalArchive(async () => nextResponse(responses), backupDirectory()),
    );
    expect(failure).toBeInstanceOf(BackupModeExitUnconfirmedError);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes.map((cause) => String(cause))).toEqual([
      expect.stringContaining('first stop failed'),
      expect.stringContaining('emergency stop failed'),
    ]);
  });

  it('preserves primary and cleanup validation failures without poisoning', async () => {
    const directory = backupDirectory();
    directory.readDir = async () => {
      throw new Error('snapshot failed');
    };
    const responses = [startResponse(), stopResponseWithInvalidDataRow()];
    const failure = await rejection(
      createPhysicalArchive(async () => nextResponse(responses), directory),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((cause) => String(cause))).toEqual([
      expect.stringContaining('snapshot failed'),
      expect.stringContaining('DataRow column count'),
    ]);
  });

  it('does not retry a stop whose SQL succeeded but result metadata is invalid', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), queryResponse(['wal-only'])];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('pg_backup_stop returned an unexpected result');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('does not retry a stop whose completed command tag is unexpected', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), queryResponse(['wal', 'backup label', null], 'SELECT 0')];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('pg_backup_stop returned an unexpected PostgreSQL command tag');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('does not retry a stop whose completed response has malformed result metadata', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), stopResponseWithInvalidDataRow()];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('DataRow column count');
    expect(calls.map(backupFunction)).toEqual(['pg_backup_start', 'pg_backup_stop']);
  });

  it('retries once when pg_backup_stop lacks successful command completion', async () => {
    const calls: string[] = [];
    const responses = [startResponse(), withoutCommandComplete(stopResponse()), stopResponse()];
    await expect(
      createPhysicalArchive(async (request) => {
        calls.push(querySql(request));
        return nextResponse(responses);
      }, backupDirectory()),
    ).rejects.toThrow('pg_backup_stop did not return a successful PostgreSQL command completion');
    expect(calls.map(backupFunction)).toEqual([
      'pg_backup_start',
      'pg_backup_stop',
      'pg_backup_stop',
    ]);
  });

  it('matches the shared physical archive manifest exactly', () => {
    const expected = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../shared/fixtures/storage/physical-archive-wasix-v1.properties',
          import.meta.url,
        ),
      ),
    );
    const archive = extractTar(encodePhysicalArchive(completeSnapshot()));
    expect(archive.files.get('.oliphaunt/backup-manifest.properties')).toEqual(
      new Uint8Array(expected),
    );
  });

  it('writes private portable modes', () => {
    const archive = encodePhysicalArchive({
      schema: 'oliphaunt-wasix-directory-snapshot-v1',
      directories: [],
      files: [],
    });
    const decoder = new TextDecoder();
    expect(decoder.decode(archive.subarray(100, 108))).toBe('0000700\0');
    expect(decoder.decode(archive.subarray(512 + 100, 512 + 108))).toBe('0000600\0');
  });

  it('classifies malformed tar input as an unchanged corrupt storage error', () => {
    expect(() => decodePhysicalArchive(Uint8Array.of(1, 2, 3))).toThrowError(
      expect.objectContaining({ code: 'corrupt', commitState: 'unchanged' }),
    );
  });

  it('writes ustar prefix/name boundaries without extension records', () => {
    const prefix = 'a'.repeat(140);
    const name = 'b'.repeat(100);
    const archive = encodePhysicalArchive({
      ...completeSnapshot(),
      directories: [...completeSnapshot().directories, prefix],
      files: [...completeSnapshot().files, { path: `${prefix}/${name}`, bytes: Uint8Array.of(9) }],
    });

    expect(
      decodePhysicalArchive(archive).files.some(({ path }) => path === `${prefix}/${name}`),
    ).toBe(true);
    expect(String.fromCharCode(...archive.subarray(257, 263))).toBe('ustar\0');
  });

  it('rejects paths that require GNU long-name or PAX records', () => {
    const unrepresentable = {
      ...completeSnapshot(),
      files: [
        ...completeSnapshot().files,
        { path: `base/${'x'.repeat(101)}`, bytes: Uint8Array.of(1) },
      ],
    };
    expect(() => encodePhysicalArchive(unrepresentable)).toThrow('cannot be represented by ustar');

    const pax = encodePhysicalArchive(completeSnapshot());
    pax[156] = 'x'.charCodeAt(0);
    rewriteChecksum(pax.subarray(0, 512));
    expect(() => decodePhysicalArchive(pax)).toThrowError(
      expect.objectContaining({ code: 'corrupt', commitState: 'unchanged' }),
    );
  });

  it('rejects an empty backup label', () => {
    const snapshot = completeSnapshot();
    const archive = encodePhysicalArchive({
      ...snapshot,
      files: snapshot.files.map((file) =>
        file.path === 'backup_label' ? { ...file, bytes: new Uint8Array() } : file,
      ),
    });

    expect(() => decodePhysicalArchive(archive)).toThrow('missing or empty pgdata/backup_label');
  });

  it('rejects a missing base directory', () => {
    const snapshot = completeSnapshot();
    const archive = encodePhysicalArchive({
      ...snapshot,
      directories: snapshot.directories.filter((path) => path !== 'base'),
    });

    expect(() => decodePhysicalArchive(archive)).toThrow('missing pgdata/base');
  });

  it('rejects unsupported and malformed ustar numeric metadata', () => {
    for (const [offset, width, value] of [
      [100, 8, '0004755\0'],
      [100, 8, '00008\0'],
      [108, 8, '8'],
      [116, 8, '8'],
      [136, 12, '8'],
    ] as const) {
      const archive = encodePhysicalArchive(completeSnapshot());
      rewriteField(archive, offset, width, value);
      expect(() => decodePhysicalArchive(archive)).toThrowError(
        expect.objectContaining({ code: 'corrupt', commitState: 'unchanged' }),
      );
    }
  });

  it('accepts empty ustar uid, gid, and mtime fields as zero', () => {
    const archive = encodePhysicalArchive(completeSnapshot());
    for (const [offset, width] of [
      [108, 8],
      [116, 8],
      [136, 12],
    ] as const) {
      rewriteField(archive, offset, width, '');
    }
    expect(decodePhysicalArchive(archive).files).toHaveLength(3);
  });

  it('excludes standard transient backup state while retaining empty state directories', () => {
    const transientDirectories = [
      'pg_dynshmem',
      'pg_notify',
      'pg_replslot',
      'pg_serial',
      'pg_snapshots',
      'pg_stat_tmp',
      'pg_subtrans',
    ];
    const snapshot: StoredSnapshot = {
      ...completeSnapshot(),
      directories: [
        ...completeSnapshot().directories,
        ...transientDirectories,
        ...transientDirectories.map((path) => `${path}/nested`),
      ],
      files: [
        ...completeSnapshot().files,
        ...[
          'postmaster.pid',
          'postmaster.opts',
          'postgresql.auto.conf.tmp',
          'current_logfiles.tmp',
          'backup_manifest',
          'base/pg_internal.init.1',
          'base/pgsql_tmp123',
          'base/.DS_Store',
          ...transientDirectories.map((path) => `${path}/state`),
        ].map((path) => ({ path, bytes: Uint8Array.of(1) })),
        { path: 'base/kept', bytes: Uint8Array.of(2) },
      ],
    };

    const filtered = withoutPostStopState(snapshot);
    expect(filtered.directories).toEqual(expect.arrayContaining(transientDirectories));
    expect(filtered.directories).not.toContain('pg_stat_tmp/nested');
    expect(filtered.files.map(({ path }) => path).sort()).toEqual([
      'PG_VERSION',
      'base/kept',
      'global/pg_control',
    ]);
  });

  it('does not read pre-stop WAL or transient file contents during the bulk scan', async () => {
    const reads: string[] = [];
    const snapshot = await snapshotPhysicalBackupBulk({
      async readDir(path) {
        if (path === '') {
          return [
            { type: 'dir', name: 'base' },
            { type: 'dir', name: 'pg_stat_tmp' },
            { type: 'dir', name: 'pg_wal' },
            { type: 'file', name: 'postmaster.pid' },
          ];
        }
        if (path === 'base') {
          return [
            { type: 'file', name: '.DS_Store' },
            { type: 'file', name: 'kept' },
          ];
        }
        throw new Error(`bulk scan must not descend into ${path}`);
      },
      async readFile(path) {
        reads.push(path);
        if (path !== 'base/kept') throw new Error(`bulk scan must not read ${path}`);
        return Uint8Array.of(1);
      },
    });
    expect(reads).toEqual(['base/kept']);
    expect(snapshot.directories).toEqual(['base', 'pg_stat_tmp']);
    expect(snapshot.files).toEqual([{ path: 'base/kept', bytes: Uint8Array.of(1) }]);
  });

  it('replaces the bulk pg_control snapshot with one final pre-stop copy', () => {
    const refreshed = refreshBackupPgControl(completeSnapshot(), Uint8Array.of(9, 8, 7));
    const controls = refreshed.files.filter(({ path }) => path === 'global/pg_control');
    expect(controls).toEqual([{ path: 'global/pg_control', bytes: Uint8Array.of(9, 8, 7) }]);
    expect(() => refreshBackupPgControl(completeSnapshot(), new Uint8Array())).toThrow(
      'pg_control is empty',
    );
  });

  it('validates same-segment and multi-segment WAL ranges', () => {
    const size = 1024 * 1024;
    const same = '00000001000000000000000A';
    validateBackupWalRange(walSnapshot([[same, size]]), same, same, size);

    const names = [
      '000000010000000000000FFE',
      '000000010000000000000FFF',
      '000000010000000100000000',
    ] as const;
    validateBackupWalRange(
      walSnapshot(names.map((name) => [name, size])),
      names[0],
      names[2],
      size,
    );
  });

  it('matches the shared WAL-range vectors', () => {
    const text = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../shared/fixtures/storage/physical-backup-wal-range-v1.properties',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const values = new Map(
      text
        .split(/\r?\n/u)
        .filter((line) => line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(values.get('schema')).toBe('oliphaunt-physical-backup-wal-range-v1');
    const ids = new Set(
      [...values.keys()].flatMap((key) => {
        const match = /^case\.([^.]+)\./u.exec(key);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    for (const id of ids) {
      const prefix = `case.${id}.`;
      const segmentSize = Number(values.get(`${prefix}segmentSizeBytes`));
      const start = requiredFixtureValue(values, `${prefix}start`);
      const stop = requiredFixtureValue(values, `${prefix}stop`);
      const expected = values.get(`${prefix}expected`);
      if (expected !== undefined) {
        expect(requiredBackupWalNames(start, stop, segmentSize)).toEqual(expected.split(','));
      } else {
        const error = values.get(`${prefix}error`);
        const message = {
          'reversed-range': 'WAL range is reversed',
          'timeline-change': 'WAL range crosses timelines',
          'segment-index-out-of-range': 'invalid WAL filename',
          'malformed-wal-filename': 'invalid WAL filename',
        }[error ?? ''];
        expect(message, `unknown shared WAL-range error ${JSON.stringify(error)}`).toBeDefined();
        expect(() => requiredBackupWalNames(start, stop, segmentSize)).toThrow(message);
      }
    }
  });

  it('rejects incomplete or malformed WAL ranges', () => {
    const size = 1024 * 1024;
    const start = '00000001000000000000000A';
    const stop = '00000001000000000000000B';
    expect(() => validateBackupWalRange(walSnapshot([[start, size]]), start, stop, size)).toThrow(
      'missing WAL segment',
    );
    expect(() =>
      validateBackupWalRange(walSnapshot([[start, size - 1]]), start, start, size),
    ).toThrow('wrong size');
    expect(() => validateBackupWalRange(walSnapshot([]), start.toLowerCase(), stop, size)).toThrow(
      'invalid WAL filename',
    );
    expect(() =>
      validateBackupWalRange(walSnapshot([]), start, '00000002000000000000000B', size),
    ).toThrow('crosses timelines');
  });

  it('retains only the required post-stop WAL files', () => {
    const required = '00000001000000000000000A';
    const unrelated = '00000001000000000000000B';
    const snapshot = mergeBackupSnapshots(
      walSnapshot([
        [required, 1],
        [unrelated, 1],
      ]),
      [{ path: `pg_wal/${required}`, bytes: Uint8Array.of(9) }],
      'label',
      null,
    );
    expect(snapshot.files.filter(({ path }) => path.startsWith('pg_wal/'))).toEqual([
      { path: `pg_wal/${required}`, bytes: Uint8Array.of(9) },
    ]);
  });
});

function walSnapshot(files: [string, number][]): StoredSnapshot {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories: ['pg_wal'],
    files: files.map(([name, size]) => ({
      path: `pg_wal/${name}`,
      bytes: new Uint8Array(size),
    })),
  };
}

function completeSnapshot(): StoredSnapshot {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories: ['base', 'global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      { path: 'backup_label', bytes: new TextEncoder().encode('label') },
    ],
  };
}

function backupDirectory(): StorageDirectory {
  const wal = '000000010000000000000000';
  return {
    async readDir(path) {
      switch (path) {
        case '':
          return [
            { type: 'file', name: 'PG_VERSION' },
            { type: 'dir', name: 'base' },
            { type: 'dir', name: 'global' },
            { type: 'dir', name: 'pg_wal' },
          ];
        case 'base':
        case 'global':
        case 'pg_wal':
          return path === 'global' ? [{ type: 'file', name: 'pg_control' }] : [];
        default:
          throw new Error(`unexpected readDir ${path}`);
      }
    },
    async readFile(path) {
      if (path === 'PG_VERSION') return new TextEncoder().encode('18\n');
      if (path === 'global/pg_control') return Uint8Array.of(1);
      if (path === `pg_wal/${wal}`) return new Uint8Array(1024 * 1024);
      throw new Error(`unexpected readFile ${path}`);
    },
  };
}

function startResponse(): Uint8Array {
  return queryResponse(['000000010000000000000000', String(1024 * 1024)]);
}

function stopResponse(): Uint8Array {
  return queryResponse(['000000010000000000000000', 'backup label', null]);
}

function stopResponseWithInvalidDataRow(): Uint8Array {
  const response = stopResponse().slice();
  let offset = 0;
  while (offset < response.length) {
    const length = new DataView(response.buffer, response.byteOffset + offset + 1, 4).getUint32(0);
    if (response[offset] === 'D'.charCodeAt(0)) {
      new DataView(response.buffer).setUint16(offset + 5, 2);
      return response;
    }
    offset += length + 1;
  }
  throw new Error('stop response is missing DataRow');
}

function queryResponse(values: readonly (string | null)[], commandTag = 'SELECT 1'): Uint8Array {
  const encoder = new TextEncoder();
  const fields = values.map((_value, index) => `column_${index}`);
  const descriptionLength =
    2 + fields.reduce((length, name) => length + encoder.encode(name).length + 19, 0);
  const description = new Uint8Array(descriptionLength);
  const descriptionView = new DataView(description.buffer);
  descriptionView.setInt16(0, fields.length);
  let descriptionOffset = 2;
  for (const name of fields) {
    const nameBytes = encoder.encode(name);
    description.set(nameBytes, descriptionOffset);
    descriptionOffset += nameBytes.length;
    description[descriptionOffset++] = 0;
    descriptionView.setUint32(descriptionOffset, 0);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, 0);
    descriptionOffset += 2;
    descriptionView.setUint32(descriptionOffset, 25);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, -1);
    descriptionOffset += 2;
    descriptionView.setInt32(descriptionOffset, -1);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, 0);
    descriptionOffset += 2;
  }

  const encodedValues = values.map((value) => (value === null ? null : encoder.encode(value)));
  const data = new Uint8Array(
    2 + encodedValues.reduce((length, value) => length + 4 + (value?.length ?? 0), 0),
  );
  const dataView = new DataView(data.buffer);
  dataView.setInt16(0, encodedValues.length);
  let dataOffset = 2;
  for (const value of encodedValues) {
    dataView.setInt32(dataOffset, value?.length ?? -1);
    dataOffset += 4;
    if (value !== null) {
      data.set(value, dataOffset);
      dataOffset += value.length;
    }
  }
  return concatenateMessages([
    backendMessage('T', description),
    backendMessage('D', data),
    backendMessage('C', encoder.encode(`${commandTag}\0`)),
    ready(),
  ]);
}

function queryError(sqlstate: string, message: string): Uint8Array {
  const encoder = new TextEncoder();
  return concatenateMessages([
    backendMessage(
      'E',
      Uint8Array.from([
        'S'.charCodeAt(0),
        ...encoder.encode('ERROR'),
        0,
        'C'.charCodeAt(0),
        ...encoder.encode(sqlstate),
        0,
        'M'.charCodeAt(0),
        ...encoder.encode(message),
        0,
        0,
      ]),
    ),
    ready(),
  ]);
}

function ready(): Uint8Array {
  return backendMessage('Z', Uint8Array.of('I'.charCodeAt(0)));
}

function backendMessage(tag: string, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(body.length + 5);
  message[0] = tag.charCodeAt(0);
  new DataView(message.buffer).setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

function concatenateMessages(messages: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(messages.reduce((length, message) => length + message.length, 0));
  let offset = 0;
  for (const message of messages) {
    result.set(message, offset);
    offset += message.length;
  }
  return result;
}

function withoutCommandComplete(response: Uint8Array): Uint8Array {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset < response.length) {
    const length = new DataView(response.buffer, response.byteOffset + offset + 1, 4).getUint32(0);
    const next = offset + length + 1;
    if (response[offset] !== 'C'.charCodeAt(0)) messages.push(response.slice(offset, next));
    offset = next;
  }
  return concatenateMessages(messages);
}

function querySql(request: Uint8Array): string {
  return new TextDecoder().decode(request.subarray(5, -1));
}

function backupFunction(sql: string): string {
  if (sql.includes('pg_backup_start')) return 'pg_backup_start';
  if (sql.includes('pg_backup_stop')) return 'pg_backup_stop';
  throw new Error(`unexpected backup SQL ${sql}`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

function nextResponse(responses: Uint8Array[]): Uint8Array {
  const response = responses.shift();
  if (response === undefined) throw new Error('test exhausted backup responses');
  return response;
}

function requiredFixtureValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`shared fixture is missing ${key}`);
  return value;
}

function rewriteChecksum(header: Uint8Array): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const bytes = new TextEncoder().encode(`${checksum.toString(8).padStart(6, '0')}\0 `);
  header.set(bytes, 148);
}

function rewriteField(archive: Uint8Array, offset: number, width: number, value: string): void {
  archive.fill(0, offset, offset + width);
  archive.set(new TextEncoder().encode(value), offset);
  rewriteChecksum(archive.subarray(0, 512));
}
