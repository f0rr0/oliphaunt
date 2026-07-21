import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  createPhysicalArchive,
  DEFAULT_PHYSICAL_ARCHIVE_MAX_BYTES,
  MAX_PHYSICAL_ARCHIVE_MAX_BYTES,
} from '../runtime/physical-archive.js';

async function main(): Promise<void> {
  await testPhysicalArchiveUsesOnlineBackupBoundaries();
}

async function testPhysicalArchiveUsesOnlineBackupBoundaries(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-'));
  const stagingRoot = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-stage-'));
  try {
    await mkdir(join(root, 'global'), { recursive: true });
    await mkdir(join(root, 'pg_wal'), { recursive: true });
    await mkdir(join(root, 'pg_notify'), { recursive: true });
    const longDirectory = 'a'.repeat(96);
    await mkdir(join(root, longDirectory), { recursive: true });
    await writeFile(join(root, 'PG_VERSION'), '18\n');
    await writeFile(join(root, 'global', 'pg_control'), 'control');
    await writeFile(join(root, 'pg_wal', '000000010000000000000001'), 'wal');
    await writeFile(join(root, 'pg_notify', 'transient'), 'skip');
    await writeFile(join(root, 'postmaster.pid'), 'skip');

    const sqlCalls: string[] = [];
    const sourceChunks = new Map<string, number[]>();
    let observedPrivateStaging = false;
    const archive = await createPhysicalArchive({
      pgdata: root,
      temporaryDirectory: stagingRoot,
      sourceChunkBytes: 3,
      onSourceChunkRead(source, bytesRead) {
        const chunks = sourceChunks.get(source) ?? [];
        chunks.push(bytesRead);
        sourceChunks.set(source, chunks);
      },
      async execSimpleQuery(sql) {
        sqlCalls.push(sql);
        if (sql.includes('pg_backup_stop')) {
          const workDirectories = await readdir(stagingRoot);
          assert.equal(workDirectories.length, 1);
          if (process.platform !== 'win32') {
            const workDirectory = join(stagingRoot, workDirectories[0] ?? '');
            const directoryMode = (await stat(workDirectory)).mode & 0o777;
            const fileMode = (await stat(join(workDirectory, 'archive.tar'))).mode & 0o777;
            assert.equal(directoryMode, 0o700);
            assert.equal(fileMode, 0o600);
          }
          observedPrivateStaging = true;
          return queryResponse(['labelfile', 'spcmapfile'], [['backup label contents', null]]);
        }
        return commandCompleteResponse();
      },
    });

    assert.equal(archive.byteLength % 512, 0);
    assertArchiveContains(archive, 'pgdata/PG_VERSION');
    assertArchiveContains(archive, 'pgdata/global/pg_control');
    assertArchiveContains(archive, 'pgdata/pg_wal/000000010000000000000001');
    assertArchiveContains(archive, 'pgdata/backup_label');
    assertArchiveContains(archive, 'backup label contents');
    assertArchiveDoesNotContain(archive, 'postmaster.pid');
    assertArchiveDoesNotContain(archive, 'pg_notify/transient');
    const entries = tarEntries(archive);
    assert.equal(entries.get('pgdata/'), '5');
    assert.equal(entries.get('pgdata/global/'), '5');
    assert.equal(entries.get(`pgdata/${longDirectory}/`), '5');
    assert.equal(entries.get('pgdata/PG_VERSION'), '0');
    assert.equal(
      [...entries].some(([name, type]) => type === '5' && !name.endsWith('/')),
      false,
      'directory headers must use canonical trailing-slash names',
    );
    assert.equal(sqlCalls.length, 2);
    assert.match(sqlCalls[0] ?? '', /pg_backup_start/);
    assert.match(sqlCalls[1] ?? '', /pg_backup_stop/);
    assert.equal(observedPrivateStaging, true);
    assert.deepEqual(sourceChunks.get(join(root, 'global', 'pg_control')), [3, 3, 1]);
    assert.ok(
      [...sourceChunks.values()].flat().every((bytesRead) => bytesRead > 0 && bytesRead <= 3),
      'source files must be copied through the configured bounded chunk buffer',
    );
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

test('enforces the archive cap before reading a too-large source and cleans up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-cap-'));
  const stagingRoot = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-cap-stage-'));
  try {
    const oversized = join(root, 'oversized-relation');
    await writeFile(oversized, '');
    await truncate(oversized, 32 * 1024 * 1024);

    const sqlCalls: string[] = [];
    let sourceChunks = 0;
    await assert.rejects(
      createPhysicalArchive({
        pgdata: root,
        temporaryDirectory: stagingRoot,
        maxArchiveBytes: 2 * 1024,
        sourceChunkBytes: 8,
        onSourceChunkRead() {
          sourceChunks += 1;
        },
        async execSimpleQuery(sql) {
          sqlCalls.push(sql);
          if (sql.includes('pg_backup_stop')) {
            return queryResponse(['labelfile', 'spcmapfile'], [['cleanup backup label', null]]);
          }
          return commandCompleteResponse();
        },
      }),
      /Uint8Array compatibility limit while adding pgdata\/oversized-relation/,
    );

    assert.equal(sourceChunks, 0, 'the known-too-large source must not be read at all');
    assert.equal(sqlCalls.length, 2);
    assert.match(sqlCalls[0] ?? '', /pg_backup_start/);
    assert.match(sqlCalls[1] ?? '', /pg_backup_stop/);
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('stops backup and removes partially written PGDATA after a streaming failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-stream-failure-'));
  const stagingRoot = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-stream-stage-'));
  try {
    await writeFile(join(root, 'relation'), 'sensitive pgdata bytes');
    const sqlCalls: string[] = [];
    let chunksRead = 0;
    await assert.rejects(
      createPhysicalArchive({
        pgdata: root,
        temporaryDirectory: stagingRoot,
        sourceChunkBytes: 4,
        onSourceChunkRead() {
          chunksRead += 1;
          throw new Error('injected source streaming failure');
        },
        async execSimpleQuery(sql) {
          sqlCalls.push(sql);
          if (sql.includes('pg_backup_stop')) {
            return queryResponse(['labelfile', 'spcmapfile'], [['cleanup backup label', null]]);
          }
          return commandCompleteResponse();
        },
      }),
      /injected source streaming failure/,
    );
    assert.equal(chunksRead, 1);
    assert.equal(sqlCalls.length, 2);
    assert.match(sqlCalls[1] ?? '', /pg_backup_stop/);
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('parses archive limits fail-closed before starting backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-env-'));
  const stagingRoot = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-env-stage-'));
  const previous = process.env.OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES;
  try {
    assert.equal(DEFAULT_PHYSICAL_ARCHIVE_MAX_BYTES, 512 * 1024 * 1024);
    assert.equal(MAX_PHYSICAL_ARCHIVE_MAX_BYTES, 2 * 1024 * 1024 * 1024 - 1);
    process.env.OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES = '512 MiB';
    let sqlCalls = 0;
    await assert.rejects(
      createPhysicalArchive({
        pgdata: root,
        temporaryDirectory: stagingRoot,
        async execSimpleQuery() {
          sqlCalls += 1;
          return commandCompleteResponse();
        },
      }),
      /OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES must be a positive integer byte count/,
    );
    assert.equal(sqlCalls, 0);
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    if (previous === undefined) {
      delete process.env.OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES;
    } else {
      process.env.OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES = previous;
    }
    await rm(root, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('rejects a staging directory inside PGDATA before starting backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-self-stage-'));
  const stagingRoot = join(root, 'staging');
  try {
    await mkdir(stagingRoot);
    let sqlCalls = 0;
    await assert.rejects(
      createPhysicalArchive({
        pgdata: root,
        temporaryDirectory: stagingRoot,
        async execSimpleQuery() {
          sqlCalls += 1;
          return commandCompleteResponse();
        },
      }),
      /must be outside PGDATA so the staging archive cannot include itself/,
    );
    assert.equal(sqlCalls, 0);
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function tarEntries(archive: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const field = (start: number, length: number): string => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${name}`);
    entries.set(prefix ? `${prefix}/${name}` : name, String.fromCharCode(header[156] ?? 0));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function assertArchiveContains(archive: Uint8Array, text: string): void {
  assert.ok(archiveText(archive).includes(text), `expected archive to include ${text}`);
}

function assertArchiveDoesNotContain(archive: Uint8Array, text: string): void {
  assert.equal(archiveText(archive).includes(text), false, `archive unexpectedly included ${text}`);
}

function archiveText(archive: Uint8Array): string {
  return new TextDecoder('latin1').decode(archive);
}

function commandCompleteResponse(): Uint8Array {
  return Uint8Array.from([
    ...backendMessage(0x43, cstring('SELECT 1')),
    ...backendMessage(0x5a, [0x49]),
  ]);
}

function queryResponse(fields: string[], rows: Array<Array<string | null>>): Uint8Array {
  return Uint8Array.from([
    ...backendMessage(0x54, rowDescription(fields)),
    ...rows.flatMap((row) => backendMessage(0x44, dataRow(row))),
    ...backendMessage(0x43, cstring(`SELECT ${rows.length}`)),
    ...backendMessage(0x5a, [0x49]),
  ]);
}

function rowDescription(fields: string[]): number[] {
  return [
    ...i16(fields.length),
    ...fields.flatMap((field) => [
      ...cstring(field),
      ...u32(0),
      ...i16(0),
      ...u32(25),
      ...i16(-1),
      ...i32(-1),
      ...i16(0),
    ]),
  ];
}

function dataRow(values: Array<string | null>): number[] {
  return [
    ...i16(values.length),
    ...values.flatMap((value) => {
      if (value === null) {
        return i32(-1);
      }
      const bytes = new TextEncoder().encode(value);
      return [...i32(bytes.byteLength), ...bytes];
    }),
  ];
}

function backendMessage(tag: number, body: number[]): number[] {
  return [tag, ...i32(body.length + 4), ...body];
}

function cstring(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

function i16(value: number): number[] {
  const bits = value & 0xffff;
  return [(bits >>> 8) & 0xff, bits & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function i32(value: number): number[] {
  return u32(value >>> 0);
}

test('physical archive', async () => {
  await main();
});
