import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';
import {
  compileWasixModule,
  composeLifecycleFailure,
  configureWasixDatabase,
  describeError,
  materializeWasixMounts,
  wasixPostgresEnvironment,
} from '../wasix-runtime.js';
import { workerOpenOptions } from './worker-helpers.js';

describe('WASIX host runtime helpers', () => {
  it('caches successful WebAssembly compilation and evicts rejected entries', async () => {
    const emptyModule = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
    const first = compileWasixModule(emptyModule, 'valid');
    expect(compileWasixModule(emptyModule, 'valid')).toBe(first);
    await expect(first).resolves.toBeInstanceOf(WebAssembly.Module);

    const rejected = compileWasixModule(Uint8Array.of(0), 'invalid');
    await expect(rejected).rejects.toBeInstanceOf(WebAssembly.CompileError);
    expect(compileWasixModule(emptyModule, 'invalid')).not.toBe(rejected);
    await expect(compileWasixModule(emptyModule, 'invalid')).resolves.toBeInstanceOf(
      WebAssembly.Module,
    );
  });

  it('materializes explicit empty directories without duplicating file parents', async () => {
    RecordingDirectory.created = [];
    const result = await materializeWasixMounts(
      RecordingDirectory as never,
      {
        module: Uint8Array.of(),
        mounts: {
          '/runtime': {
            files: { 'share/data/value': Uint8Array.of(1) },
            directories: ['share', 'share/data', 'empty', 'nested/empty'],
          },
        },
      },
      {
        files: { PG_VERSION: new TextEncoder().encode('18\n') },
        directories: ['global', 'pg_wal'],
      },
    );

    expect(result.baseDirectory).toBe(result.mounts['/base']);
    expect(RecordingDirectory.created).toEqual([
      ['empty', 'nested/empty'],
      ['global', 'pg_wal'],
    ]);

    await expect(
      materializeWasixMounts(
        RecordingDirectory as never,
        { module: Uint8Array.of(), mounts: {} },
        undefined,
      ),
    ).rejects.toThrow('did not provide a PGDATA mount');
  });

  it('keeps host environment and lifecycle errors structured', () => {
    const options = workerOpenOptions();
    options.username = 'application';
    options.database = 'todos';
    expect(wasixPostgresEnvironment(options)).toMatchObject({
      PGUSER: 'application',
      PGDATABASE: 'todos',
      OLIPHAUNT_WASIX_SINGLE_BACKEND: '1',
    });

    const detailed = Object.assign(new Error('startup failed'), {
      detailedMessage: 'PostgreSQL rejected startup',
    });
    expect(describeError(detailed)).toBe('startup failed: PostgreSQL rejected startup');
    expect(describeError('guest trapped')).toBe('guest trapped');

    const storage = new WasixStorageError('publish failed', {
      code: 'publication-failed',
      commitState: 'unknown',
    });
    expect(
      composeLifecycleFailure(storage, 'cleanup failed', new Error('close failed')),
    ).toMatchObject({ code: 'publication-failed', commitState: 'unknown' });
    const postgres = new PostgresError([
      { code: 0x43, value: '3D000' },
      { code: 0x4d, value: 'database does not exist' },
    ]);
    expect(composeLifecycleFailure(postgres, 'cleanup failed', 'close trapped')).toMatchObject({
      sqlstate: '3D000',
      message: 'database does not exist',
      cause: expect.any(AggregateError),
    });
    expect(
      composeLifecycleFailure(new Error('open failed'), 'cleanup failed', 'trap').message,
    ).toBe('open failed; cleanup failed: trap');
  });

  it('does not install selected extensions and only applies the quoted caller role', async () => {
    const options = workerOpenOptions();
    options.username = 'app"role';
    const inputs: Uint8Array[] = [];
    await configureWasixDatabase(options, async (input) => {
      inputs.push(input);
      return querySuccess();
    });
    expect(inputs).toHaveLength(1);
    const sql = new TextDecoder().decode(inputs[0]);
    expect(sql).toContain('SET ROLE "app""role"');
    expect(sql).not.toMatch(/CREATE EXTENSION|\bLOAD\b|CREATE SCHEMA/u);
  });
});

class RecordingDirectory {
  static created: string[][] = [];
  readonly #created: string[] = [];

  constructor(_files: Record<string, Uint8Array>) {
    RecordingDirectory.created.push(this.#created);
  }

  async createDir(path: string): Promise<void> {
    this.#created.push(path);
  }
}

function querySuccess(): Uint8Array {
  return concatenate([
    backendMessage('C', new TextEncoder().encode('SELECT 1\0')),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function backendMessage(tag: string, body: Uint8Array): Uint8Array {
  const length = body.length + 4;
  return Uint8Array.of(
    tag.charCodeAt(0),
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...body,
  );
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
