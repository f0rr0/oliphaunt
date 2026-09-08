import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { schema, validate, readRegular } from './validate-sealed-loader-audit.mts';

const initdb = '1'.repeat(64),
  postgres = '2'.repeat(64);
const manifest = Buffer.from(
  JSON.stringify({
    artifacts: [
      { name: 'runtime:initdb', 'module-sha256': initdb },
      { name: 'runtime:postgres', 'module-sha256': postgres },
    ],
  }),
);
function record(module: string, pid: number, portable = false): Record<string, any> {
  const value: Record<string, any> = {
    schema,
    pid,
    artifact_kind: 'aot',
    module_sha256: module,
    snapshot_mode: portable ? 'streamed-copy' : 'direct-immutable-inode',
    logical_bytes: 4096,
    source_bytes_read: portable ? 4096 : 0,
    source_bytes_written: 0,
    snapshot_bytes_written: portable ? 4096 : 0,
    mapping_bytes_hashed: 4096,
    sync_calls: 0,
    write_policy: portable ? 'private-streamed-copy-no-sync' : 'none-immutable-source',
  };
  for (const [index, prefix] of [
    'read_advice',
    'source_cache_eviction',
    'snapshot_cache_eviction',
    'mapping_cache_eviction',
  ].entries()) {
    value[`${prefix}_applicable`] = index < 2 || (index === 2 && portable);
    value[`${prefix}_supported`] = !portable;
    value[`${prefix}_calls`] = value[`${prefix}_successes`] =
      !portable && index < 2 ? (index === 0 ? 2 : 1) : 0;
    value[`${prefix}_${index === 0 ? 'first_errno' : 'errno'}`] = null;
  }
  for (const key of [
    'residency_after_hash_inspect',
    'residency_after_archive_release',
    'source_residency_before_eviction',
    'source_residency_after_eviction',
    'residency_after_eviction',
  ]) {
    value[key] = portable
      ? {
          state: 'unsupported-platform',
          page_size: null,
          total_pages: null,
          resident_pages: null,
          resident_bytes: null,
          errno: null,
        }
      : {
          state: 'measured',
          page_size: 4096,
          total_pages: 1,
          resident_pages: 1,
          resident_bytes: 4096,
          errno: null,
        };
  }
  return value;
}
const lifecycle = (portable = false) => [
  record(initdb, 101, portable),
  record(postgres, 101, portable),
  record(postgres, 202, portable),
];
const encode = (records: unknown[]) =>
  Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
const run = (records = lifecycle(), policy = 'direct-immutable') =>
  validate(encode(records), manifest, Buffer.from('validator'), policy);

test('counts bootstrap and outer activations, validates portable copies and rejects broken evidence', () => {
  const [header, values] = run()
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
  const result = Object.fromEntries(header!.map((key, i) => [key, values![i]]));
  assert.equal(result.status, 'passed');
  assert.equal(result.records, '3');
  assert.equal(result.initdb_pids, '101');
  assert.equal(result.postgres_pids, '202');
  assert.equal(result.read_advice_calls, '6');
  assert.doesNotThrow(() => run(lifecycle(true), 'portable-copy'));
  assert.throws(() => run([record(initdb, 101), record(postgres, 202)]), /bootstrap postgres/);
  assert.throws(() => run([...lifecycle(), record(postgres, 202)]), /not unique/);
  assert.throws(() => run([...lifecycle(), record('f'.repeat(64), 303)]), /not in sealed manifest/);
  for (const change of [
    { artifact_kind: 'preinitialized-memory' },
    { unknown: true },
    { snapshot_mode: 'reflink' },
    { pid: true },
    { logical_bytes: -1 },
    { source_bytes_written: 1 },
    { mapping_bytes_hashed: 4095 },
    { read_advice_successes: 1 },
    { source_cache_eviction_errno: 5 },
    { sync_calls: 1 },
    {
      residency_after_eviction: {
        state: 'measured',
        page_size: 4096,
        total_pages: 1,
        resident_pages: 1,
        resident_bytes: 4095,
        errno: null,
      },
    },
  ]) {
    const records = lifecycle();
    Object.assign(records[0]!, change);
    assert.throws(() => run(records), `accepted ${JSON.stringify(change)}`);
  }
  const audit = encode(lifecycle()).toString();
  assert.throws(
    () =>
      validate(
        Buffer.from(audit.replace('"pid":101', '"pid":101,"pid":101')),
        manifest,
        Buffer.alloc(0),
      ),
    /duplicate/,
  );
  // Adjacent integers above 2^53 must remain distinct process identities.
  const precise = audit
    .replaceAll('"pid":101', '"pid":9007199254740992')
    .replace('"pid":202', '"pid":9007199254740993');
  assert.match(
    validate(Buffer.from(precise), manifest, Buffer.alloc(0)),
    /9007199254740992\t9007199254740993/,
  );
  assert.throws(
    () =>
      validate(Buffer.from(audit.replace('"pid":101', '"pid":101.0')), manifest, Buffer.alloc(0)),
    /integers/,
  );
});

test('bounded audit reads reject symlinks and oversized inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'loader-audit-'));
  try {
    const file = join(root, 'audit');
    writeFileSync(file, 'audit');
    symlinkSync(file, join(root, 'link'));
    assert.equal(readRegular(file).toString(), 'audit');
    assert.throws(() => readRegular(join(root, 'link')));
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.throws(() => readRegular(file), /bounded regular/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
