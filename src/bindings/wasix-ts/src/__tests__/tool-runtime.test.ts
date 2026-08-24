import { describe, expect, it } from 'vitest';

import type { Directory } from '../host/index.mjs';
import {
  materializeWasixToolMounts,
  prepareWasixToolAsset,
  releaseWasixToolMounts,
  wasixToolRunOptions,
} from '../tool-runtime.js';

const EMPTY_WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const EMPTY_WASM_SHA256 = '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476';

describe('WASIX frontend-tool preparation', () => {
  it('creates only fresh frontend paths and one fixed process contract', async () => {
    const tool = await prepareWasixToolAsset({
      name: 'psql',
      sha256: EMPTY_WASM_SHA256,
      size: EMPTY_WASM.length,
      source: Uint8Array.from(EMPTY_WASM),
    });
    const mounts = await materializeWasixToolMounts(
      FakeDirectory as unknown as typeof Directory,
      tool,
    );

    expect(Object.keys(mounts)).toEqual(['/bin', '/home', '/tmp']);
    expect((mounts['/bin'] as unknown as FakeDirectory).files.psql).toBe(tool.bytes);
    expect((mounts['/home'] as unknown as FakeDirectory).directories).toEqual(['postgres']);
    expect((mounts['/tmp'] as unknown as FakeDirectory).directories).toEqual([]);
    const options = wasixToolRunOptions(tool, ['--version'], mounts);
    expect(options).toMatchObject({
      program: '/bin/psql',
      args: ['--version'],
      cwd: '/',
      env: {
        OLIPHAUNT_PSQL_NONINTERACTIVE: '1',
        HOME: '/home/postgres',
        PATH: '/bin',
      },
      mount: mounts,
    });
  });

  it('releases partially materialized mounts when a later directory fails', async () => {
    const freed: number[] = [];
    let created = 0;
    class FailingDirectory {
      readonly id = ++created;
      async createDir(): Promise<void> {
        throw new Error('home creation failed');
      }
      free(): void {
        freed.push(this.id);
      }
    }
    const tool = await prepareWasixToolAsset({
      name: 'pg_dump',
      sha256: EMPTY_WASM_SHA256,
      size: EMPTY_WASM.length,
      source: Uint8Array.from(EMPTY_WASM),
    });

    await expect(
      materializeWasixToolMounts(FailingDirectory as unknown as typeof Directory, tool),
    ).rejects.toThrow('home creation failed');
    expect(freed).toEqual([1, 2]);
  });

  it('releases every mount and composes cleanup failures with the primary error', () => {
    const released: string[] = [];
    const mount = (name: string, failure = false) =>
      ({
        free() {
          released.push(name);
          if (failure) throw new Error(`${name} release failed`);
        },
      }) as Directory;
    const primary = new Error('psql trapped');

    let failure: unknown;
    try {
      releaseWasixToolMounts(
        { bin: mount('bin', true), home: mount('home'), tmp: mount('tmp', true) },
        { primary },
      );
    } catch (error) {
      failure = error;
    }
    expect(released).toEqual(['bin', 'home', 'tmp']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      expect.objectContaining({ message: 'bin release failed' }),
      expect.objectContaining({ message: 'tmp release failed' }),
    ]);
  });

  it('reuses an exact ArrayBuffer view for a compiled tool', async () => {
    const source = Uint8Array.from(EMPTY_WASM);

    const prepared = await prepareWasixToolAsset({
      name: 'pg_dump',
      sha256: EMPTY_WASM_SHA256,
      size: source.length,
      source,
    });

    expect(prepared.bytes).toBe(source);
    expect(prepared.module).toBeInstanceOf(WebAssembly.Module);
  });

  it('copies offset and shared-backed tool views into exact ArrayBuffers', async () => {
    const padded = new Uint8Array(EMPTY_WASM.length + 2);
    padded.set(EMPTY_WASM, 1);
    const offset = padded.subarray(1, -1);
    const sources: Uint8Array[] = [offset];
    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(EMPTY_WASM.length));
      shared.set(EMPTY_WASM);
      sources.push(shared);
    }

    for (const source of sources) {
      const prepared = await prepareWasixToolAsset({
        name: 'psql',
        sha256: EMPTY_WASM_SHA256,
        size: source.length,
        source,
      });
      expect(prepared.bytes).toEqual(EMPTY_WASM);
      expect(prepared.bytes).not.toBe(source);
      expect(prepared.bytes.buffer).toBeInstanceOf(ArrayBuffer);
      expect(prepared.bytes.byteOffset).toBe(0);
      expect(prepared.bytes.byteLength).toBe(prepared.bytes.buffer.byteLength);
    }
  });
});

class FakeDirectory {
  readonly files: Record<string, string | Uint8Array>;
  readonly directories: string[] = [];

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = files;
  }

  async createDir(path: string): Promise<void> {
    this.directories.push(path);
  }

  free(): void {}
}
