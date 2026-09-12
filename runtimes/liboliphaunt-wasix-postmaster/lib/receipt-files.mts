#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
export const AGGREGATE_RELATIVE =
  'share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json';
const present = (file: string) => lstatSync(file, { throwIfNoEntry: false });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function safeRelative(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' &&
      !/[\0\t\r\n\\]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'unsafe receipt path',
  );
}
export function member(root: string, relative: string) {
  safeRelative(relative);
  let parent = root;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = present(parent);
    assert(!info || info.isDirectory(), `unsafe receipt parent: ${parent}`);
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
      assert(size <= max, `receipt input grew: ${file}`);
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
export function readJson(file: string) {
  const chunks: Buffer[] = [];
  stableRead(file, (chunk) => chunks.push(Buffer.from(chunk)), 16 * 1024 * 1024);
  const value = parseStrictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  assert(object(value), 'receipt JSON must be an object');
  return value;
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
