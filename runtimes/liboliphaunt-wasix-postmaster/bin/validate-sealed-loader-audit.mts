#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { stableRead } from '../lib/linear-memory-transaction.mts';

export const schema = 'oliphaunt.wasix-postmaster.sealed-loader-receipt.v2';
const advice = [
  'read_advice',
  'source_cache_eviction',
  'snapshot_cache_eviction',
  'mapping_cache_eviction',
];
const checkpoints = [
  'residency_after_hash_inspect',
  'residency_after_archive_release',
  'source_residency_before_eviction',
  'source_residency_after_eviction',
  'residency_after_eviction',
];
const residencyFields = [
  'state',
  'page_size',
  'total_pages',
  'resident_pages',
  'resident_bytes',
  'errno',
];
const fields = [
  'schema',
  'pid',
  'artifact_kind',
  'module_sha256',
  'snapshot_mode',
  'logical_bytes',
  'source_bytes_read',
  'source_bytes_written',
  'snapshot_bytes_written',
  'mapping_bytes_hashed',
  'sync_calls',
  ...advice.flatMap((prefix) =>
    [
      'applicable',
      'supported',
      'calls',
      'successes',
      prefix === 'read_advice' ? 'first_errno' : 'errno',
    ].map((suffix) => `${prefix}_${suffix}`),
  ),
  ...checkpoints,
  'write_policy',
];
// Preserve the v4 evidence columns for existing reports; memory-image summaries
// are no longer emitted by this AOT-only executor.
const retiredCounters = [
  'ordinary_start_completed_instances',
  'fresh_zeroed_instances',
  'nonfresh_instances',
  'validation_attempts',
  'full_compare_attempts',
  'full_compare_successes',
  'full_compare_failures',
  'compared_bytes',
  'reuse_successes',
  'reuse_failures',
  'skipped_bytes',
  'remap_successes',
  'remap_failures',
];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function exactFields(
  value: unknown,
  expected: string[],
  label: string,
): asserts value is Record<string, any> {
  assert(object(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields differ`);
}
function digest(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), 'invalid module SHA-256');
}
function integer(value: unknown, label: string): bigint {
  assert(typeof value === 'bigint' && value >= 0n, `${label} must be a nonnegative integer`);
  return value;
}
function json(bytes: Uint8Array) {
  return parseStrictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    (_key, value, context?: { source: string }) => {
      if (typeof value !== 'number') return value;
      // Use the original token: JSON.parse's Number would round large Rust counters.
      assert(
        context && /^-?(0|[1-9][0-9]*)$/u.test(context.source),
        'audit numbers must be integers',
      );
      return BigInt(context.source);
    },
  );
}
export function readRegular(file: string) {
  const chunks: Buffer[] = [];
  stableRead(
    file,
    (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
    16 * 1024 * 1024,
  );
  return Buffer.concat(chunks);
}
function residency(value: unknown, logical: bigint, portable: boolean, label: string) {
  exactFields(value, residencyFields, label);
  assert.equal(
    value.state,
    portable ? 'unsupported-platform' : 'measured',
    `${label} state differs`,
  );
  assert.equal(value.errno, null, `${label} carries errno`);
  if (portable) {
    for (const field of residencyFields.filter((field) => field !== 'state'))
      assert.equal(value[field], null, `${label} ${field} must be null`);
    return;
  }
  const page = integer(value.page_size, label);
  const total = integer(value.total_pages, label);
  const resident = integer(value.resident_pages, label);
  const bytes = integer(value.resident_bytes, label);
  assert(page >= 512n && (page & (page - 1n)) === 0n, `${label} page size is invalid`);
  assert.equal(total, (logical + page - 1n) / page, `${label} total pages differs`);
  assert(resident <= total, `${label} resident pages exceed total`);
  const whole = resident * page;
  const tail = logical - (total - 1n) * page;
  assert(
    resident === 0n
      ? bytes === 0n
      : bytes === (whole < logical ? whole : logical) || bytes === (resident - 1n) * page + tail,
    `${label} resident byte/page accounting differs`,
  );
}
export function validate(
  audit: Uint8Array,
  manifest: Uint8Array,
  validator: Uint8Array,
  policy = 'direct',
  initdbCount = 1n,
  postgresCount = 1n,
): string {
  assert(
    ['direct', 'direct-immutable', 'portable-copy', 'compatible'].includes(policy),
    'unknown snapshot policy',
  );
  assert(initdbCount > 0n && postgresCount > 0n, 'expected executions must be positive');
  const portable = policy === 'portable-copy';
  const manifestValue = json(manifest);
  assert(
    object(manifestValue) &&
      Array.isArray(manifestValue.artifacts) &&
      manifestValue.artifacts.length >= 2,
    'manifest artifact closure is incomplete',
  );
  const modules = new Map<string, string>();
  const hashes = new Set<string>();
  for (const artifact of manifestValue.artifacts) {
    assert(
      object(artifact) &&
        typeof artifact.name === 'string' &&
        artifact.name.startsWith('runtime:') &&
        artifact.name.length > 8,
      'invalid manifest artifact',
    );
    const sha = artifact['module-sha256'];
    digest(sha);
    assert(
      !modules.has(artifact.name) && !hashes.has(sha),
      'duplicate manifest artifact or module hash',
    );
    modules.set(artifact.name, sha);
    hashes.add(sha);
  }
  assert(
    modules.has('runtime:initdb') && modules.has('runtime:postgres'),
    'manifest executable closure differs',
  );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(audit);
  assert(
    text.endsWith('\n') && !text.includes('\r'),
    'audit must be newline-terminated without carriage returns',
  );
  const records = text
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      const label = `loader audit line ${index + 1}`;
      const record = json(Buffer.from(line));
      exactFields(record, fields, label);
      assert.equal(record.schema, schema, `${label} schema differs`);
      assert(integer(record.pid, 'pid') > 0n, 'invalid audit pid');
      assert.equal(record.artifact_kind, 'aot', 'invalid artifact kind');
      digest(record.module_sha256);
      assert(hashes.has(record.module_sha256), 'audit module SHA-256 is not in sealed manifest');
      assert(
        policy === 'compatible'
          ? [
              'direct-immutable-inode',
              'direct-read-only-filesystem',
              'reflink',
              'streamed-copy',
            ].includes(record.snapshot_mode)
          : portable
            ? record.snapshot_mode === 'streamed-copy'
            : policy === 'direct-immutable'
              ? record.snapshot_mode === 'direct-immutable-inode'
              : ['direct-immutable-inode', 'direct-read-only-filesystem'].includes(
                  record.snapshot_mode,
                ),
        'snapshot mode differs from policy',
      );
      const streamed = record.snapshot_mode === 'streamed-copy';
      const reflink = record.snapshot_mode === 'reflink';
      const privateCopy = streamed || reflink;
      const logical = integer(record.logical_bytes, 'logical_bytes');
      const read = integer(record.source_bytes_read, 'source_bytes_read');
      assert(
        logical > 0n &&
          (streamed ? read === logical : reflink ? read === 0n : read === 0n || read === logical),
        'source byte accounting differs',
      );
      for (const [field, expected] of Object.entries({
        source_bytes_written: 0n,
        snapshot_bytes_written: streamed ? logical : 0n,
        mapping_bytes_hashed: logical,
        sync_calls: 0n,
      })) {
        assert.equal(integer(record[field], field), expected, `${field} differs`);
      }
      for (const [index, prefix] of advice.entries()) {
        const applicable = record[`${prefix}_applicable`];
        const supported = record[`${prefix}_supported`];
        const calls = integer(record[`${prefix}_calls`], prefix);
        const successes = integer(record[`${prefix}_successes`], prefix);
        const errno = record[`${prefix}_${index === 0 ? 'first_errno' : 'errno'}`];
        assert.equal(
          applicable,
          index < 2 || (index === 2 && privateCopy),
          `${prefix} applicability differs`,
        );
        assert.equal(typeof supported, 'boolean', `${prefix} supported must be boolean`);
        assert(successes <= calls, `${prefix} successes exceed calls`);
        assert.equal(errno, null, `${prefix} carries errno`);
        if (!applicable || !supported) {
          assert(!applicable || portable, `${prefix} is unsupported`);
          assert(
            calls === 0n && successes === 0n,
            `${prefix} issued an inapplicable/unsupported call`,
          );
        } else
          assert(
            calls === (index === 0 ? 2n : 1n) && successes === calls,
            `${prefix} advisory call failed`,
          );
      }
      for (const checkpoint of checkpoints)
        residency(record[checkpoint], logical, portable, checkpoint);
      assert.equal(
        record.write_policy,
        streamed
          ? 'private-streamed-copy-no-sync'
          : reflink
            ? 'private-reflink-no-userspace-payload-write'
            : 'none-immutable-source',
        'write policy differs',
      );
      return record;
    });
  const pids = (name: string) => {
    const values = records
      .filter((record) => record.module_sha256 === modules.get(name))
      .map((record) => record.pid as bigint);
    assert.equal(new Set(values).size, values.length, `${name} AOT audit pids are not unique`);
    return new Set(values);
  };
  const initdb = pids('runtime:initdb'),
    postgres = pids('runtime:postgres');
  assert.equal(BigInt(initdb.size), initdbCount, 'initdb outer execution count differs');
  assert(
    [...initdb].every((pid) => postgres.has(pid)),
    'every initdb execution must activate bootstrap postgres on the same pid',
  );
  const outerPostgres = [...postgres].filter((pid) => !initdb.has(pid));
  assert.equal(
    BigInt(outerPostgres.length),
    postgresCount,
    'postgres outer execution count differs',
  );
  const renderPids = (values: Iterable<bigint>) =>
    [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  const output: Record<string, string | number | bigint> = {
    schema_version: 'oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v4',
    status: 'passed',
    records: records.length,
    aot_records: records.length,
    memory_records: 0,
    initdb_executions: initdbCount,
    postgres_executions: postgresCount,
    initdb_pids: renderPids(initdb),
    postgres_pids: renderPids(outerPostgres),
    snapshot_policy: policy,
    audit_sha256: hash(audit),
    manifest_sha256: hash(manifest),
    validator_sha256: hash(validator),
  };
  for (const prefix of advice)
    for (const suffix of ['calls', 'successes']) {
      const key = `${prefix}_${suffix}`;
      output[key] = records.reduce((total, record) => total + record[key], 0n);
    }
  for (const checkpoint of checkpoints)
    output[`${checkpoint}_bytes`] = records.reduce(
      (total, record) => total + (record[checkpoint].resident_bytes ?? 0n),
      0n,
    );
  for (const key of ['attested_summary_records', ...retiredCounters, 'counter_overflow_records'])
    output[key] = 0;
  return `${Object.keys(output).join('\t')}\n${Object.values(output).join('\t')}\n`;
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        audit: { type: 'string' },
        manifest: { type: 'string' },
        'snapshot-policy': { type: 'string', default: 'direct' },
        'expected-initdb-executions': { type: 'string', default: '1' },
        'expected-postgres-executions': { type: 'string', default: '1' },
      },
    });
    assert(values.audit && values.manifest, '--audit and --manifest are required');
    process.stdout.write(
      validate(
        readRegular(values.audit),
        readRegular(values.manifest),
        readRegular(import.meta.path),
        values['snapshot-policy'],
        BigInt(values['expected-initdb-executions']!),
        BigInt(values['expected-postgres-executions']!),
      ),
    );
  } catch (error) {
    console.error(`sealed loader audit validation failed: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
