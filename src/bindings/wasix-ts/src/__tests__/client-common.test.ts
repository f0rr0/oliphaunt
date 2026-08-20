import { describe, expect, it, vi } from 'vitest';

vi.mock('@oliphaunt/liboliphaunt-wasix', () => ({
  default: {
    schema: 'oliphaunt-wasix-runtime-v1',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: 1,
      source: Uint8Array.of(1),
    },
    pgdataArchive: {
      archive: 'prepopulated/pgdata-template.tar.zst',
      sha256: '2'.repeat(64),
      size: 1,
      source: Uint8Array.of(2),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 1,
      source: Uint8Array.of(3),
    },
  },
}));

import { openWasixWithWorker, restoreWasix, serializeOpenConfig } from '../client-common.js';
import type { WasixRuntimeDescriptor } from '../types.js';
import { FakeWorkerPort, workerOpenOptions } from './worker-helpers.js';

describe('WASIX shared client orchestration', () => {
  it('serializes caller configuration without retaining mutable asset buffers', () => {
    const runtimeBytes = new Uint8Array(4).fill(1);
    const options = serializeOpenConfig({
      advanced: { runtime: runtimeDescriptor(runtimeBytes) },
      username: 'app',
      database: 'todos',
      startupGUCs: { search_path: 'app, public' },
    });

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
    options.runtime.pgdataArchive.source = shared;
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
    schema: 'oliphaunt-wasix-runtime-v1',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: runtimeBytes.byteLength,
      source: runtimeBytes,
    },
    pgdataArchive: {
      archive: 'prepopulated/pgdata-template.tar.zst',
      sha256: '2'.repeat(64),
      size: 1,
      source: Uint8Array.of(2),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 1,
      source: Uint8Array.of(3),
    },
  };
}
