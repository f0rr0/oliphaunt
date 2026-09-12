#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { closureHash, fields, profile, profileId } from './linear-memory-profile.mts';
import { AGGREGATE_RELATIVE, member, safeRelative, stableRead } from './receipt-files.mts';

export const receiptRelative = 'share/postgresql/wasix-postmaster.sealed-export.structure.receipt';
const prefix = 'share/postgresql/wasix-postmaster.sealed-export.';
const policyId = 'oliphaunt.wasix-postmaster.sealed-export-closure.v1';
const maxBytes = 512 * 1024 * 1024;
export type Inventory = Map<string, { size: number; sha256: string }>;
type Record = { [key: string]: any };
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields differ`);
}
const names = (value: string) => value.trim().split(/\s+/);
const receiptKeys = names(`schema policy-id analyzer-version analyzer-binary-sha256 dce-tool-sha256
 dce-tool-version dce-passes mandatory-policy-sha256 declared-main-dlsym-policy-sha256
 side-manifest-sha256 allowlist-sha256 seed-proof-sha256 final-proof-sha256 seed final-module sides`);
const snapshotKeys =
  names(`sha256 bytes exports local-functions local-globals element-function-entries
 element-unique-function-indices start-function-index`);
const proofKeys =
  names(`schema policy-id analyzer-version mandatory-policy-sha256 declared-main-dlsym-policy-sha256
 main sides mandatory-runtime-exports declared-main-dlsym-exports side-dynamic-imports retained-main-exports
 retained-main-export-descriptors removed-main-export-count removed-main-export-names-sha256
 unresolved-main-requirements mismatched-main-requirements unresolved-side-dependencies retained-counts removed-counts`);
const moduleKeys =
  names(`path sha256 bytes non-export-sections-sha256 dylink-needed imported-functions local-functions
 imported-globals local-globals imported-tables local-tables element-function-entries element-unique-function-indices
 element-max-function-index start-function-index imports export-counts exported-global-type-counts
 exported-immutable-i32-globals exported-local-functions exported-imported-functions`);

export function requireSha(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid SHA-256');
}
export function parseJson(data: Uint8Array): Record {
  const text = new TextDecoder('utf8', { fatal: true }).decode(data);
  assert(!/[\0\r]/.test(text), 'non-canonical JSON text');
  const value = parseStrictJson(text, (_key, value) => {
    if (typeof value === 'number') assert(Number.isSafeInteger(value), 'unsafe JSON integer');
    return value;
  });
  assert(value && typeof value === 'object' && !Array.isArray(value), 'JSON must be an object');
  return value;
}
export function readRegular(root: string, relative: string, inventory?: Inventory) {
  safeRelative(relative);
  const expected = inventory?.get(relative);
  if (inventory) assert(expected, `sealed-export input is not inventoried: ${relative}`);
  const bound = expected?.size ?? maxBytes;
  assert(Number.isSafeInteger(bound) && bound >= 0 && bound <= maxBytes, 'invalid inventory size');
  const chunks: Buffer[] = [];
  stableRead(member(root, relative), (chunk) => chunks.push(Buffer.from(chunk)), bound);
  const bytes = Buffer.concat(chunks);
  if (expected) {
    assert.equal(bytes.length, expected.size, `inventory size differs: ${relative}`);
    assert.equal(sha256(bytes), expected.sha256, `inventory digest differs: ${relative}`);
  }
  return bytes;
}
function trackedHash(path: string) {
  const hash = createHash('sha256');
  stableRead(
    path,
    (chunk) => {
      hash.update(chunk);
    },
    maxBytes,
  );
  return hash.digest('hex');
}
export function sideManifestPaths(projectRoot: string) {
  const policy = readRegular(projectRoot, 'wasmer/policies/sealed-side-modules.v1.tsv');
  const lines = new TextDecoder('utf8', { fatal: true }).decode(policy).split(/\r?\n/);
  assert.equal(
    lines[0],
    '# schema=oliphaunt.wasix-postmaster.sealed-side-modules.v1',
    'side manifest schema differs',
  );
  const paths = lines
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 3, 'side manifest row differs');
      safeRelative(fields[0]);
      return fields[0];
    });
  assert(
    paths.length === 27 && new Set(paths).size === 27,
    'side manifest must contain exactly 27 paths',
  );
  return paths;
}
function validateProof(proof: Record, receipt: Record, mainHash: string, sides: Record[]) {
  exactKeys(proof, proofKeys, 'sealed-export proof');
  assert.equal(proof.schema, 'oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2');
  assert.equal(proof['policy-id'], policyId);
  for (const field of [
    'analyzer-version',
    'mandatory-policy-sha256',
    'declared-main-dlsym-policy-sha256',
  ])
    assert.equal(proof[field], receipt[field], `proof identity differs: ${field}`);
  exactKeys(proof.main, moduleKeys, 'proof main');
  assert.equal(proof.main.path, 'bin/postgres');
  assert.equal(proof.main.sha256, mainHash, 'proof main identity differs');
  assert(
    Array.isArray(proof.sides) && proof.sides.length === sides.length,
    'proof side closure differs',
  );
  for (const [index, expected] of sides.entries()) {
    const module = proof.sides[index];
    exactKeys(module, moduleKeys, 'proof side');
    assert.deepEqual(
      [module.path, module.sha256],
      [expected.path, expected.sha256],
      'proof side identity differs',
    );
  }
  for (const field of [
    'unresolved-main-requirements',
    'mismatched-main-requirements',
    'unresolved-side-dependencies',
  ])
    assert.deepEqual(proof[field], [], `export graph is not closed: ${field}`);
}
export function validateExportChain(
  root: string,
  projectRoot: string,
  sourceHashes: Map<string, string>,
  inventory?: Inventory,
) {
  const receipt = parseJson(readRegular(root, receiptRelative, inventory));
  exactKeys(receipt, receiptKeys, 'sealed-export receipt');
  assert.equal(receipt.schema, 'oliphaunt.wasix-postmaster.sealed-export-structure.v1');
  assert.equal(receipt['policy-id'], policyId);
  assert.deepEqual(receipt['dce-passes'], ['--remove-unused-module-elements']);
  for (const key of receiptKeys.filter((key) => key.endsWith('-sha256'))) requireSha(receipt[key]);
  for (const key of ['analyzer-version', 'dce-tool-version'])
    assert(
      typeof receipt[key] === 'string' && receipt[key] && !/[\r\n\0]/.test(receipt[key]),
      'invalid tool version',
    );
  for (const [key, file] of [
    ['mandatory-policy-sha256', 'sealed-main-runtime-exports.v1.txt'],
    ['declared-main-dlsym-policy-sha256', 'sealed-main-dlsym-exports.v1.txt'],
    ['side-manifest-sha256', 'sealed-side-modules.v1.tsv'],
  ])
    assert.equal(
      receipt[key],
      trackedHash(join(projectRoot, 'wasmer/policies', file)),
      `tracked policy differs: ${file}`,
    );
  exactKeys(receipt.seed, snapshotKeys, 'seed snapshot');
  exactKeys(receipt['final-module'], snapshotKeys, 'final snapshot');
  const seedHash = receipt.seed.sha256,
    finalHash = receipt['final-module'].sha256;
  requireSha(seedHash);
  requireSha(finalHash);
  assert.equal(
    sourceHashes.get('bin/postgres'),
    finalHash,
    'final module is not the memory-seal predecessor',
  );
  const sidePaths = sideManifestPaths(projectRoot);
  assert(
    Array.isArray(receipt.sides) && receipt.sides.length === sidePaths.length,
    'side closure differs',
  );
  for (const [index, path] of sidePaths.entries()) {
    const side = receipt.sides[index];
    exactKeys(side, ['path', 'sha256'], 'side receipt');
    requireSha(side.sha256);
    assert.equal(side.path, path, 'side order/path differs');
    assert.equal(
      sourceHashes.get(path),
      side.sha256,
      `side is not the memory-seal predecessor: ${path}`,
    );
  }
  for (const [suffix, field, hash] of [
    ['allowlist', 'allowlist-sha256', undefined],
    ['seed-proof.json', 'seed-proof-sha256', seedHash],
    ['final-proof.json', 'final-proof-sha256', finalHash],
  ] as const) {
    const bytes = readRegular(root, prefix + suffix, inventory);
    assert.equal(sha256(bytes), receipt[field], `installed proof bytes differ: ${suffix}`);
    if (hash) validateProof(parseJson(bytes), receipt, hash, receipt.sides);
  }
  return receipt;
}
export function linearMemorySourceHashes(root: string, inventory?: Inventory) {
  const receipt = parseJson(readRegular(root, AGGREGATE_RELATIVE, inventory));
  exactKeys(
    receipt,
    [
      'schema',
      'profile-id',
      ...Object.keys(profile),
      'predecessor-export-closure-receipt',
      'predecessor-export-closure-receipt-sha256',
      'source-module-closure-sha256',
      'module-closure-sha256',
      'module-count',
      'modules',
    ],
    'memory install receipt',
  );
  assert.equal(receipt.schema, 'oliphaunt.wasix-postmaster.linear-memory-install.v1');
  assert.equal(receipt['profile-id'], profileId);
  for (const [key, expected] of Object.entries(profile))
    assert.equal(receipt[key], expected, `memory profile differs: ${key}`);
  assert.equal(receipt['predecessor-export-closure-receipt'], receiptRelative);
  assert.equal(
    sha256(readRegular(root, receiptRelative, inventory)),
    receipt['predecessor-export-closure-receipt-sha256'],
    'predecessor digest differs',
  );
  assert(
    Array.isArray(receipt.modules) &&
      receipt.modules.length > 0 &&
      receipt['module-count'] === receipt.modules.length,
    'memory module count differs',
  );
  const hashes = new Map<string, string>();
  for (const module of receipt.modules) {
    exactKeys(module, ['path', ...fields], 'memory module');
    const path = module.path;
    safeRelative(path);
    for (const key of ['source-module-sha256', 'module-sha256']) requireSha(module[key]);
    assert(
      Number.isSafeInteger(module['initial-pages']) &&
        module['initial-pages'] >= 0 &&
        module['initial-pages'] <= 4096,
      'invalid initial pages',
    );
    for (const [key, expected] of Object.entries({
      'maximum-pages': 4096,
      'maximum-bytes': 268435456,
      shared: true,
      'import-module': 'env',
      'import-name': 'memory',
      transformation: 'pinned-wasixcc-65536-to-embedded-4096-reversible-v1',
    }))
      assert.equal(module[key], expected, `memory module differs: ${path} ${key}`);
    // The install receipt also covers tools omitted from the runtime carrier.
    // Validate all receipt records, and bind bytes for every shipped module.
    if (!inventory || inventory.has(path))
      assert.equal(
        sha256(readRegular(root, path, inventory)),
        module['module-sha256'],
        `memory module bytes differ: ${path}`,
      );
    assert(!hashes.has(path), `duplicate memory module: ${path}`);
    hashes.set(path, module['source-module-sha256']);
  }
  const paths = [...hashes.keys()];
  assert.deepEqual(paths, [...paths].sort(), 'memory modules are not sorted');
  for (const field of ['source-module-sha256', 'module-sha256'])
    assert.equal(
      closureHash(receipt.modules, field),
      receipt[field.replace('module-sha256', 'module-closure-sha256')],
      'memory closure digest differs',
    );
  return hashes;
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        'install-root': { type: 'string' },
        'project-root': { type: 'string' },
        'allow-linear-memory-descendant': { type: 'boolean' },
      },
    });
    const root = values['install-root'],
      project = values['project-root'];
    assert(root && project, '--install-root and --project-root are required');
    const hashes =
      values['allow-linear-memory-descendant'] &&
      lstatSync(member(root, AGGREGATE_RELATIVE), { throwIfNoEntry: false })
        ? linearMemorySourceHashes(root)
        : new Map(
            ['bin/postgres', ...sideManifestPaths(project)].map((path) => [
              path,
              sha256(readRegular(root, path)),
            ]),
          );
    validateExportChain(root, project, hashes);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
