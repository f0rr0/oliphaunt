#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  fchmodSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { member } from './linear-memory-transaction.mts';
import { dirname, basename } from 'node:path';
import { profile, profileId } from './linear-memory-profile.mts';
import { readRegular, parseJson, requireSha } from './sealed-export-chain.mts';
import {
  guestReceipt,
  sourceFingerprint,
  carrierTree,
  hashRegular,
} from './verify-sealed-carrier.mts';

function manifest(args: string[]) {
  assert.equal(args.length, 22, 'manifest requires exact builder inputs');
  const [
    rows,
    root,
    output,
    fingerprint,
    coreProfile,
    guestHash,
    target,
    abi,
    config,
    commit,
    patch,
    lock,
    runtime,
    producer,
    executorHash,
    executorSize,
    pg,
    wasmer,
    wasix,
    artifactAbi,
    linearPath,
    linearHash,
  ] = args;
  const linear = parseJson(readRegular(root, linearPath));
  assert.equal(linear.schema, 'oliphaunt.wasix-postmaster.linear-memory-install.v1');
  assert.equal(linear['profile-id'], profileId);
  for (const [key, value] of Object.entries(profile))
    assert.equal(linear[key], value, `linear profile differs: ${key}`);
  const modules = new Map<string, any>();
  assert(Array.isArray(linear.modules), 'memory receipt lacks modules');
  for (const row of linear.modules) {
    assert(typeof row.path === 'string' && !modules.has(row.path), 'duplicate/invalid module path');
    modules.set(row.path, row);
  }
  const text = new TextDecoder('utf8', { fatal: true }).decode(
    readRegular(dirname(rows), basename(rows)),
  );
  assert(text.endsWith('\n') && !/[\r\0]/.test(text), 'non-canonical artifact rows');
  const unsigned = (value: string) => {
    assert(
      /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)),
      'invalid artifact size/ABI',
    );
    return Number(value);
  };
  const artifacts = text
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 9, 'invalid artifact row');
      const [name, kind, path, modulePath, hash, size, moduleHash, moduleSize, alias] = fields;
      const record = modules.get(modulePath);
      assert(record, 'memory receipt lacks module');
      requireSha(hash);
      requireSha(moduleHash);
      assert.equal(record['module-sha256'], moduleHash);
      return {
        name,
        kind,
        path,
        'module-path': modulePath,
        sha256: hash,
        'raw-sha256': hash,
        'raw-size': unsigned(size),
        'module-sha256': moduleHash,
        'module-size': unsigned(moduleSize),
        'linear-memory': {
          'profile-id': profileId,
          'source-module-sha256': record['source-module-sha256'],
          'install-receipt-sha256': linearHash,
        },
        compressed: false,
        'exec-aliases': alias ? [alias] : [],
      };
    });
  const result = {
    'format-version': 6,
    schema: 'oliphaunt.wasix-postmaster.sealed-aot.v5',
    'source-lane': 'wasix-postmaster',
    'source-fingerprint': fingerprint,
    'core-profile': coreProfile,
    'guest-build-recipe-sha256': guestHash,
    'postgres-version': pg,
    'target-triple': target,
    'host-abi': abi,
    engine: 'llvm-opta',
    'compiler-config': config,
    'cpu-policy': 'generic-baseline',
    'cpu-features': [],
    'wasmer-version': wasmer,
    'wasmer-wasix-version': wasix,
    'wasmer-source-commit': commit,
    'wasmer-patch-sha256': patch,
    'wasmer-cargo-lock-sha256': lock,
    'artifact-abi-version': unsigned(artifactAbi),
    'runtime-abi-id': runtime,
    'producer-recipe-sha256': producer,
    'executor-engine': 'engine-headless',
    'executor-sha256': executorHash,
    'executor-size': unsigned(executorSize),
    'linear-memory-profile': {
      id: profileId,
      ...Object.fromEntries(
        Object.entries(profile).filter(
          ([key]) =>
            !['requires-shared', 'requires-import', 'excludes-wasm32-end-wrap'].includes(key),
        ),
      ),
      'install-receipt-path': linearPath,
      'install-receipt-sha256': linearHash,
    },
    'wasm-features': ['exceptions', 'threads'],
    entrypoint: 'runtime:postgres',
    artifacts,
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}
function synchronize(path: string, directory: boolean, mode?: number) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const info = fstatSync(fd);
    assert(directory ? info.isDirectory() : info.isFile(), 'non-regular sync input');
    if (mode === undefined) fsyncSync(fd);
    else fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}
if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2),
      [root] = args;
    assert(root, 'builder input is required');
    if (command === 'guest-receipt' && args.length === 5) {
      const receipt = guestReceipt(root);
      for (const [index, key] of [
        'core_profile',
        'postgres_tag',
        'postgres_version',
        'sysroot_variant',
      ].entries())
        assert.equal(receipt[key], args[index + 1], `guest ${key} differs`);
    } else if (command === 'source-fingerprint' && args.length === 1)
      console.log(sourceFingerprint(root));
    else if (command === 'manifest') manifest(args);
    else if (command === 'seal' && args.length === 1) {
      const tree = carrierTree(root),
        lines = [];
      for (const [relative, info] of [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        assert(relative !== 'payload.files', 'payload inventory already exists');
        if (!info.isFile()) continue;
        const { size, sha256 } = hashRegular(member(root, relative));
        lines.push(`${sha256}\t${size}\t${relative}`);
        synchronize(member(root, relative), false, info.mode & 0o111 ? 0o555 : 0o444);
      }
      writeFileSync(
        member(root, 'payload.files'),
        `schema=oliphaunt.wasix-postmaster.payload-files.v1\n${lines.join('\n')}\n`,
        { flag: 'wx', mode: 0o444 },
      );
      for (const [relative, info] of [...tree].reverse())
        if (info.isDirectory())
          synchronize(relative === '.' ? root : member(root, relative), true, 0o555);
    } else if (command === 'sync-tree' && args.length === 1) {
      const tree = carrierTree(root);
      for (const [relative, info] of tree)
        if (info.isFile()) synchronize(member(root, relative), false);
      for (const [relative, info] of [...tree].reverse())
        if (info.isDirectory()) synchronize(relative === '.' ? root : member(root, relative), true);
    } else assert.fail('unknown sealed-carrier builder command or arguments');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
