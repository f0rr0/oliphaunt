#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseStrictJson } from '../../../../shared/artifact-packaging/strict-json.mts';
import { atomicFile, member, readJson, safeRelative } from './linear-memory-transaction.mts';

export const profileId =
  'oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1';
export const profile = {
  'address-width': 'wasm32',
  'supported-host-pointer-width': 'u64',
  'maximum-pages': 4096,
  'maximum-bytes': 268435456,
  'static-bound-pages': 65536,
  'static-offset-guard-bytes': 2147483648,
  'requires-shared': true,
  'requires-import': 'env.memory',
  'excludes-wasm32-end-wrap': true,
  'static-access-lowering': 'wasmer-llvm-unchecked-reservation-and-guard-v1',
};
export const fields = [
  'source-module-sha256',
  'module-sha256',
  'initial-pages',
  'maximum-pages',
  'maximum-bytes',
  'shared',
  'import-module',
  'import-name',
  'transformation',
];

export function closureHash(records: Record<string, unknown>[], field: string) {
  const digest = createHash('sha256');
  const values = [
    'oliphaunt.wasix-postmaster.linear-memory-install-closure.v1',
    field,
    ...records.flatMap((record) => [record.path, record[field]]),
  ];
  for (const value of values) {
    assert(typeof value === 'string', 'invalid closure hash field');
    const encoded = Buffer.from(value),
      length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(encoded.length));
    digest.update(length).update(encoded);
  }
  return digest.digest('hex');
}

function aggregate(
  stage: string,
  index: string,
  predecessor: string,
  predecessorHash: string,
  destination: string,
) {
  const observed = parseStrictJson(process.env.PROFILE_JSON ?? '') as Record<string, unknown>;
  assert.equal(observed.id, profileId, 'memory profile ID differs');
  for (const [key, expected] of Object.entries(profile))
    assert.equal(observed[key], expected, `memory profile differs: ${key}`);
  const records = readFileSync(index, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const parts = line.split('\t');
      assert(parts.length === 2, 'invalid module index');
      const [path, receiptPath] = parts;
      safeRelative(path);
      const receipt = readJson(member(stage, receiptPath));
      assert(
        receipt.schema === 'oliphaunt.wasix-postmaster.linear-memory-module.v1' &&
          receipt['profile-id'] === profileId,
        `module profile differs: ${path}`,
      );
      const record: Record<string, unknown> = { path };
      for (const key of fields) {
        assert(key in receipt, `module receipt lacks ${key}`);
        record[key] = receipt[key];
      }
      return record;
    })
    .sort((a, b) =>
      String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0,
    );
  assert.equal(
    new Set(records.map((record) => record.path)).size,
    records.length,
    'duplicate module paths',
  );
  const result = {
    schema: 'oliphaunt.wasix-postmaster.linear-memory-install.v1',
    'profile-id': profileId,
    ...profile,
    'predecessor-export-closure-receipt': predecessor,
    'predecessor-export-closure-receipt-sha256': predecessorHash,
    'source-module-closure-sha256': closureHash(records, 'source-module-sha256'),
    'module-closure-sha256': closureHash(records, 'module-sha256'),
    'module-count': records.length,
    modules: records,
  };
  atomicFile(destination, (fd) => writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`), true);
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'profile-id') {
      assert(args.length === 0, 'profile-id reads JSON from stdin');
      const value = parseStrictJson(readFileSync(0, 'utf8'));
      assert(typeof value.id === 'string', 'memory profile lacks an ID');
      console.log(value.id);
    } else if (command === 'modules') {
      assert(args.length === 1, 'modules requires a receipt');
      const receipt = readJson(args[0]);
      assert(Array.isArray(receipt.modules), 'receipt has no modules');
      for (const row of receipt.modules) {
        safeRelative(row.path);
        console.log(row.path);
      }
    } else {
      assert(
        command === 'aggregate' && args.length === 5,
        'aggregate requires STAGE INDEX PREDECESSOR HASH OUTPUT',
      );
      aggregate(args[0], args[1], args[2], args[3], args[4]);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
