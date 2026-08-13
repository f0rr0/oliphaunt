import { describe, expect, it } from 'vitest';

import {
  type DirectWasixDependencies,
  type DirectWasixHost,
  DirectWasixSession,
  prepareRuntimeCached,
} from '../direct-client-common.js';
import { WasixStorageError } from '../errors.js';
import type { PreparedWasixRuntime } from '../extensions.js';
import type { OliphauntDirectInstance } from '../host/index.mjs';
import { PostgresError } from '../query.js';
import type { SerializedOpenOptions } from '../rpc.js';
import type { WasixStorageLease } from '../storage-provider.js';

describe('direct WASIX session lifecycle', () => {
  it('keeps startup SQLSTATE while composing cleanup failures in ownership order', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
      throw new Error('storage release failed');
    });
    const host = fakeHost({
      events,
      startup() {
        throw Object.assign(new Error('startup trap'), {
          protocolResponse: startupError('3D000', 'database does not exist'),
        });
      },
      close() {
        events.push('close');
        throw new Error('guest close failed');
      },
      free() {
        events.push('free');
        throw new Error('allocation free failed');
      },
    });

    const failure = await rejection(
      DirectWasixSession.open(openOptions(), host, fakeDependencies(storage)),
    );

    expect(failure).toBeInstanceOf(PostgresError);
    expect(failure).toMatchObject({
      sqlstate: '3D000',
      postgresMessage: 'database does not exist',
    });
    expect(failure.message).toContain('direct WASIX instance cleanup also failed');
    expect(failure.message).toContain('storage release also failed');
    expect(failure.message).toContain('direct WASIX allocation release also failed');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(events).toEqual(['startup', 'close', 'storage:failed', 'free']);
  });

  it('closes an opened guest as failed when extension setup returns PostgreSQL ERROR', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    }, 'new');
    const host = fakeHost({
      events,
      execProtocolRaw() {
        return queryError('22012', 'division by zero');
      },
    });

    const failure = await rejection(
      DirectWasixSession.open(
        openOptions(),
        host,
        fakeDependencies(storage, preparedRuntime(['SELECT 1 / 0'])),
      ),
    );

    expect(failure).toBeInstanceOf(PostgresError);
    expect(failure).toMatchObject({ sqlstate: '22012', postgresMessage: 'division by zero' });
    expect(events).toEqual(['startup', 'exec', 'close', 'storage:failed', 'free']);
  });

  it('closes the guest before publishing storage and frees it last', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    });
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({ events }),
      fakeDependencies(storage),
    );

    await session.close();
    await session.close();

    expect(events).toEqual(['startup', 'close', 'storage:clean', 'free']);
  });

  it('poisons the session after an execution trap and releases storage as failed', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    });
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        events,
        execProtocolRaw() {
          throw new Error('protocol pump trapped');
        },
      }),
      fakeDependencies(storage),
    );

    await expect(session.exec(Uint8Array.of(1))).rejects.toThrow(
      'protocol pump trapped; this database can no longer be used',
    );
    expect(() => session.exec(Uint8Array.of(2))).toThrow('Oliphaunt WASIX direct database failed');
    await session.close();

    expect(events).toEqual(['startup', 'exec', 'close', 'storage:failed', 'free']);
  });

  it('preserves typed checkpoint and close storage errors', async () => {
    const checkpointFailure = new WasixStorageError('checkpoint generation failed', {
      code: 'checkpoint-failed',
      durability: 'unknown',
    });
    const closeFailure = new WasixStorageError('storage metadata is corrupt', {
      code: 'corrupt',
      durability: 'unchanged',
    });
    const events: string[] = [];
    const storage: WasixStorageLease = {
      state: 'existing',
      mount: pgdataMount(),
      async checkpoint() {
        throw checkpointFailure;
      },
      async close(_directory, outcome) {
        events.push(`storage:${outcome}`);
        throw closeFailure;
      },
    };
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({ events }),
      fakeDependencies(storage),
    );

    await expect(session.checkpoint()).rejects.toBe(checkpointFailure);
    const failure = await rejection(session.close());

    expect(failure).toBe(closeFailure);
    expect(failure).toMatchObject({ code: 'corrupt', durability: 'unchanged' });
    expect(events).toEqual(['startup', 'close', 'storage:failed', 'free']);
  });

  it('evicts a rejected host initialization so the same host can be retried', async () => {
    let initializations = 0;
    const host = fakeHost({
      async init() {
        initializations += 1;
        if (initializations === 1) {
          throw new Error('transient host initialization failure');
        }
      },
    });
    const dependencies = fakeDependencies(fakeLease(async () => undefined));

    await expect(DirectWasixSession.open(openOptions(), host, dependencies)).rejects.toThrow(
      'transient host initialization failure',
    );
    const session = await DirectWasixSession.open(openOptions(), host, dependencies);
    await session.close();

    expect(initializations).toBe(2);
  });

  it('evicts rejected runtime preparation so transient asset failures can be retried', async () => {
    const options = openOptions();
    options.startupGUCs.cache_retry_test = crypto.randomUUID();
    const transientFailure = new Error('transient runtime asset failure');
    let attempts = 0;
    const prepare = async (): Promise<PreparedWasixRuntime> => {
      attempts += 1;
      if (attempts === 1) throw transientFailure;
      return preparedRuntime();
    };

    await expect(prepareRuntimeCached(options, prepare)).rejects.toBe(transientFailure);
    await expect(prepareRuntimeCached(options, prepare)).resolves.toEqual(preparedRuntime());

    expect(attempts).toBe(2);
  });

  it('rejects an oversized load-ordered side module without promising an invalid worker fallback', async () => {
    let prepared = false;
    const options = openOptions();
    options.extensionCarriers.postgis = {
      product: 'oliphaunt-extension-postgis',
      version: '0.1.1',
      sqlName: 'postgis',
      archive: 'extensions/postgis.tar.zst',
      sha256: '5'.repeat(64),
      size: 1,
      source: Uint8Array.of(1),
      compatibility: {
        extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
        postgresMajor: '18',
        wasixRuntimeProduct: 'liboliphaunt-wasix',
        wasixRuntimeVersion: '0.1.1',
      },
      install: {
        schema: 'oliphaunt-wasix-extension-install-v1',
        name: 'PostGIS',
        nativeModule: 'postgis-3.so',
        nativeModules: [
          {
            name: 'postgis_deps',
            path: 'lib/postgresql/liboliphaunt_postgis_deps.so',
            sha256: '6'.repeat(64),
            moduleSha256: '6'.repeat(64),
            size: 34_625_031,
          },
        ],
        dependencies: [],
        coreExportsRequired: [],
        loadOrder: ['lib/postgresql/postgis-3.so'],
        lifecycle: {
          createExtension: true,
          loadSql: [],
          postCreateSql: [],
          startupConfig: [],
          preloadRequired: false,
          restartRequired: false,
          sharedMemoryRequired: false,
        },
        installedFiles: ['lib/postgresql/liboliphaunt_postgis_deps.so'],
        unresolvedImports: [],
      },
    };
    options.extensions.push('postgis');
    const dependencies = fakeDependencies(fakeLease(async () => undefined));
    const guardedDependencies: DirectWasixDependencies = {
      ...dependencies,
      async prepareRuntime(value) {
        prepared = true;
        return dependencies.prepareRuntime(value);
      },
    };

    await expect(
      DirectWasixSession.open(options, fakeHost({}), guardedDependencies),
    ).rejects.toThrow(/worker execution does not yet implement.*native load order/);
    expect(prepared).toBe(false);

    const postgisCarrier = options.extensionCarriers.postgis;
    if (postgisCarrier === undefined) throw new Error('postgis test carrier is missing');
    postgisCarrier.install.loadOrder = [];
    await expect(
      DirectWasixSession.open(options, fakeHost({}), guardedDependencies),
    ).rejects.toThrow(/use execution: "worker" for postgis/);
    expect(prepared).toBe(false);

    const nodeSession = await DirectWasixSession.open(
      options,
      fakeHost({}),
      guardedDependencies,
      'node',
    );
    expect(prepared).toBe(true);
    await nodeSession.close();
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
  storage: WasixStorageLease,
  prepared: PreparedWasixRuntime = preparedRuntime(),
): DirectWasixDependencies {
  return {
    async prepareRuntime() {
      return prepared;
    },
    async acquireStorage() {
      return storage;
    },
    async compileModule() {
      return {} as WebAssembly.Module;
    },
  };
}

function fakeLease(
  close: WasixStorageLease['close'],
  state: WasixStorageLease['state'] = 'existing',
): WasixStorageLease {
  return {
    state,
    mount: pgdataMount(),
    async checkpoint() {},
    close,
  };
}

type FakeHostOptions = {
  events?: string[];
  init?(): Promise<void>;
  startup?(): Uint8Array;
  execProtocolRaw?(): Uint8Array;
  close?(): void;
  free?(): void;
};

function fakeHost(options: FakeHostOptions): DirectWasixHost {
  const events = options.events;
  const instance = {
    startup() {
      events?.push('startup');
      return options.startup?.() ?? startupSuccess();
    },
    execProtocolRaw() {
      events?.push('exec');
      return options.execProtocolRaw?.() ?? querySuccess();
    },
    close() {
      if (options.close === undefined) events?.push('close');
      options.close?.();
    },
    free() {
      if (options.free === undefined) events?.push('free');
      options.free?.();
    },
  } as OliphauntDirectInstance;
  return {
    Directory: FakeDirectory as unknown as DirectWasixHost['Directory'],
    async init() {
      await options.init?.();
    },
    async instantiateOliphauntDirect() {
      return instance;
    },
  };
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

function preparedRuntime(setupSql: string[] = []): PreparedWasixRuntime {
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

function startupSuccess(): Uint8Array {
  return concatenate([
    backendMessage('R', Uint8Array.of(0, 0, 0, 0)),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function startupError(sqlstate: string, message: string): Uint8Array {
  return errorResponse('FATAL', sqlstate, message);
}

function queryError(sqlstate: string, message: string): Uint8Array {
  return concatenate([
    errorResponse('ERROR', sqlstate, message),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function querySuccess(): Uint8Array {
  return concatenate([
    backendMessage('C', new TextEncoder().encode('SELECT 1\0')),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
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
