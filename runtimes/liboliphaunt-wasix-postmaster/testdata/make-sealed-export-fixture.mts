#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { requiredModules } from '../lib/guest-build-provenance.mts';
import { profile, profileId, closureHash } from '../lib/linear-memory-profile.mts';
import { AGGREGATE_RELATIVE } from '../lib/linear-memory-transaction.mts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const jsonBytes = (value: object) =>
  Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
function uleb(value: number) {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
export function summary(path: string, sha256: string, bytes: number) {
  return {
    path,
    sha256,
    bytes,
    'non-export-sections-sha256': digest(`sections:${path}`),
    'dylink-needed': [],
    'imported-functions': 0,
    'local-functions': 1,
    'imported-globals': 0,
    'local-globals': 0,
    'imported-tables': 0,
    'local-tables': 1,
    'element-function-entries': 1,
    'element-unique-function-indices': 1,
    'element-max-function-index': 0,
    'start-function-index': 0,
    imports: [],
    'export-counts': {},
    'exported-global-type-counts': {},
    'exported-immutable-i32-globals': 0,
    'exported-local-functions': 0,
    'exported-imported-functions': 0,
  };
}
export function proof(
  main: ReturnType<typeof summary>,
  sides: ReturnType<typeof summary>[],
  mandatory: string,
  dlsym: string,
) {
  return {
    schema: 'oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2',
    'policy-id': 'oliphaunt.wasix-postmaster.sealed-export-closure.v1',
    'analyzer-version': 'fixture',
    'mandatory-policy-sha256': mandatory,
    'declared-main-dlsym-policy-sha256': dlsym,
    main,
    sides,
    'mandatory-runtime-exports': [],
    'declared-main-dlsym-exports': [],
    'side-dynamic-imports': [],
    'retained-main-exports': [],
    'retained-main-export-descriptors': [],
    'removed-main-export-count': 1,
    'removed-main-export-names-sha256': digest('fixture-removed'),
    'unresolved-main-requirements': [],
    'mismatched-main-requirements': [],
    'unresolved-side-dependencies': [],
    'retained-counts': {},
    'removed-counts': { function: 1 },
  };
}
export function snapshot(sha256: string, bytes: number) {
  return {
    sha256,
    bytes,
    exports: 0,
    'local-functions': 1,
    'local-globals': 0,
    'element-function-entries': 1,
    'element-unique-function-indices': 1,
    'start-function-index': 0,
  };
}
export function makeSealedExportFixture(root: string, projectRoot: string) {
  const policyRoot = join(projectRoot, 'wasmer/policies');
  const sideManifest = readFileSync(join(policyRoot, 'sealed-side-modules.v1.tsv'));
  const sidePaths = sideManifest
    .toString('utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t')[0]);
  const template = readFileSync(join(root, 'lib/libpq.so.5.18'));
  for (const relative of sidePaths) {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
      const name = Buffer.from('oliphaunt.fixture'),
        payload = Buffer.concat([uleb(name.length), name, Buffer.from(relative)]);
      writeFileSync(
        file,
        Buffer.concat([template, Buffer.from([0]), uleb(payload.length), payload]),
      );
    }
  }
  const mandatory = digest(readFileSync(join(policyRoot, 'sealed-main-runtime-exports.v1.txt'))),
    dlsym = digest(readFileSync(join(policyRoot, 'sealed-main-dlsym-exports.v1.txt')));
  const sides = sidePaths.map((path) =>
    summary(path, digest(readFileSync(join(root, path))), statSync(join(root, path)).size),
  );
  const postgres = readFileSync(join(root, 'bin/postgres')),
    seedHash = digest(Buffer.concat([Buffer.from('pre-dce-fixture\0'), postgres]));
  const seedProof = jsonBytes(
      proof(summary('bin/postgres', seedHash, postgres.length + 16), sides, mandatory, dlsym),
    ),
    finalProof = jsonBytes(
      proof(summary('bin/postgres', digest(postgres), postgres.length), sides, mandatory, dlsym),
    );
  const share = join(root, 'share/postgresql');
  mkdirSync(share, { recursive: true });
  for (const [name, data] of [
    ['seed-proof.json', seedProof],
    ['final-proof.json', finalProof],
    ['allowlist', Buffer.from('fixture-export\n')],
  ] as const)
    writeFileSync(join(share, `wasix-postmaster.sealed-export.${name}`), data);
  writeFileSync(
    join(share, 'wasix-postmaster.sealed-export.structure.receipt'),
    jsonBytes({
      schema: 'oliphaunt.wasix-postmaster.sealed-export-structure.v1',
      'policy-id': 'oliphaunt.wasix-postmaster.sealed-export-closure.v1',
      'analyzer-version': 'fixture',
      'analyzer-binary-sha256': '0'.repeat(64),
      'dce-tool-sha256': '1'.repeat(64),
      'dce-tool-version': 'fixture-wasm-opt',
      'dce-passes': ['--remove-unused-module-elements'],
      'mandatory-policy-sha256': mandatory,
      'declared-main-dlsym-policy-sha256': dlsym,
      'side-manifest-sha256': digest(sideManifest),
      'allowlist-sha256': digest('fixture-export\n'),
      'seed-proof-sha256': digest(seedProof),
      'final-proof-sha256': digest(finalProof),
      seed: snapshot(seedHash, postgres.length + 16),
      'final-module': snapshot(digest(postgres), postgres.length),
      sides: sides.map(({ path, sha256 }) => ({ path, sha256 })),
    }),
  );
}

export function makeLinearMemoryFixture(root: string, descendant = false) {
  const predecessor = 'share/postgresql/wasix-postmaster.sealed-export.structure.receipt';
  // The full install includes client tools that the runtime carrier omits.
  writeFileSync(join(root, 'bin/pg_config'), readFileSync(join(root, 'bin/initdb')));
  const modules = ['bin/pg_config', ...requiredModules].sort().map((path) => {
    const source = readFileSync(join(root, path)),
      hash = digest(source);
    const sealed = descendant ? Buffer.concat([source, Buffer.from([0, 1, 0])]) : source;
    if (descendant) writeFileSync(join(root, path), sealed);
    return {
      path,
      'source-module-sha256': hash,
      'module-sha256': digest(sealed),
      'initial-pages': 1,
      'maximum-pages': 4096,
      'maximum-bytes': 268435456,
      shared: true,
      'import-module': 'env',
      'import-name': 'memory',
      transformation: 'pinned-wasixcc-65536-to-embedded-4096-reversible-v1',
    };
  });
  const receipt = {
    schema: 'oliphaunt.wasix-postmaster.linear-memory-install.v1',
    'profile-id': profileId,
    ...profile,
    'predecessor-export-closure-receipt': predecessor,
    'predecessor-export-closure-receipt-sha256': digest(readFileSync(join(root, predecessor))),
    'source-module-closure-sha256': closureHash(modules, 'source-module-sha256'),
    'module-closure-sha256': closureHash(modules, 'module-sha256'),
    'module-count': modules.length,
    modules,
  };
  writeFileSync(join(root, AGGREGATE_RELATIVE), jsonBytes(receipt), { flag: 'wx' });
  return receipt;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'install-root': { type: 'string' },
      'project-root': { type: 'string' },
      'linear-memory': { type: 'boolean' },
      'linear-memory-descendant': { type: 'boolean' },
    },
  });
  assert(values['install-root'] && values['project-root']);
  if (values['linear-memory'] || values['linear-memory-descendant'])
    makeLinearMemoryFixture(values['install-root'], values['linear-memory-descendant']);
  else makeSealedExportFixture(values['install-root'], values['project-root']);
}
