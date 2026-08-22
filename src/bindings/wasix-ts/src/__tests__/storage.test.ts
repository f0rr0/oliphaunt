import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';
import type { PersistentWasixStorage } from '../public.js';
import { deserializeWorkerError, serializeWorkerError } from '../rpc.js';
import { indexedDB } from '../storage/indexed-db.js';
import { directory } from '../storage/node.js';
import { opfs } from '../storage/opfs.js';
import { memory, serializeWasixStorage, type WasixStorage } from '../storage.js';

// liboliphaunt-doc-example:wasix-typescript-storage-node
const persistentStorageProof: PersistentWasixStorage[] = [
  indexedDB('type-proof'),
  opfs('type-proof'),
  directory('/type-proof'),
];
// @ts-expect-error Memory storage cannot be a physical-restore destination.
const memoryIsNotPersistent: PersistentWasixStorage = memory();
void persistentStorageProof;
void memoryIsNotPersistent;

type MainPackage = typeof import('../index.js');
const mainPackageOmitsIndexedDb: 'indexedDB' extends keyof MainPackage ? false : true = true;

describe('WASIX storage descriptors', () => {
  it('defaults to memory and keeps storage values opaque', () => {
    expect(serializeWasixStorage(undefined)).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'memory',
    });

    const descriptor = memory();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.keys(descriptor)).toEqual([]);
    expect(serializeWasixStorage(descriptor)).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'memory',
    });
  });

  it('requires selective IndexedDB construction and validates its database name', () => {
    expect(mainPackageOmitsIndexedDb).toBe(true);
    const descriptor = indexedDB('todos');
    expect(Object.keys(descriptor)).toEqual([]);
    expect(serializeWasixStorage(descriptor)).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'indexed-db',
      name: 'todos',
    });

    expect(() => indexedDB('')).toThrow('must be 1-200 characters');
    expect(() => indexedDB('x'.repeat(201))).toThrow('must be 1-200 characters');
    expect(() => indexedDB('bad\0name')).toThrow('without NUL bytes');
  });

  it('constructs an OPFS descriptor with a path-safe database name', () => {
    const descriptor = opfs('todos-v2');
    expect(Object.keys(descriptor)).toEqual([]);
    expect(serializeWasixStorage(descriptor)).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'opfs',
      name: 'todos-v2',
    });

    expect(() => opfs('')).toThrow('must be 1-100 ASCII');
    expect(() => opfs('../escape')).toThrow('must be 1-100 ASCII');
    expect(() => opfs('space name')).toThrow('must be 1-100 ASCII');
  });

  it('requires selective Node directory construction and validates its path', () => {
    const descriptor = directory('./data/with spaces');
    expect(Object.keys(descriptor)).toEqual([]);
    expect(serializeWasixStorage(descriptor)).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'directory',
      path: './data/with spaces',
    });
    const fileUrl = new URL('file:///tmp/data%20space');
    expect(serializeWasixStorage(directory(fileUrl))).toEqual({
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'directory',
      path: fileURLToPath(fileUrl),
    });
    expect(() => directory(new URL('https://example.com/data'))).toThrow(
      'URL must be of scheme file',
    );
    expect(() => directory('')).toThrow('non-empty string');
    expect(() => directory('bad\0path')).toThrow('without NUL bytes');
  });

  it('rejects user-authored and structured-cloned lookalikes', () => {
    expect(() =>
      serializeWasixStorage({
        schema: 'oliphaunt-wasix-storage-v1',
        kind: 'memory',
      } as unknown as WasixStorage),
    ).toThrow('must come from @oliphaunt/wasix-ts');

    expect(() => serializeWasixStorage(structuredClone(memory()))).toThrow(
      'must come from @oliphaunt/wasix-ts',
    );
  });

  it('preserves typed storage failures across the worker boundary', () => {
    const original = new WasixStorageError('the prior generation is still current', {
      code: 'publication-failed',
      commitState: 'not-persisted',
    });

    const roundTrip = deserializeWorkerError(serializeWorkerError(original));

    expect(roundTrip).toBeInstanceOf(WasixStorageError);
    expect(roundTrip).toMatchObject({
      name: 'WasixStorageError',
      message: 'the prior generation is still current',
      code: 'publication-failed',
      commitState: 'not-persisted',
    });
  });

  it('preserves extension bootstrap PostgreSQL errors across the worker boundary', () => {
    const original = new PostgresError([
      { code: 0x53, value: 'ERROR' },
      { code: 0x43, value: '42710' },
      { code: 0x4d, value: 'extension already exists' },
    ]);

    const roundTrip = deserializeWorkerError(serializeWorkerError(original));

    expect(roundTrip).toBeInstanceOf(PostgresError);
    expect(roundTrip).toMatchObject({
      name: 'PostgresError',
      sqlstate: '42710',
      postgresMessage: 'extension already exists',
      fields: original.fields,
    });
  });
});
