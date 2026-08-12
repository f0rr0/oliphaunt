import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';
import { deserializeWorkerError, serializeWorkerError } from '../rpc.js';
import { indexedDB } from '../storage/indexed-db.js';
import { memory, serializeWasixStorage, type WasixStorage } from '../storage.js';

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

  it('rejects user-authored and structured-cloned lookalikes', () => {
    expect(() =>
      serializeWasixStorage({
        schema: 'oliphaunt-wasix-storage-v1',
        kind: 'memory',
      } as unknown as WasixStorage),
    ).toThrow('must come from @oliphaunt/wasix');

    expect(() => serializeWasixStorage(structuredClone(memory()))).toThrow(
      'must come from @oliphaunt/wasix',
    );
  });

  it('preserves typed storage failures across the worker boundary', () => {
    const original = new WasixStorageError('the prior generation is still current', {
      code: 'checkpoint-failed',
      durability: 'not-persisted',
    });

    const roundTrip = deserializeWorkerError(serializeWorkerError(original));

    expect(roundTrip).toBeInstanceOf(WasixStorageError);
    expect(roundTrip).toMatchObject({
      name: 'WasixStorageError',
      message: 'the prior generation is still current',
      code: 'checkpoint-failed',
      durability: 'not-persisted',
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
