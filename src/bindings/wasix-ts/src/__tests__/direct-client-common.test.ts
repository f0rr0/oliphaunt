import { describe, expect, it, vi } from 'vitest';

import {
  type DirectWasixDependencies,
  type DirectWasixHost,
  DirectWasixSession,
  prepareRuntimeCached,
} from '../direct-client-common.js';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
} from '../byte-channel.js';
import { WasixStorageError } from '../errors.js';
import type { PreparedWasixRuntime } from '../extensions.js';
import type {
  OliphauntDirectInstance,
  OliphauntPreparedTool,
  OliphauntToolOutput,
  RunWasixOptions,
} from '../host/index.mjs';
import { PostgresError } from '../query.js';
import type { SerializedOpenOptions } from '../rpc.js';
import { WASIX_PHYSICAL_IDENTITY, type WasixStorageLease } from '../storage-provider.js';
import { wasixPostgresArgs } from '../wasix-runtime.js';

const EMPTY_WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const EMPTY_WASM_SHA256 = '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476';
const pgDumpDescriptor = {
  name: 'pg_dump' as const,
  sha256: EMPTY_WASM_SHA256,
  size: EMPTY_WASM.length,
  source: EMPTY_WASM,
};

describe('direct WASIX session lifecycle', () => {
  it('uses PostgreSQL startup GUC name and value grammar', () => {
    const valid = openOptions();
    valid.startupGUCs = {
      _name: '',
      'ext.name$1': 'value',
      '  trimmed_name  ': '  ',
    };
    expect(wasixPostgresArgs(valid)).toEqual(
      expect.arrayContaining(['-c', '_name=', '-c', 'trimmed_name=  ']),
    );
    for (const name of ['1name', '.foo', 'a..b', 'a.1b', 'ext.$name', 'a b']) {
      const invalid = openOptions();
      invalid.startupGUCs = { [name]: 'value' };
      expect(() => wasixPostgresArgs(invalid)).toThrow('must use dot-separated components');
    }
    const invalidValue = openOptions();
    invalidValue.startupGUCs = { valid_name: 'bad\0value' };
    expect(() => wasixPostgresArgs(invalidValue)).toThrow('contains a NUL byte');
  });

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

  it('does not publish partial first-open setup when a later statement fails', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    }, 'new');
    storage.sync = async (_directory, boundary) => {
      events.push(`sync:${boundary}`);
    };
    const responses = [querySuccess(), queryError('22012', 'division by zero')];
    const host = fakeHost({
      events,
      execProtocolRaw() {
        return nextResponse(responses);
      },
    });

    const failure = await rejection(
      DirectWasixSession.open(
        openOptions(),
        host,
        fakeDependencies(storage, preparedRuntime(['SELECT 1', 'SELECT 1 / 0'])),
      ),
    );

    expect(failure).toBeInstanceOf(PostgresError);
    expect(failure).toMatchObject({
      sqlstate: '22012',
      postgresMessage: 'division by zero',
    });
    expect(events).toEqual(['startup', 'exec', 'exec', 'close', 'storage:failed', 'free']);
  });

  it('publishes successful first-open setup once at its final checkpoint boundary', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    }, 'new');
    storage.sync = async (_directory, boundary) => {
      events.push(`sync:${boundary}`);
    };
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({ events }),
      fakeDependencies(storage, preparedRuntime(['SELECT 1', 'SELECT 2'])),
    );

    await session.close();

    expect(events).toEqual([
      'startup',
      'exec',
      'exec',
      'sync:checkpoint',
      'close',
      'storage:clean',
      'free',
    ]);
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

  it('starts a fresh backend for each server client but reuses one backend for tools', async () => {
    const baseHost = fakeHost({});
    let instantiations = 0;
    const host: DirectWasixHost = {
      ...baseHost,
      async instantiateOliphauntDirect(module, moduleBytes, options) {
        instantiations += 1;
        return baseHost.instantiateOliphauntDirect(module, moduleBytes, options);
      },
    };
    const session = await DirectWasixSession.open(
      openOptions(),
      host,
      fakeDependencies(fakeLease(async () => undefined)),
    );

    const serveClosedConnection = async (mode: 'server' | 'tool') => {
      const frontend = createWasixByteChannel();
      closeWasixByteChannel(frontend);
      await session.serve({ frontend, backend: createWasixByteChannel() }, mode);
    };

    expect(instantiations).toBe(1);
    await serveClosedConnection('server');
    expect(instantiations).toBe(2);
    await serveClosedConnection('server');
    expect(instantiations).toBe(3);
    await serveClosedConnection('tool');
    expect(instantiations).toBe(3);
    await session.close();
  });

  it('keeps an existing configured role across a tool session without loading a seed', async () => {
    const queries: string[] = [];
    const options = openOptions();
    options.username = 'app"role';
    options.storage = {
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'directory',
      path: '/database',
    };
    let seedLoads = 0;
    const prepared = preparedRuntime();
    prepared.loadClusterSeed = async () => {
      seedLoads += 1;
      return pgdataMount();
    };
    const session = await DirectWasixSession.open(
      options,
      fakeHost({
        execProtocolRaw(input) {
          queries.push(decodeSimpleQuery(input));
          return querySuccess();
        },
      }),
      fakeDependencies(
        fakeLease(async () => undefined, 'existing'),
        prepared,
      ),
    );
    const frontend = createWasixByteChannel();
    closeWasixByteChannel(frontend);

    await session.serve({ frontend, backend: createWasixByteChannel() }, 'tool');
    await session.close();

    expect(seedLoads).toBe(0);
    expect(queries).toEqual([
      'SET ROLE "app""role"',
      'ROLLBACK',
      'DISCARD ALL',
      'SET ROLE "app""role"',
      'ROLLBACK',
      'DISCARD ALL',
      'SET ROLE "app""role"',
    ]);
  });

  it('reuses prepared pg_dump but creates fresh processes and publishes once per run', async () => {
    let prepareCount = 0;
    let runCount = 0;
    let preparedFreeCount = 0;
    let syncCount = 0;
    const storage = fakeLease(async () => undefined);
    storage.sync = async () => {
      syncCount += 1;
    };
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        prepareTool() {
          prepareCount += 1;
          return {
            free() {
              preparedFreeCount += 1;
            },
          } as OliphauntPreparedTool;
        },
        async runTool() {
          runCount += 1;
          return {
            code: runCount === 1 ? 0 : 7,
            stdoutBytes: Uint8Array.of(runCount),
            stderrBytes: new Uint8Array(),
          };
        },
      }),
      fakeDependencies(storage),
    );

    await expect(session.runPgDump({ tool: pgDumpDescriptor, args: [] })).resolves.toMatchObject({
      exitCode: 0,
      stdout: Uint8Array.of(1),
    });
    await expect(session.runPgDump({ tool: pgDumpDescriptor, args: [] })).resolves.toMatchObject({
      exitCode: 7,
      stdout: Uint8Array.of(2),
    });
    await session.exec(Uint8Array.of(1));
    await session.close();

    expect(prepareCount).toBe(1);
    expect(runCount).toBe(2);
    expect(syncCount).toBe(3);
    expect(preparedFreeCount).toBe(1);
  });

  it('keeps the session usable when pg_dump fails before entering the protocol', async () => {
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        async runTool() {
          throw new Error('pg_dump failed before connect');
        },
      }),
      fakeDependencies(fakeLease(async () => undefined)),
    );

    await expect(session.runPgDump({ tool: pgDumpDescriptor, args: [] })).rejects.toThrow(
      'pg_dump failed before connect',
    );
    await expect(session.exec(Uint8Array.of(1))).resolves.toBeInstanceOf(Uint8Array);
    await session.close();
  });

  it('poisons the session when pg_dump traps after entering its protocol lifecycle', async () => {
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        async runTool(_options, _read, write) {
          write(startupPacket('postgres', 'postgres'));
          throw new Error('pg_dump trapped');
        },
      }),
      fakeDependencies(fakeLease(async () => undefined)),
    );

    await expect(session.runPgDump({ tool: pgDumpDescriptor, args: [] })).rejects.toThrow(
      'pg_dump trapped',
    );
    await expect(session.exec(Uint8Array.of(1))).rejects.toThrow(/database failed/);
    await session.close();
  });

  it('does not poison PostgreSQL when only a private pg_dump mount fails to release', async () => {
    class ToolCleanupFailingDirectory extends FakeDirectory {
      override free(): void {
        if (this.hasFile('pg_dump')) throw new Error('pg_dump mount release failed');
      }
    }
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        Directory: ToolCleanupFailingDirectory,
        async runTool(_options, read, write) {
          write(startupPacket('postgres', 'postgres'));
          read(1024 * 1024);
          write(frontendMessage('X', new Uint8Array()));
          return {
            code: 0,
            stdoutBytes: new Uint8Array(),
            stderrBytes: new Uint8Array(),
          };
        },
      }),
      fakeDependencies(fakeLease(async () => undefined)),
    );

    await expect(session.runPgDump({ tool: pgDumpDescriptor, args: [] })).rejects.toThrow(
      'WASIX tool mount cleanup failed',
    );
    await expect(session.exec(Uint8Array.of(1))).resolves.toBeInstanceOf(Uint8Array);
    await session.close();
  });

  it('overlaps a required memory seed with host initialization and module compilation', async () => {
    const events: string[] = [];
    const seed = deferred<ReturnType<typeof pgdataMount>>();
    const compilation = deferred<WebAssembly.Module>();
    const prepared = preparedRuntime();
    prepared.loadClusterSeed = () => {
      events.push('seed');
      return seed.promise;
    };
    const dependencies: DirectWasixDependencies = {
      async prepareRuntime() {
        return prepared;
      },
      async acquireStorage(_storage, loadClusterSeed) {
        events.push('storage');
        await loadClusterSeed();
        return fakeLease(async () => undefined, 'new');
      },
      compileModule() {
        events.push('compile');
        return compilation.promise;
      },
    };
    const host = fakeHost({
      async init() {
        events.push('host');
      },
    });

    const opening = DirectWasixSession.open(openOptions(), host, dependencies);
    await vi.waitFor(() => expect(events).toEqual(['seed', 'host', 'compile']));
    seed.resolve(pgdataMount());
    compilation.resolve({} as WebAssembly.Module);
    const session = await opening;

    expect(events).toEqual(['seed', 'host', 'compile', 'storage']);
    await session.close();
  });

  it('does not acquire persistent ownership until compilation succeeds', async () => {
    const options = openOptions();
    options.storage = {
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'directory',
      path: '/database',
    };
    const compilation = deferred<WebAssembly.Module>();
    let acquired = false;
    const dependencies: DirectWasixDependencies = {
      async prepareRuntime() {
        return preparedRuntime();
      },
      async acquireStorage() {
        acquired = true;
        return fakeLease(async () => undefined, 'existing');
      },
      compileModule() {
        return compilation.promise;
      },
    };

    const opening = DirectWasixSession.open(options, fakeHost({}), dependencies);
    await Promise.resolve();
    expect(acquired).toBe(false);
    compilation.resolve({} as WebAssembly.Module);
    const session = await opening;

    expect(acquired).toBe(true);
    await session.close();
  });

  it('rejects a non-postgres role before loading a seed for new storage', async () => {
    const options = openOptions();
    options.username = 'app_user';
    let seedLoads = 0;
    let instantiations = 0;
    const prepared = preparedRuntime();
    prepared.loadClusterSeed = async () => {
      seedLoads += 1;
      return pgdataMount();
    };
    const dependencies: DirectWasixDependencies = {
      async prepareRuntime() {
        return prepared;
      },
      async acquireStorage(_storage, loadClusterSeed) {
        await loadClusterSeed();
        throw new Error('unreachable');
      },
      async compileModule() {
        return {} as WebAssembly.Module;
      },
    };

    await expect(
      DirectWasixSession.open(
        options,
        fakeHost({
          async instantiate() {
            instantiations += 1;
            throw new Error('unreachable');
          },
        }),
        dependencies,
      ),
    ).rejects.toThrow('new storage must first be opened as postgres');

    expect(seedLoads).toBe(0);
    expect(instantiations).toBe(0);
  });

  it('poisons a tool session whose protocol outcome is unknown', async () => {
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({}),
      fakeDependencies(fakeLease(async () => undefined)),
    );
    const frontend = createWasixByteChannel();
    failWasixByteChannel(frontend);

    await expect(
      session.serve({ frontend, backend: createWasixByteChannel() }, 'tool'),
    ).rejects.toThrow('byte channel failed');
    await expect(session.exec(Uint8Array.of(1))).rejects.toThrow(
      'Oliphaunt WASIX direct database failed',
    );
    await session.close();
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
    await expect(session.exec(Uint8Array.of(2))).rejects.toThrow(
      'Oliphaunt WASIX direct database failed',
    );
    await session.close();

    expect(events).toEqual(['startup', 'exec', 'close', 'storage:failed', 'free']);
  });

  it('keeps the session reusable after backup validation fails and cleanup is confirmed', async () => {
    const events: string[] = [];
    const responses = [
      queryRows(['000000010000000000000000']),
      queryRows(['000000010000000000000000', 'label', null]),
      querySuccess(),
    ];
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        events,
        execProtocolRaw() {
          return nextResponse(responses);
        },
      }),
      fakeDependencies(fakeLease(async () => {})),
    );

    await expect(session.backup()).rejects.toThrow('pg_backup_start returned an unexpected result');
    await expect(session.exec(Uint8Array.of(1))).resolves.toEqual(querySuccess());
    await session.close();
  });

  it('reaches emergency stop after backup protocol execution throws', async () => {
    const start = queryRows(['000000010000000000000000', String(1024 * 1024)]);
    const stop = queryRows(['000000010000000000000000', 'label', null]);
    for (const scenario of [
      {
        name: 'start',
        failure: 'start transport failed',
        outcomes: [new Error('start transport failed'), stop, querySuccess()],
        backupCalls: 2,
      },
      {
        name: 'first stop',
        failure: 'first stop transport failed',
        outcomes: [start, new Error('first stop transport failed'), stop, querySuccess()],
        backupCalls: 3,
      },
    ]) {
      const events: string[] = [];
      const outcomes = [...scenario.outcomes];
      const session = await DirectWasixSession.open(
        openOptions(),
        fakeHost({
          events,
          execProtocolRaw() {
            return nextProtocolOutcome(outcomes);
          },
        }),
        fakeDependencies(
          fakeLease(async (_directory, outcome) => {
            events.push(`storage:${outcome}`);
          }),
        ),
      );

      await expect(session.backup(), scenario.name).rejects.toThrow(scenario.failure);
      expect(
        events.filter((event) => event === 'exec'),
        scenario.name,
      ).toHaveLength(scenario.backupCalls);
      await expect(session.exec(Uint8Array.of(1)), scenario.name).resolves.toEqual(querySuccess());
      await session.close();
      expect(events.at(-2), scenario.name).toBe('storage:clean');
    }
  });

  it('poisons the session only when backup-mode exit cannot be confirmed', async () => {
    const events: string[] = [];
    const responses = [
      queryRows(['000000010000000000000000', String(1024 * 1024)]),
      queryError('55000', 'first stop failed'),
      queryError('55000', 'emergency stop failed'),
    ];
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({
        events,
        execProtocolRaw() {
          return nextResponse(responses);
        },
      }),
      fakeDependencies(fakeLease(async () => {})),
    );

    await expect(session.backup()).rejects.toThrow('could not confirm leaving backup mode');
    await expect(session.exec(Uint8Array.of(1))).rejects.toThrow(
      'Oliphaunt WASIX direct database failed',
    );
    await session.close();
  });

  it('defers storage publication only when the caller owns the commitState boundary', async () => {
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    });
    storage.sync = async (_directory, boundary) => {
      events.push(`sync:${boundary}`);
    };
    const session = await DirectWasixSession.open(
      openOptions(),
      fakeHost({ events }),
      fakeDependencies(storage),
    );

    await session.exec(Uint8Array.of(1), 'defer');
    await session.exec(Uint8Array.of(2), 'sync');
    await session.sync('checkpoint');
    await session.close();

    expect(events).toEqual([
      'startup',
      'exec',
      'exec',
      'sync:operation',
      'sync:checkpoint',
      'close',
      'storage:clean',
      'free',
    ]);
  });

  it('preserves typed checkpoint and close storage errors', async () => {
    const checkpointFailure = new WasixStorageError('checkpoint generation failed', {
      code: 'publication-failed',
      commitState: 'unknown',
    });
    const closeFailure = new WasixStorageError('storage metadata is corrupt', {
      code: 'corrupt',
      commitState: 'unchanged',
    });
    const events: string[] = [];
    const storage: WasixStorageLease = {
      state: 'existing',
      mount: pgdataMount(),
      async sync() {
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

    await expect(session.sync('checkpoint')).rejects.toBe(checkpointFailure);
    const failure = await rejection(session.close());

    expect(failure).toBe(closeFailure);
    expect(failure).toMatchObject({
      code: 'corrupt',
      commitState: 'unchanged',
    });
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

  it('keeps direct host startup event-loop-visible and releases storage on timeout', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const storage = fakeLease(async (_directory, outcome) => {
      events.push(`storage:${outcome}`);
    });
    try {
      const opening = DirectWasixSession.open(
        openOptions(),
        fakeHost({
          instantiate: () => new Promise<OliphauntDirectInstance>(() => undefined),
        }),
        fakeDependencies(storage),
      );
      const timedOut = expect(opening).rejects.toThrow('direct startup exceeded 120000ms');
      await vi.advanceTimersByTimeAsync(120_000);

      await timedOut;
      expect(events).toEqual(['storage:failed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts rejected runtime preparation so transient asset failures can be retried', async () => {
    const options = openOptions();
    options.startupGUCs.cache_retry_test = crypto.randomUUID();
    const transientFailure = new Error('transient runtime asset failure');
    let attempts = 0;
    const prepared = preparedRuntime();
    const prepare = async (): Promise<PreparedWasixRuntime> => {
      attempts += 1;
      if (attempts === 1) throw transientFailure;
      return prepared;
    };

    await expect(prepareRuntimeCached(options, prepare)).rejects.toBe(transientFailure);
    await expect(prepareRuntimeCached(options, prepare)).resolves.toBe(prepared);

    expect(attempts).toBe(2);
  });

  it('keeps Chromium oversized-module policy on the main realm while allowing workers', async () => {
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
    ).rejects.toThrow(/use execution: "worker" for postgis/);
    expect(prepared).toBe(false);

    const workerSession = await DirectWasixSession.open(
      options,
      fakeHost({}),
      guardedDependencies,
      'browser-worker',
    );
    expect(prepared).toBe(true);
    await workerSession.close();

    prepared = false;
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
    async sync() {},
    close,
  };
}

type FakeHostOptions = {
  Directory?: typeof FakeDirectory;
  events?: string[];
  init?(): Promise<void>;
  startup?(): Uint8Array;
  execProtocolRaw?(input: Uint8Array): Uint8Array;
  execProtocolStream?(onChunk: (chunk: Uint8Array) => void): void;
  close?(): void;
  free?(): void;
  instantiate?(): Promise<OliphauntDirectInstance>;
  prepareTool?(): OliphauntPreparedTool;
  runTool?(
    options: RunWasixOptions,
    read: (maximumBytes: number) => Uint8Array,
    write: (chunk: Uint8Array) => void,
  ): Promise<OliphauntToolOutput>;
};

function fakeHost(options: FakeHostOptions): DirectWasixHost {
  const events = options.events;
  const instance = {
    startup() {
      events?.push('startup');
      return options.startup?.() ?? startupSuccess();
    },
    execProtocolRaw(input: Uint8Array) {
      events?.push('exec');
      return options.execProtocolRaw?.(input) ?? querySuccess();
    },
    execProtocolStream(_input: Uint8Array, onChunk: (chunk: Uint8Array) => void) {
      events?.push('execStream');
      if (options.execProtocolStream !== undefined) {
        options.execProtocolStream(onChunk);
        return;
      }
      onChunk(options.execProtocolRaw?.(_input) ?? querySuccess());
    },
    execProtocolDuplex(
      input: Uint8Array,
      _onRead: (maximumBytes: number) => Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ) {
      this.execProtocolStream(input, onChunk);
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
    Directory: (options.Directory ?? FakeDirectory) as unknown as DirectWasixHost['Directory'],
    async init() {
      await options.init?.();
    },
    async instantiateOliphauntDirect() {
      return options.instantiate?.() ?? instance;
    },
    prepareOliphauntTool() {
      return options.prepareTool?.() ?? ({ free() {} } as OliphauntPreparedTool);
    },
    async runOliphauntToolDirect(_prepared, runOptions, read, write) {
      return (
        (await options.runTool?.(runOptions, read, write)) ?? {
          code: 0,
          stdoutBytes: new Uint8Array(),
          stderrBytes: new Uint8Array(),
        }
      );
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

  hasFile(path: string): boolean {
    return this.#files[path] !== undefined;
  }

  free(): void {}
}

function preparedRuntime(setupSql: string[] = []): PreparedWasixRuntime {
  return {
    layout: {
      module: Uint8Array.of(0),
      mounts: {},
    },
    async loadClusterSeed() {
      return pgdataMount();
    },
    moduleSha256: '4'.repeat(64),
    catalogProfile: 'standard',
    icuEnabled: false,
    startupGUCs: {},
    setupSql,
    physicalIdentity: WASIX_PHYSICAL_IDENTITY,
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
      schema: 'oliphaunt-wasix-runtime-v2',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      runtimeArchive: {
        archive: 'runtime.tar.zst',
        sha256: '1'.repeat(64),
        size: 1,
        source: Uint8Array.of(1),
      },
      standardSeedArchive: {
        archive: 'pgdata.tar.zst',
        sha256: '2'.repeat(64),
        size: 1,
        source: Uint8Array.of(2),
      },
      standardSeedManifest: {
        sha256: '5'.repeat(64),
        size: 1,
        source: Uint8Array.of(5),
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function startupSuccess(): Uint8Array {
  return concatenate([
    backendMessage('R', Uint8Array.of(0, 0, 0, 0)),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  ]);
}

function startupPacket(username: string, database: string): Uint8Array {
  const bytes = new TextEncoder().encode(`user\0${username}\0database\0${database}\0\0`);
  const output = new Uint8Array(8 + bytes.length);
  const view = new DataView(output.buffer);
  view.setInt32(0, output.length);
  view.setInt32(4, 196_608);
  output.set(bytes, 8);
  return output;
}

function frontendMessage(tag: string, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(5 + body.length);
  output[0] = tag.charCodeAt(0);
  new DataView(output.buffer).setInt32(1, body.length + 4);
  output.set(body, 5);
  return output;
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

function queryRows(values: readonly (string | null)[]): Uint8Array {
  const encoder = new TextEncoder();
  const description = new Uint8Array(2 + values.length * 19);
  const descriptionView = new DataView(description.buffer);
  descriptionView.setInt16(0, values.length);
  let descriptionOffset = 2;
  for (let index = 0; index < values.length; index += 1) {
    description[descriptionOffset++] = 0;
    descriptionView.setUint32(descriptionOffset, 0);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, 0);
    descriptionOffset += 2;
    descriptionView.setUint32(descriptionOffset, 25);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, -1);
    descriptionOffset += 2;
    descriptionView.setInt32(descriptionOffset, -1);
    descriptionOffset += 4;
    descriptionView.setInt16(descriptionOffset, 0);
    descriptionOffset += 2;
  }
  const encoded = values.map((value) => (value === null ? null : encoder.encode(value)));
  const row = new Uint8Array(
    2 + encoded.reduce((length, value) => length + 4 + (value?.length ?? 0), 0),
  );
  const rowView = new DataView(row.buffer);
  rowView.setInt16(0, encoded.length);
  let rowOffset = 2;
  for (const value of encoded) {
    rowView.setInt32(rowOffset, value?.length ?? -1);
    rowOffset += 4;
    if (value !== null) {
      row.set(value, rowOffset);
      rowOffset += value.length;
    }
  }
  return concatenate([
    backendMessage('T', description),
    backendMessage('D', row),
    backendMessage('C', encoder.encode('SELECT 1\0')),
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

function decodeSimpleQuery(input: Uint8Array): string {
  expect(input[0]).toBe('Q'.charCodeAt(0));
  return new TextDecoder().decode(input.subarray(5, -1));
}

function nextResponse(responses: Uint8Array[]): Uint8Array {
  const response = responses.shift();
  if (response === undefined) throw new Error('test exhausted direct-session responses');
  return response;
}

function nextProtocolOutcome(outcomes: Array<Uint8Array | Error>): Uint8Array {
  const outcome = outcomes.shift();
  if (outcome === undefined) throw new Error('test exhausted direct-session outcomes');
  if (outcome instanceof Error) throw outcome;
  return outcome;
}
