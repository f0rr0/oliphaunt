import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import type { PreparedBrowserRuntime } from '../extensions.js';
import { PostgresError } from '../query.js';
import type { SerializedOpenOptions } from '../rpc.js';
import type { BrowserStorageLease } from '../storage-provider.js';
import {
  composeLifecycleFailure,
  compileWasixModule,
  WasixProcess,
  type WasixHost,
  type WasixProcessDependencies,
} from '../wasix-process.js';

describe('WASIX process lifecycle failures', () => {
  it('coalesces verified guest compilation by module identity', async () => {
    const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
    const identity = `test-${crypto.randomUUID()}`;

    const first = compileWasixModule(bytes, identity);
    const second = compileWasixModule(bytes.slice(), identity);

    expect(second).toBe(first);
    await expect(first).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it('keeps startup SQLSTATE, reports release failure, and permits reacquisition', async () => {
    let held = false;
    let failFirstRelease = true;
    let acquisitions = 0;
    const lifecycle = { frees: 0, terminates: 0, waits: 0 };
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
      WasixProcess.open(
        openOptions(),
        fakeHost({ stdout: startupError('3D000'), lifecycle }),
        dependencies,
      ),
    );
    expect(first).toBeInstanceOf(PostgresError);
    expect(first).toMatchObject({ sqlstate: '3D000', postgresMessage: 'database does not exist' });
    expect(first.message).toContain('storage release also failed: simulated release diagnostic');
    expect(first.cause).toBeInstanceOf(AggregateError);
    expect(held).toBe(false);

    const second = await rejection(
      WasixProcess.open(
        openOptions(),
        fakeHost({ stdout: startupError('3D000'), lifecycle }),
        dependencies,
      ),
    );
    expect(second).toBeInstanceOf(PostgresError);
    expect(second).toMatchObject({ sqlstate: '3D000' });
    expect(second.message).not.toContain('storage is still held');
    expect(acquisitions).toBe(2);
    expect(held).toBe(false);
    expect(lifecycle).toEqual({ frees: 0, terminates: 2, waits: 2 });
  });

  it('terminates and awaits a healthy guest when extension setup fails', async () => {
    const lifecycle = { frees: 0, terminates: 0, waits: 0 };
    const events: string[] = [];
    const outcomes: string[] = [];
    const dependencies = fakeDependencies(
      async () =>
        fakeLease(async (_directory, outcome) => {
          events.push('storage');
          outcomes.push(outcome);
        }, 'new'),
      preparedRuntime(['SELECT 1 / 0']),
    );

    const failure = await rejection(
      WasixProcess.open(
        openOptions(),
        fakeHost({
          stdout: concatenate([startupSuccess(), queryError('22012', 'division by zero')]),
          lifecycle,
          events,
        }),
        dependencies,
      ),
    );

    expect(failure).toBeInstanceOf(PostgresError);
    expect(failure).toMatchObject({ sqlstate: '22012', postgresMessage: 'division by zero' });
    expect(lifecycle).toEqual({ frees: 0, terminates: 1, waits: 1 });
    expect(outcomes).toEqual(['failed']);
    expect(events).toEqual(['wait', 'storage']);
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
      host: {
        stdout: concatenate([startupSuccess(), querySuccess()]),
        terminateFailure: new Error('terminate transport failed'),
      },
      primary: 'WASIX PostgreSQL terminate failed: terminate transport failed',
    },
    {
      label: 'wait',
      host: {
        stdout: concatenate([startupSuccess(), querySuccess()]),
        waitFailure: new Error('wait exploded'),
      },
      primary: 'WASIX PostgreSQL wait failed: wait exploded',
    },
    {
      label: 'exit',
      host: {
        stdout: concatenate([startupSuccess(), querySuccess()]),
        output: { ok: false, code: 7 },
      },
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
  prepared: PreparedBrowserRuntime = preparedRuntime(),
): WasixProcessDependencies {
  return {
    async prepareRuntime() {
      return prepared;
    },
    acquireStorage,
  };
}

function fakeLease(
  close: BrowserStorageLease['close'],
  state: BrowserStorageLease['state'] = 'existing',
): BrowserStorageLease {
  return {
    state,
    mount: pgdataMount(),
    async checkpoint() {},
    close,
  };
}

function preparedRuntime(setupSql: string[] = []): PreparedBrowserRuntime {
  return {
    layout: {
      module: Uint8Array.of(0),
      mounts: { '/base': pgdataMount() },
    },
    startupGUCs: {},
    setupSql,
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

function openOptions(): SerializedOpenOptions {
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
  lifecycle?: { frees: number; terminates: number; waits: number };
  events?: string[];
};

function fakeHost(options: FakeHostOptions): WasixHost {
  return {
    Directory: FakeDirectory as unknown as WasixHost['Directory'],
    async init() {},
    async runWasix() {
      return {
        stdin: new WritableStream<Uint8Array>({
          write(value) {
            const terminate = value[0] === 'X'.charCodeAt(0);
            if (terminate && options.lifecycle !== undefined) {
              options.lifecycle.terminates += 1;
            }
            if (terminate && options.terminateFailure !== undefined) {
              throw options.terminateFailure;
            }
          },
        }),
        stdout: byteStream(options.stdout),
        stderr: byteStream(new Uint8Array()),
        free() {
          if (options.lifecycle !== undefined) options.lifecycle.frees += 1;
        },
        async wait() {
          if (options.lifecycle !== undefined) options.lifecycle.waits += 1;
          if (options.events !== undefined) {
            options.events.push('wait');
          }
          if (options.waitFailure !== undefined) throw options.waitFailure;
          return {
            stdoutBytes: new Uint8Array(),
            stdout: '',
            stderrBytes: new Uint8Array(),
            stderr: '',
            ...(options.output ?? { ok: true, code: 0 }),
          };
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
  return errorResponse('FATAL', sqlstate, 'database does not exist');
}

function queryError(sqlstate: string, message: string): Uint8Array {
  return concatenate([
    errorResponse('ERROR', sqlstate, message),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function querySuccess(): Uint8Array {
  return backendMessage('Z', Uint8Array.of('I'.charCodeAt(0)));
}

function errorResponse(severity: string, sqlstate: string, message: string): Uint8Array {
  const encoder = new TextEncoder();
  const fields: number[] = [];
  for (const [code, value] of [
    ['S', severity],
    ['C', sqlstate],
    ['M', message],
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
