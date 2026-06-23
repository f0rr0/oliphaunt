import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPhysicalArchive } from '../runtime/physical-archive.js';

async function main(): Promise<void> {
  await testPhysicalArchiveUsesOnlineBackupBoundaries();
}

async function testPhysicalArchiveUsesOnlineBackupBoundaries(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-archive-'));
  try {
    await mkdir(join(root, 'global'), { recursive: true });
    await mkdir(join(root, 'pg_wal'), { recursive: true });
    await mkdir(join(root, 'pg_notify'), { recursive: true });
    await writeFile(join(root, 'PG_VERSION'), '18\n');
    await writeFile(join(root, 'global', 'pg_control'), 'control');
    await writeFile(join(root, 'pg_wal', '000000010000000000000001'), 'wal');
    await writeFile(join(root, 'pg_notify', 'transient'), 'skip');
    await writeFile(join(root, 'postmaster.pid'), 'skip');

    const sqlCalls: string[] = [];
    const archive = await createPhysicalArchive({
      pgdata: root,
      async execSimpleQuery(sql) {
        sqlCalls.push(sql);
        if (sql.includes('pg_backup_stop')) {
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
    assert.equal(sqlCalls.length, 2);
    assert.match(sqlCalls[0] ?? '', /pg_backup_start/);
    assert.match(sqlCalls[1] ?? '', /pg_backup_stop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
