import { describe, expect, it } from 'vitest';

import { serializeWasixRuntimeDescriptor } from '../runtime-descriptor.js';
import type { WasixRuntimeDescriptor } from '../types.js';

describe('WASIX runtime descriptors', () => {
  it('serializes one exact runtime identity and preserves package-relative URLs', () => {
    const value = descriptor();
    const serialized = serializeWasixRuntimeDescriptor(value);

    expect(serialized).toMatchObject({
      schema: 'oliphaunt-wasix-runtime-v2',
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
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        product: 'another-runtime',
      }),
    ).toThrow("product must be 'liboliphaunt-wasix'");
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        runtimeArchive: {
          ...descriptor().runtimeArchive,
          archive: '../runtime.tar.zst',
        },
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

  it('requires runtime and standard cluster seed archives to have distinct canonical paths', () => {
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        standardSeedArchive: {
          ...descriptor().standardSeedArchive,
          archive: descriptor().runtimeArchive.archive,
        },
      }),
    ).toThrow('runtime and standard cluster seed archives must have distinct paths');
  });

  it('rejects malformed scalar fields before loading package-owned assets', () => {
    expect(() => serializeWasixRuntimeDescriptor(null)).toThrow('must be an object');
    expect(() => serializeWasixRuntimeDescriptor({ ...descriptor(), version: 'latest' })).toThrow(
      'must be a SemVer version',
    );
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        manifest: { ...descriptor().manifest, sha256: 'A'.repeat(64) },
      }),
    ).toThrow('must be 64 lowercase hexadecimal characters');
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        manifest: { ...descriptor().manifest, size: 0 },
      }),
    ).toThrow('must be a positive safe integer');
    expect(() =>
      serializeWasixRuntimeDescriptor({
        ...descriptor(),
        manifest: { ...descriptor().manifest, source: true },
      }),
    ).toThrow('must be a URL, string, ArrayBuffer, or Uint8Array');
  });

  it('copies byte-backed asset sources at the worker boundary', () => {
    const runtimeBytes = new Uint8Array(100).fill(1);
    const manifestBytes = new Uint8Array(300).fill(3);
    const serialized = serializeWasixRuntimeDescriptor({
      ...descriptor(),
      runtimeArchive: { ...descriptor().runtimeArchive, source: runtimeBytes },
      manifest: { ...descriptor().manifest, source: manifestBytes.buffer },
    });

    runtimeBytes[0] = 9;
    manifestBytes[0] = 9;
    expect(serialized.runtimeArchive.source).toBeInstanceOf(Uint8Array);
    expect((serialized.runtimeArchive.source as Uint8Array)[0]).toBe(1);
    expect(serialized.manifest.source).toBeInstanceOf(Uint8Array);
    expect((serialized.manifest.source as Uint8Array)[0]).toBe(3);
  });
});

function descriptor(): WasixRuntimeDescriptor {
  return {
    schema: 'oliphaunt-wasix-runtime-v2',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '1'.repeat(64),
      size: 100,
      source: new URL('https://example.test/runtime.tar.zst'),
    },
    standardSeedArchive: {
      archive: 'cluster-seeds/standard.tar.zst',
      sha256: '2'.repeat(64),
      size: 200,
      source: new URL('https://example.test/standard-seed.tar.zst'),
    },
    standardSeedManifest: {
      sha256: '4'.repeat(64),
      size: 250,
      source: new URL('https://example.test/standard-seed.json'),
    },
    manifest: {
      sha256: '3'.repeat(64),
      size: 300,
      source: new URL('https://example.test/manifest.json'),
    },
  };
}
