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

import { openWasixWithWorker, restoreWasix, serializeOpenConfig } from '../client-common.js';
import type { WasixIcuDescriptor, WasixRuntimeDescriptor } from '../types.js';
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
