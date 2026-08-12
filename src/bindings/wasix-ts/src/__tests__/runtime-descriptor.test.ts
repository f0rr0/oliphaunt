import { describe, expect, it } from 'vitest';

import { serializeWasixRuntimeDescriptor } from '../runtime-descriptor.js';
import type { WasixRuntimeDescriptor } from '../types.js';

describe('WASIX runtime descriptors', () => {
  it('serializes one exact runtime identity and preserves package-relative URLs', () => {
    const value = descriptor();
    const serialized = serializeWasixRuntimeDescriptor(value);

    expect(serialized).toMatchObject({
      schema: 'oliphaunt-wasix-runtime-v1',
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      runtimeArchive: {
        archive: 'oliphaunt.wasix.tar.zst',
        source: 'https://example.test/runtime.tar.zst',
      },
    });
  });

  it('rejects malformed identities, unsafe paths, and partial byte declarations', () => {
    expect(() => serializeWasixRuntimeDescriptor({ ...descriptor(), surprise: true })).toThrow(
      'fields must be exactly',
    );
    expect(() =>
      serializeWasixRuntimeDescriptor({ ...descriptor(), product: 'another-runtime' }),
    ).toThrow("product must be 'liboliphaunt-wasix'");
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        runtimeArchive: { ...descriptor().runtimeArchive, archive: '../runtime.tar.zst' },
      }),
    ).toThrow('must be a safe relative asset path');
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        manifest: {
          ...descriptor().manifest,
          size: 2,
          source: Uint8Array.of(1),
        },
      }),
    ).toThrow('byte length must match declared asset size 2');
  });

  it('requires runtime and PGDATA archives to have distinct canonical paths', () => {
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        pgdataArchive: {
          ...descriptor().pgdataArchive,
          archive: descriptor().runtimeArchive.archive,
        },
      }),
    ).toThrow('runtime and PGDATA archives must have distinct paths');
  });
});

function descriptor(): WasixRuntimeDescriptor {
  return {
    schema: 'oliphaunt-wasix-runtime-v1',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: 100,
      source: new URL('https://example.test/runtime.tar.zst'),
    },
    pgdataArchive: {
      archive: 'prepopulated/pgdata-template.tar.zst',
      sha256: '2'.repeat(64),
      size: 200,
      source: new URL('https://example.test/pgdata.tar.zst'),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 300,
      source: new URL('https://example.test/manifest.json'),
    },
  };
}
