#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
const policy = 'llvm-shared-memory-init-restricted-effects.v1';
const args = process.argv.slice(2);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
if (args.length === 1 && args[0] === '--policy-id') {
  console.log(policy);
} else {
  assert(args.length === 1 && lstatSync(args[0]).isFile(), 'expected a regular module');
  const digest =
    process.env.FAKE_START_PROOF_WRONG_MODULE === '1'
      ? 'ff'.repeat(32)
      : hash(readFileSync(args[0]));
  console.log(
    JSON.stringify(
      {
        schema: 'oliphaunt.wasix-postmaster.deterministic-start-proof.v1',
        'analyzer-policy': policy,
        'module-sha256': digest,
        'proof-sha256': hash(`${policy}\0${digest}\0fake-restricted-start-closure`),
        'start-function-index': 147,
        'start-function-export': '__wasm_init_memory',
        'transitive-function-indices': [147, 148],
        'imported-function-calls': process.env.FAKE_START_PROOF_INVALID === '1' ? 1 : 0,
        'memory-reads': 'fresh-zero-atomic-guard-only',
        'memory-effects': 'passive-data-init-zero-fill-atomic-guard-only',
        'global-effects': 'local-numeric-relocations-only',
        'table-effects': 'none',
        'requires-fresh-zeroed-memory': true,
        'ordinary-start-execution-per-instance': true,
        'first-instance-full-byte-validation': true,
      },
      null,
      2,
    ),
  );
}
