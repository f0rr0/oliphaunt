import { describe, expect, it, vi } from 'vitest';

vi.mock('@oliphaunt/liboliphaunt-wasix', () => ({
  POSTGRES_MAJOR: 18,
  PHYSICAL_FORMAT: 'wasix-pg18-v1',
  default: {
    schema: 'oliphaunt-wasix-runtime-v2',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: 1,
      source: Uint8Array.of(1),
    },
    standardSeedArchive: {
      archive: 'cluster-seeds/standard.tar.zst',
      sha256: '2'.repeat(64),
      size: 1,
      source: Uint8Array.of(2),
    },
    standardSeedManifest: {
      sha256: '4'.repeat(64),
      size: 1,
      source: Uint8Array.of(4),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 1,
      source: Uint8Array.of(3),
    },
  },
}));

import { restoreWasix, serializeOpenConfig } from '../client-common.js';
import { indexedDB } from '../storage/indexed-db.js';
import type { WasixIcuDescriptor, WasixRuntimeDescriptor } from '../types.js';
import { openWasixWithWorker, restoreWasixWithWorker } from '../worker-rpc.js';
import { FakeWorkerPort, workerOpenOptions } from './worker-helpers.js';

describe('WASIX shared client orchestration', () => {
  // liboliphaunt-doc-example:wasix-typescript-icu
  it('serializes the explicit ICU data and matching seed as one closure', () => {
    const options = serializeOpenConfig(
      { icu: icuDescriptor() },
      runtimeDescriptor(Uint8Array.of(1)),
    );

    expect(options.icu).toMatchObject({
      schema: 'oliphaunt-wasix-icu-v1',
      product: 'oliphaunt-icu',
      compatibility: {
        runtimeProduct: 'liboliphaunt-wasix',
        compatibilityKey: 'wasix-pg18-datum32-v1',
        dataTreeSha256: 'a'.repeat(64),
      },
    });
  });

  it('serializes caller configuration without retaining mutable asset buffers', () => {
    const runtimeBytes = new Uint8Array(4).fill(1);
    const options = serializeOpenConfig(
      {
        username: 'app',
        database: 'todos',
        startupGUCs: { search_path: 'app, public' },
      },
      runtimeDescriptor(runtimeBytes),
    );

    runtimeBytes[0] = 9;
    expect(options).toMatchObject({
      username: 'app',
      database: 'todos',
      startupGUCs: { search_path: 'app, public' },
      storage: { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' },
    });
    expect(options.runtime.runtimeArchive.source).toEqual(Uint8Array.of(1, 1, 1, 1));
  });

  it('canonicalizes case-insensitive GUCs and rejects storage redirection before open', () => {
    const options = serializeOpenConfig(
      { startupGUCs: { work_mem: '1MB', WORK_MEM: '2MB' } },
      runtimeDescriptor(Uint8Array.of(1)),
    );
    expect(options.startupGUCs).toEqual({ work_mem: '2MB' });

    for (const name of ['CONFIG_FILE', 'data_directory']) {
      expect(() =>
        serializeOpenConfig(
          { startupGUCs: { [name]: '/tmp/other' } },
          runtimeDescriptor(Uint8Array.of(1)),
        ),
      ).toThrow('owns PostgreSQL startup GUC');
    }
  });

  it('validates before opening and transfers each distinct runtime buffer once', async () => {
    const port = new FakeWorkerPort();
    const options = workerOpenOptions();
    const shared = Uint8Array.of(1, 2);
    const manifest = Uint8Array.of(3);
    options.runtime.runtimeArchive.source = shared;
    options.runtime.standardSeedArchive.source = shared;
    options.runtime.manifest.source = manifest;
    const validate = vi.fn();
    const opening = openWasixWithWorker(
      (received) => {
        expect(received).toBe(options);
        return port;
      },
      options,
      validate,
    );

    expect(validate).toHaveBeenCalledWith(options);
    const open = port.requests[0];
    expect(open?.message.method).toBe('open');
    expect(open?.transfer).toEqual([shared.buffer, manifest.buffer]);
    if (open === undefined) throw new Error('open request was not posted');
    port.respond({ id: open.message.id, ok: true });
    const database = await opening;

    const closing = database.close();
    await Promise.resolve();
    const close = port.requests[1]?.message;
    if (close === undefined) throw new Error('close request was not posted');
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('rejects restore without an explicit persistent storage target', async () => {
    await expect(restoreWasix(undefined, Uint8Array.of())).rejects.toThrow(
      'WASIX restore requires persistent storage',
    );
  });

  it('runs Worker restore without detaching caller bytes', async () => {
    const port = new FakeWorkerPort();
    const bytes = Uint8Array.of(1, 2, 3);
    const restoring = restoreWasixWithWorker(() => port, indexedDB('restore-target'), bytes);
    const request = port.requests[0];
    expect(request?.message).toMatchObject({ method: 'restore' });
    if (request?.message.method !== 'restore') throw new Error('restore request was not posted');
    expect(request.message.bytes).toEqual(bytes);
    expect(request.message.bytes).not.toBe(bytes);
    expect(request.transfer).toEqual([request.message.bytes.buffer]);
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    port.respond({ id: request.message.id, ok: true });

    await expect(restoring).resolves.toBeUndefined();
    expect(port.terminations).toBe(1);
  });

  it('preserves both Worker restore and termination failures', async () => {
    const port = new FakeWorkerPort();
    port.terminate = () => {
      port.terminations += 1;
      throw new Error('worker termination failed');
    };
    const restoring = restoreWasixWithWorker(
      () => port,
      indexedDB('restore-failure-target'),
      Uint8Array.of(1),
    );
    const request = port.requests[0]?.message;
    if (request === undefined) throw new Error('restore request was not posted');
    port.respond({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'restore failed' },
    });

    const failure = await restoring.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate restore failure');
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: 'restore failed' }),
      expect.objectContaining({ message: 'worker termination failed' }),
    ]);
    expect(port.terminations).toBe(1);
  });
});

function runtimeDescriptor(runtimeBytes: Uint8Array): WasixRuntimeDescriptor {
  return {
    schema: 'oliphaunt-wasix-runtime-v2',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: runtimeBytes.byteLength,
      source: runtimeBytes,
    },
    standardSeedArchive: {
      archive: 'cluster-seeds/standard.tar.zst',
      sha256: '2'.repeat(64),
      size: 1,
      source: Uint8Array.of(2),
    },
    standardSeedManifest: {
      sha256: '4'.repeat(64),
      size: 1,
      source: Uint8Array.of(4),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 1,
      source: Uint8Array.of(3),
    },
  };
}

function icuDescriptor(): WasixIcuDescriptor {
  return {
    schema: 'oliphaunt-wasix-icu-v1',
    runtime: 'wasix',
    product: 'oliphaunt-icu',
    version: '0.1.1',
    compatibility: {
      runtimeProduct: 'liboliphaunt-wasix',
      runtimeVersion: '0.1.1',
      postgresMajor: '18',
      physicalFormat: 'wasix-pg18-v1',
      compatibilityKey: 'wasix-pg18-datum32-v1',
      dataVersion: '76.1',
      dataForm: 'files-le',
      dataTreeSha256: 'a'.repeat(64),
    },
    dataArchive: {
      archive: 'icu-data/icu-data.tar.zst',
      sha256: 'b'.repeat(64),
      size: 1,
      source: Uint8Array.of(1),
    },
    clusterSeedArchive: {
      archive: 'cluster-seeds/icu.tar.zst',
      sha256: 'c'.repeat(64),
      size: 1,
      source: Uint8Array.of(2),
    },
    clusterSeedManifest: {
      sha256: 'd'.repeat(64),
      size: 1,
      source: Uint8Array.of(3),
    },
  };
}
