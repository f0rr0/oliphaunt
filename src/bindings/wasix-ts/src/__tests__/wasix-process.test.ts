import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import type { PreparedBrowserRuntime } from '../extensions.js';
import { PostgresError } from '../query.js';
import type { WorkerOpenOptions } from '../rpc.js';
import type { BrowserStorageLease } from '../storage-provider.js';
import {
  composeLifecycleFailure,
  WasixProcess,
  type WasixHost,
  type WasixProcessDependencies,
} from '../wasix-process.js';

describe('WASIX process lifecycle failures', () => {
  it('keeps startup SQLSTATE, reports release failure, and permits reacquisition', async () => {
    let held = false;
    let failFirstRelease = true;
    let acquisitions = 0;
    const dependencies = fakeDependencies(async () => {
      if (held) {
        throw new WasixStorageError('storage is still held', {
          code: 'busy',
          durability: 'unchanged',
        });
      }
      held = true;
      acquisitions += 1;
      return fakeLease(async () => {
        held = false;
        if (failFirstRelease) {
          failFirstRelease = false;
          throw new Error('simulated release diagnostic');
        }
      });
    });

    const first = await rejection(
      WasixProcess.open(openOptions(), fakeHost({ stdout: startupError('3D000') }), dependencies),
    );
    expect(first).toBeInstanceOf(PostgresError);
    expect(first).toMatchObject({ sqlstate: '3D000', postgresMessage: 'database does not exist' });
    expect(first.message).toContain('storage release also failed: simulated release diagnostic');
    expect(first.cause).toBeInstanceOf(AggregateError);
    expect(held).toBe(false);

    const second = await rejection(
      WasixProcess.open(openOptions(), fakeHost({ stdout: startupError('3D000') }), dependencies),
    );
    expect(second).toBeInstanceOf(PostgresError);
    expect(second).toMatchObject({ sqlstate: '3D000' });
    expect(second.message).not.toContain('storage is still held');
    expect(acquisitions).toBe(2);
    expect(held).toBe(false);
  });

  it('preserves storage code and durability while composing cleanup diagnostics', () => {
    const primary = new WasixStorageError('snapshot metadata is corrupt', {
      code: 'corrupt',
      durability: 'unchanged',
    });

    const failure = composeLifecycleFailure(
      primary,
      'storage release also failed',
      new Error('lock'),
    );

    expect(failure).toBeInstanceOf(WasixStorageError);
    expect(failure).toMatchObject({ code: 'corrupt', durability: 'unchanged' });
    expect(failure.message).toContain('snapshot metadata is corrupt');
    expect(failure.message).toContain('storage release also failed: lock');
    expect(failure.cause).toBeInstanceOf(AggregateError);
  });

  it.each([
    {
      label: 'terminate',
      host: { stdout: startupSuccess(), terminateFailure: new Error('terminate transport failed') },
      primary: 'WASIX PostgreSQL terminate failed: terminate transport failed',
    },
    {
      label: 'wait',
      host: { stdout: startupSuccess(), waitFailure: new Error('wait exploded') },
      primary: 'WASIX PostgreSQL wait failed: wait exploded',
    },
    {
      label: 'exit',
      host: { stdout: startupSuccess(), output: { ok: false, code: 7 } },
      primary: 'WASIX PostgreSQL exited with code 7',
    },
  ])('keeps the $label failure primary when storage cleanup also fails', async ({
    host,
    primary,
  }) => {
    const outcomes: string[] = [];
    const dependencies = fakeDependencies(async () =>
      fakeLease(async (_directory, outcome) => {
        outcomes.push(outcome);
        throw new Error('cleanup release failed');
      }),
    );
    const process = await WasixProcess.open(openOptions(), fakeHost(host), dependencies);

    const failure = await rejection(process.close());

    expect(failure.message).toContain(primary);
    expect(failure.message).toContain('storage release also failed: cleanup release failed');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(outcomes).toEqual(['failed']);
  });
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected Error rejection, received ${String(error)}`);
  }
  throw new Error('expected promise to reject');
}

function fakeDependencies(
  acquireStorage: WasixProcessDependencies['acquireStorage'],
): WasixProcessDependencies {
  return {
    async prepareRuntime() {
      return preparedRuntime();
    },
    acquireStorage,
  };
}

function fakeLease(close: BrowserStorageLease['close']): BrowserStorageLease {
  return {
    state: 'existing',
    mount: pgdataMount(),
    async checkpoint() {},
    close,
  };
}

function preparedRuntime(): PreparedBrowserRuntime {
  return {
    layout: {
      module: Uint8Array.of(0),
      mounts: { '/base': pgdataMount() },
    },
    startupGUCs: {},
    setupSql: [],
    storageCompatibility: {
      schema: 'oliphaunt-wasix-pgdata-compatibility-v1',
      runtime: {
        product: 'liboliphaunt-wasix',
        version: '0.1.1',
        manifestSha256: '1'.repeat(64),
        runtimeArchiveSha256: '2'.repeat(64),
        pgdataTemplateSha256: '3'.repeat(64),
        moduleSha256: '4'.repeat(64),
        sourceFingerprint: 'source',
        postgresVersion: '18.4',
      },
      extensions: [],
    },
  };
}

function pgdataMount() {
  return {
    files: {
      PG_VERSION: new TextEncoder().encode('18\n'),
      'global/pg_control': Uint8Array.of(1),
    },
    directories: ['global'],
  };
}

function openOptions(): WorkerOpenOptions {
  return {
    runtime: {
      schema: 'oliphaunt-wasix-runtime-v1',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      runtimeArchive: {
        archive: 'runtime.tar.zst',
        sha256: '1'.repeat(64),
        size: 1,
        source: Uint8Array.of(1),
      },
      pgdataArchive: {
        archive: 'pgdata.tar.zst',
        sha256: '2'.repeat(64),
        size: 1,
        source: Uint8Array.of(2),
      },
      manifest: { sha256: '3'.repeat(64), size: 1, source: Uint8Array.of(3) },
    },
    extensionCarriers: {},
    extensions: [],
    username: 'postgres',
    database: 'postgres',
    startupGUCs: {},
    storage: { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' },
  };
}

type FakeHostOptions = {
  stdout: Uint8Array;
  terminateFailure?: Error;
  waitFailure?: Error;
  output?: { ok: boolean; code: number };
};

function fakeHost(options: FakeHostOptions): WasixHost {
  return {
    Directory: FakeDirectory as unknown as WasixHost['Directory'],
    async init() {},
    async runWasix() {
      let writes = 0;
      return {
        stdin: new WritableStream<Uint8Array>({
          write() {
            writes += 1;
            if (writes > 1 && options.terminateFailure !== undefined) {
              throw options.terminateFailure;
            }
          },
        }),
        stdout: byteStream(options.stdout),
        stderr: byteStream(new Uint8Array()),
        free() {},
        async wait() {
          if (options.waitFailure !== undefined) throw options.waitFailure;
          return options.output ?? { ok: true, code: 0 };
        },
      };
    },
  } as WasixHost;
}

class FakeDirectory {
  readonly #files: Record<string, Uint8Array>;

  constructor(files: Record<string, Uint8Array> = {}) {
    this.#files = files;
  }

  async createDir(): Promise<void> {}

  async readDir(): Promise<[]> {
    return [];
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.#files[path];
    if (value === undefined) throw new Error(`missing fake file ${path}`);
    return value;
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function startupSuccess(): Uint8Array {
  return concatenate([
    backendMessage('R', Uint8Array.of(0, 0, 0, 0)),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function startupError(sqlstate: string): Uint8Array {
  const encoder = new TextEncoder();
  const fields: number[] = [];
  for (const [code, value] of [
    ['S', 'FATAL'],
    ['C', sqlstate],
    ['M', 'database does not exist'],
  ] as const) {
    fields.push(code.charCodeAt(0), ...encoder.encode(value), 0);
  }
  fields.push(0);
  return backendMessage('E', Uint8Array.from(fields));
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
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
