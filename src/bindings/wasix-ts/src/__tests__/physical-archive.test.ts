import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractTar } from '../archive.js';
import {
  decodePhysicalArchive,
  encodePhysicalArchive,
  mergeBackupSnapshots,
  refreshBackupPgControl,
  requiredBackupWalNames,
  snapshotPhysicalBackupBulk,
  validateBackupWalRange,
  withoutPostStopState,
} from '../physical-archive.js';
import type { StoredSnapshot } from '../storage-snapshot.js';

describe('WASIX physical archives', () => {
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
    ];
    validateBackupWalRange(
      walSnapshot(names.map((name) => [name, size])),
      names[0]!,
      names[2]!,
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
      const start = values.get(`${prefix}start`)!;
      const stop = values.get(`${prefix}stop`)!;
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
    directories: ['global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      { path: 'backup_label', bytes: new TextEncoder().encode('label') },
    ],
  };
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
