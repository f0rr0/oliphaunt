#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  guestReceipt,
  executorReceipt,
  verifyInventory,
  carrierTree,
  hashRegular,
} from '../lib/verify-sealed-carrier.mts';
import { sha256 } from '../lib/sealed-export-chain.mts';
const [root, input, field] = process.argv.slice(2);
if (root.startsWith('--')) {
  if (root === '--field') console.log(JSON.parse(readFileSync(input, 'utf8'))[field]);
  else if (root === '--patch-manifest')
    writeFileSync(
      input,
      JSON.stringify({
        ...JSON.parse(readFileSync(input, 'utf8')),
        ...JSON.parse(await Bun.stdin.text()),
      }) + '\n',
    );
  else if (root === '--reindex') {
    const rows = [...carrierTree(input)]
      .filter(([path, info]) => path !== 'payload.files' && info.isFile())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path]) => {
        const { size, sha256 } = hashRegular(join(input, path));
        return sha256 + '\t' + size + '\t' + path;
      });
    writeFileSync(
      join(input, 'payload.files'),
      ['schema=oliphaunt.wasix-postmaster.payload-files.v1', ...rows, ''].join('\n'),
    );
  } else if (root === '--validation-log') {
    const records = readFileSync(input, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((row) => row.program),
      ['postgres', 'initdb'],
    );
    assert.deepEqual(records[0].arguments, ['--version']);
    assert.deepEqual(records[1].arguments, [
      '-D',
      '/pgdata',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
    ]);
    for (const record of records) {
      const volumes = new Map<string, string>();
      for (const volume of record.volumes) {
        const colon = volume.lastIndexOf(':'),
          host = volume.slice(0, colon),
          guest = volume.slice(colon + 1);
        assert(!volumes.has(guest));
        volumes.set(guest, host);
      }
      const carrier = [...volumes].find(([guest, host]) => guest === host)![1];
      assert.equal(volumes.get('/lib'), join(carrier, 'lib'));
      assert.equal(volumes.get('/share'), join(carrier, 'share'));
      for (const guest of ['/pgdata', '/dev/shm']) assert(!existsSync(volumes.get(guest)!));
    }
  } else assert.fail('unknown carrier fixture operation');
  process.exit(0);
}
assert(root, 'carrier root is required');
const inventory = verifyInventory(root);
const wasmer = Object.fromEntries(
  readFileSync(join(root, 'wasmer-build.receipt'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => line.split('=')),
);
const directory = mkdtempSync(join(tmpdir(), 'carrier-receipt-checks-'));
try {
  for (const [path, mutations, parse] of [
    [
      'guest-build.receipt',
      {
        schema: 'oliphaunt.wasix-postmaster.guest-build.v4',
        docker_image_id: 'sha256:mutable',
        atomic_fence_total: '01',
        atomic_fence_set_latch: '1',
        latch_state_contract: 'none',
        linear_memory_profile_id: 'unbounded',
      },
      (root: string) => guestReceipt(root, inventory),
    ],
    [
      'postmaster-executor.receipt',
      {
        schema: 'oliphaunt.wasix-postmaster.postmaster-executor-build.v2',
        start_proof_binary: 'another-tool',
        start_proof_features: '',
        start_proof_policy: 'unrestricted',
        start_proof_binary_sha256: 'not-a-digest',
        memory_profile_binary: 'another-tool',
        memory_profile_features: '',
        linear_memory_profile_id: 'unbounded',
        memory_profile_binary_sha256: 'not-a-digest',
        postmaster_compiler_binary: 'another-tool',
        postmaster_compiler_features: '',
        compiler_cpu_policy: 'host-native',
        compiler_cpu_features: 'avx2',
        postmaster_compiler_binary_sha256: 'not-a-digest',
      },
      (root: string) => executorReceipt(root, inventory, wasmer),
    ],
  ] as const) {
    const lines = readFileSync(join(root, path), 'utf8').trimEnd().split('\n');
    function check(candidate: string[], valid = false) {
      const bytes = Buffer.from(`${candidate.join('\n')}\n`);
      writeFileSync(join(directory, path), bytes);
      inventory.set(path, { size: bytes.length, sha256: sha256(bytes) });
      if (valid) parse(directory);
      else assert.throws(() => parse(directory));
    }
    check(lines, true);
    for (const [key, value] of Object.entries(mutations))
      check(lines.map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line)));
    check(lines.slice(1));
    check([...lines].reverse());
    check([...lines, lines[0]]);
  }
  console.log('carrier receipts reject weakened provenance and ambiguous fields');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
