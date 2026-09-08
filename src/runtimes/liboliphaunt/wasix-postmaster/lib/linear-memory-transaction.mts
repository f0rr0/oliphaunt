#!/usr/bin/env bun
// Under the install-prefix lock, durable backups precede every replacement.
// The receipt is linked last. Recovery either recognizes that commit or rolls back.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStrictJson } from '../../../../shared/artifact-packaging/strict-json.mts';

const SCHEMA = 'oliphaunt.wasix-postmaster.linear-memory-transaction.v1';
const AGGREGATE_SCHEMA = 'oliphaunt.wasix-postmaster.linear-memory-install.v1';
export const AGGREGATE_RELATIVE =
  'share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json';
const aggregateName = basename(AGGREGATE_RELATIVE);
const digestPattern = /^[0-9a-f]{64}$/u;
const initialState = { phase: 'staging', schema: SCHEMA };
type Module = { path: string; 'source-sha256': string; 'sealed-sha256': string };
type Prepared = {
  schema: string;
  phase: string;
  'aggregate-path': string;
  'aggregate-sha256': string;
  modules: Module[];
};
const present = (file: string) => lstatSync(file, { throwIfNoEntry: false });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value: object, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), expected.sort(), 'transaction fields differ');
}
export function safeRelative(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' &&
      !/[\0\t\r\n\\]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'unsafe transaction path',
  );
}
export function member(root: string, relative: string) {
  safeRelative(relative);
  let parent = root;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = present(parent);
    assert(!info || info.isDirectory(), `unsafe transaction parent: ${parent}`);
  }
  return join(root, relative);
}
function syncDirectory(dir: string) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function stableRead(
  file: string,
  consume: (chunk: Buffer) => void,
  max = Number.MAX_SAFE_INTEGER,
) {
  const named = lstatSync(file, { bigint: true });
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const)
      assert.equal(named[key], before[key], `input replaced while opening: ${file}`);
    assert(before.isFile() && before.size <= BigInt(max), `not a bounded regular file: ${file}`);
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, max - size + 1), null);
      if (!count) break;
      size += count;
      assert(size <= max, `transaction input grew: ${file}`);
      consume(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const)
      assert(before[key] === after[key] && after[key] === current[key], `input changed: ${file}`);
    assert.equal(BigInt(size), before.size, `input size changed: ${file}`);
    return before;
  } finally {
    closeSync(fd);
  }
}
function digest(file: string) {
  const hash = createHash('sha256');
  stableRead(file, (chunk) => {
    hash.update(chunk);
  });
  return hash.digest('hex');
}
export function readJson(file: string) {
  const chunks: Buffer[] = [];
  stableRead(file, (chunk) => chunks.push(Buffer.from(chunk)), 16 * 1024 * 1024);
  const value = parseStrictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  assert(object(value), 'transaction JSON must be an object');
  return value;
}
function syncTree(root: string) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    if (item.isDirectory()) syncTree(file);
    else {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert(fstatSync(fd).isFile(), `special transaction entry: ${file}`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  syncDirectory(root);
}
export function atomicFile(destination: string, write: (fd: number) => void, exclusive = false) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      write(fd);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (exclusive) {
      linkSync(temporary, destination);
      unlinkSync(temporary);
    } else renameSync(temporary, destination);
    syncDirectory(dirname(destination));
  } finally {
    if (present(temporary)) unlinkSync(temporary);
  }
}
function writeState(stage: string, state: object, exclusive = false) {
  atomicFile(
    join(stage, 'transaction.json'),
    (fd) => writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`),
    exclusive,
  );
}
function copyDurable(source: string, destination: string) {
  atomicFile(destination, (fd) => {
    const info = stableRead(source, (chunk) => {
      for (let offset = 0; offset < chunk.length; ) {
        const count = writeSync(fd, chunk, offset, chunk.length - offset);
        assert(count > 0, 'transaction copy made no progress');
        offset += count;
      }
    });
    fchmodSync(fd, Number(info.mode & 0o7777n));
  });
}
function removeStage(install: string, stage: string) {
  assert(present(stage)?.isDirectory(), 'transaction stage is not a directory');
  rmSync(stage, { recursive: true });
  syncDirectory(install);
}
function state(stage: string) {
  const file = join(stage, 'transaction.json');
  if (!present(file)) return null;
  const value = readJson(file);
  assert.equal(value.schema, SCHEMA, 'transaction schema differs');
  return value;
}
function modules(value: unknown): asserts value is Module[] {
  assert(Array.isArray(value) && value.length, 'transaction has no modules');
  const seen: string[] = [];
  for (const row of value) {
    assert(object(row), 'transaction module is not an object');
    keys(row, ['path', 'source-sha256', 'sealed-sha256']);
    safeRelative(row.path);
    for (const key of ['source-sha256', 'sealed-sha256'])
      assert(typeof row[key] === 'string' && digestPattern.test(row[key]), 'invalid module digest');
    seen.push(row.path);
  }
  assert.deepEqual(
    seen,
    [...new Set(seen)].sort(),
    'transaction modules must be unique and sorted',
  );
}
function prepared(value: unknown): asserts value is Prepared {
  assert(object(value), 'transaction state is missing');
  keys(value, ['aggregate-path', 'aggregate-sha256', 'modules', 'phase', 'schema']);
  assert(
    value.schema === SCHEMA &&
      value.phase === 'prepared' &&
      value['aggregate-path'] === AGGREGATE_RELATIVE,
    'transaction is not prepared',
  );
  assert(
    typeof value['aggregate-sha256'] === 'string' && digestPattern.test(value['aggregate-sha256']),
    'invalid aggregate digest',
  );
  modules(value.modules);
}
function committed(install: string, value: Prepared) {
  try {
    return (
      digest(member(install, AGGREGATE_RELATIVE)) === value['aggregate-sha256'] &&
      value.modules.every((row) => digest(member(install, row.path)) === row['sealed-sha256'])
    );
  } catch {
    return false;
  }
}
export function initTransaction(install: string, stage: string) {
  mkdirSync(stage, { mode: 0o700 });
  for (const dir of ['modules', 'receipts']) mkdirSync(join(stage, dir));
  writeState(stage, initialState, true);
  syncTree(stage);
  syncDirectory(install);
}
export function prepareTransaction(install: string, stage: string, aggregate: string) {
  assert.deepEqual(state(stage), initialState, 'transaction is not staging');
  const value = readJson(aggregate);
  assert(value.schema === AGGREGATE_SCHEMA && Array.isArray(value.modules), 'invalid aggregate');
  const rows = value.modules.map((row) => ({
    path: row.path,
    'source-sha256': row['source-module-sha256'],
    'sealed-sha256': row['module-sha256'],
  }));
  modules(rows);
  assert.equal(value['module-count'], rows.length, 'aggregate count differs');
  mkdirSync(join(stage, 'originals'));
  for (const row of rows) {
    const live = member(install, row.path);
    assert.equal(digest(live), row['source-sha256'], 'live predecessor differs');
    assert.equal(
      digest(member(join(stage, 'modules'), row.path)),
      row['sealed-sha256'],
      'staged module differs',
    );
    const backup = member(join(stage, 'originals'), row.path);
    copyDurable(live, backup);
    assert.equal(digest(backup), row['source-sha256'], 'backup differs');
  }
  syncTree(stage);
  writeState(stage, {
    schema: SCHEMA,
    phase: 'prepared',
    'aggregate-path': AGGREGATE_RELATIVE,
    'aggregate-sha256': digest(aggregate),
    modules: rows,
  });
  syncTree(stage);
  syncDirectory(install);
}
export function recoverTransaction(install: string, stage: string) {
  if (!present(stage)) return 'none';
  assert(present(stage)?.isDirectory(), 'unsafe transaction stage');
  const value = state(stage);
  if (!value || (value.phase === 'staging' && Object.keys(value).length === 2)) {
    removeStage(install, stage);
    return 'discarded-staging';
  }
  prepared(value);
  if (committed(install, value)) {
    removeStage(install, stage);
    return 'committed';
  }
  const receipt = member(install, AGGREGATE_RELATIVE);
  if (present(receipt)) {
    assert(present(receipt)?.isFile(), 'incomplete aggregate is not regular');
    unlinkSync(receipt);
    syncDirectory(dirname(receipt));
  }
  for (const row of value.modules) {
    const backup = member(join(stage, 'originals'), row.path);
    assert.equal(digest(backup), row['source-sha256'], 'backup differs');
    const live = member(install, row.path);
    if (!present(live) || digest(live) !== row['source-sha256']) copyDurable(backup, live);
  }
  for (const row of value.modules)
    assert.equal(
      digest(member(install, row.path)),
      row['source-sha256'],
      'rollback verification failed',
    );
  removeStage(install, stage);
  return 'rolled-back';
}
export function publishTransaction(install: string, stage: string) {
  const value = state(stage);
  prepared(value);
  const aggregate = join(stage, aggregateName);
  assert.equal(digest(aggregate), value['aggregate-sha256'], 'aggregate changed');
  const receipt = member(install, AGGREGATE_RELATIVE);
  assert(!present(receipt), 'receipt already exists');
  for (const row of value.modules) {
    const live = member(install, row.path),
      staged = member(join(stage, 'modules'), row.path);
    assert.equal(digest(live), row['source-sha256'], 'live module changed');
    assert.equal(digest(staged), row['sealed-sha256'], 'staged module changed');
    renameSync(staged, live);
    syncDirectory(dirname(live));
    assert.equal(digest(live), row['sealed-sha256'], 'published module differs');
  }
  for (const row of value.modules)
    assert.equal(
      digest(member(install, row.path)),
      row['sealed-sha256'],
      'closure changed before commit',
    );
  linkSync(aggregate, receipt);
  syncDirectory(dirname(receipt));
  assert(committed(install, value), 'commit verification failed');
  removeStage(install, stage);
}
if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        'install-root': { type: 'string' },
        stage: { type: 'string' },
        aggregate: { type: 'string' },
      },
    });
    assert(
      positionals.length === 1 && values['install-root'] && values.stage,
      'expected COMMAND --install-root ROOT --stage STAGE',
    );
    const install = realpathSync(values['install-root']),
      stage = resolve(values.stage);
    assert.equal(
      realpathSync(dirname(stage)),
      install,
      'stage must be directly below install root',
    );
    switch (positionals[0]) {
      case 'init':
        initTransaction(install, stage);
        break;
      case 'prepare':
        assert(values.aggregate, 'prepare requires --aggregate');
        prepareTransaction(install, stage, values.aggregate);
        break;
      case 'publish':
        publishTransaction(install, stage);
        break;
      case 'recover':
        console.log(recoverTransaction(install, stage));
        break;
      default:
        throw new Error('unknown transaction command');
    }
  } catch (error) {
    console.error(`linear-memory transaction: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
