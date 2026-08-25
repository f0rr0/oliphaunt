import {
  WasixDatabaseImpl,
  normalizeWasixDatabaseIdentity,
  type WasixDatabaseIdentity,
  type WasixDatabaseSession,
  type WasixPersistenceMode,
  type WasixProtocolConnectionMode,
} from './database.js';
import { WasixStorageError } from './errors.js';
import { type PreparedWasixRuntime, prepareWasixRuntime } from './extensions.js';
import type {
  Directory,
  OliphauntDirectInstance,
  OliphauntPreparedTool,
  OliphauntToolOutput,
  RunWasixOptions,
  WasmerInitOptions,
} from './host/index.mjs';
import { assertSuccessfulStartupResponse, startupPacket } from './pgwire.js';
import { BackupModeExitUnconfirmedError, createPhysicalArchive } from './physical-archive.js';
import { simpleQuery } from './protocol.js';
import { assertSuccessfulQueryResponse, PostgresError } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import {
  acquireWasixStorage,
  canonicalJson,
  type WasixClusterSeedLoader,
  type WasixStorageLease,
  type WasixStorageSyncBoundary,
} from './storage-provider.js';
import type { OliphauntDatabase } from './types.js';
import {
  serveWasixProtocolConnection,
  SynchronousPgDumpConnection,
  type WasixProtocolConnection,
} from './pgwire-connection.js';
import {
  materializeWasixToolMounts,
  prepareWasixToolAsset,
  releaseWasixToolMounts,
  type PreparedWasixToolAsset,
  type WasixPgDumpProcessOptions,
  type WasixToolProcessResult,
  validateWasixToolDescriptor,
  wasixToolAssetIdentity,
  wasixToolRunOptions,
} from './tool-runtime.js';
import {
  compileWasixModule,
  composeLifecycleFailure,
  configureWasixDatabase,
  configureWasixRole,
  describeError,
  materializeWasixMounts,
  wasixPostgresArgs,
  wasixPostgresEnvironment,
} from './wasix-runtime.js';

/** @internal Narrow caller-realm host contract. */
export type DirectWasixHost = Readonly<{
  Directory: typeof Directory;
  init(options?: WasmerInitOptions): Promise<unknown>;
  instantiateOliphauntDirect(
    module: WebAssembly.Module,
    moduleBytes: Uint8Array,
    options: RunWasixOptions,
  ): Promise<OliphauntDirectInstance>;
  prepareOliphauntTool?(module: WebAssembly.Module, moduleBytes: Uint8Array): OliphauntPreparedTool;
  runOliphauntToolDirect?(
    prepared: OliphauntPreparedTool,
    options: RunWasixOptions,
    protocolRead: (maximumBytes: number) => Uint8Array,
    /** Borrowed bytes: synchronously copy; never mutate or retain this view. */
    protocolWrite: (chunk: Uint8Array) => void,
  ): Promise<OliphauntToolOutput>;
}>;

/** @internal Dependency seam for deterministic direct-lifecycle qualification. */
export type DirectWasixDependencies = Readonly<{
  prepareRuntime(options: SerializedOpenOptions): Promise<PreparedWasixRuntime>;
  acquireStorage(
    storage: SerializedOpenOptions['storage'],
    loadClusterSeed: WasixClusterSeedLoader,
    identity: PreparedWasixRuntime['physicalIdentity'],
  ): Promise<WasixStorageLease>;
  compileModule(module: Uint8Array, sha256: string): Promise<WebAssembly.Module>;
}>;

export type DirectWasixEnvironment = 'browser-main' | 'browser-worker' | 'node';

type DirectInstanceFactory = () => Promise<OliphauntDirectInstance>;
type DirectInstanceInitializer = (
  instance: OliphauntDirectInstance,
  storageState: WasixStorageLease['state'],
) => Promise<Uint8Array<ArrayBuffer>>;
type CachedPgDump = Readonly<{
  identity: string;
  asset: PreparedWasixToolAsset;
  prepared: OliphauntPreparedTool;
}>;

const preparedRuntimes = new Map<string, Promise<PreparedWasixRuntime>>();
const MAX_PREPARED_RUNTIMES = 1;
const initializedHosts = new WeakMap<object, Promise<void>>();
const CHROMIUM_SYNC_WASM_LIMIT_BYTES = 8 * 1024 * 1024;
const DIRECT_INSTANCE_DEADLINE_MS = 120_000;

const defaultDependencies: DirectWasixDependencies = {
  prepareRuntime: prepareRuntimeCached,
  acquireStorage: acquireWasixStorage,
  compileModule: compileWasixModule,
};

/** @internal Open PostgreSQL in the caller realm; guest calls are synchronous after setup. */
export async function openWasixDirect(
  options: SerializedOpenOptions,
  host: DirectWasixHost,
): Promise<OliphauntDatabase> {
  const session = await DirectWasixSession.open(options, host, defaultDependencies, 'browser-main');
  return new WasixDatabaseImpl(session);
}

/** @internal Open a direct-memory session inside the dedicated browser worker realm. */
export function openBrowserWorkerSession(
  options: SerializedOpenOptions,
  host: DirectWasixHost,
): Promise<DirectWasixSession> {
  return DirectWasixSession.open(options, host, defaultDependencies, 'browser-worker');
}

/** Owns the caller-realm guest, its mounted PGDATA, and their joint lifecycle. */
/** @internal */
export class DirectWasixSession implements WasixDatabaseSession {
  readonly identity: WasixDatabaseIdentity;
  #instance: OliphauntDirectInstance | undefined;
  readonly #storage: WasixStorageLease;
  readonly #baseDirectory: Directory;
  readonly #instantiate: DirectInstanceFactory;
  readonly #initialize: DirectInstanceInitializer;
  readonly #username: string;
  readonly #host: DirectWasixHost;
  #pgDump: Promise<CachedPgDump> | undefined;
  #pgDumpIdentity: string | undefined;
  #closed = false;
  #failed = false;
  #closeAttempt: Promise<void> | undefined;
  #startupResponse: Uint8Array<ArrayBuffer> = new Uint8Array();

  private constructor(
    instance: OliphauntDirectInstance,
    storage: WasixStorageLease,
    baseDirectory: Directory,
    instantiate: DirectInstanceFactory,
    initialize: DirectInstanceInitializer,
    username: string,
    database: string,
    host: DirectWasixHost,
  ) {
    this.#instance = instance;
    this.#storage = storage;
    this.#baseDirectory = baseDirectory;
    this.#instantiate = instantiate;
    this.#initialize = initialize;
    this.#username = username;
    this.#host = host;
    this.identity = normalizeWasixDatabaseIdentity(username, database);
  }

  static async open(
    options: SerializedOpenOptions,
    host: DirectWasixHost,
    dependencies: DirectWasixDependencies = defaultDependencies,
    environment: DirectWasixEnvironment = 'browser-main',
  ): Promise<DirectWasixSession> {
    if (environment === 'browser-main') assertDirectExtensionCompatibility(options);
    if (options.storage.kind === 'memory' && options.username !== 'postgres') {
      throw newStorageRoleError(options.username);
    }
    const prepared = await dependencies.prepareRuntime(options);
    const eagerClusterSeed =
      options.storage.kind === 'memory' ? prepared.loadClusterSeed() : undefined;
    const [, module] = await Promise.all([
      initializeHost(host),
      dependencies.compileModule(prepared.layout.module, prepared.moduleSha256),
      eagerClusterSeed,
    ]);
    // Acquire persistent ownership only after every non-owning preparation
    // step succeeds, so a compilation rejection cannot strand its lock.
    const storage = await dependencies.acquireStorage(
      options.storage,
      () => {
        if (options.username !== 'postgres') {
          throw newStorageRoleError(options.username);
        }
        return eagerClusterSeed ?? prepared.loadClusterSeed();
      },
      prepared.physicalIdentity,
    );

    let instance: OliphauntDirectInstance | undefined;
    let baseDirectory: Directory | undefined;
    let opened: DirectWasixSession | undefined;
    try {
      const materialized = await materializeWasixMounts(
        host.Directory,
        prepared.layout,
        storage.mount,
        storage.createPgdataDirectory,
      );
      baseDirectory = materialized.baseDirectory;
      const runtimeOptions = { ...options, startupGUCs: prepared.startupGUCs };
      const instantiate = () =>
        instantiateDirectWithDeadline(
          host.instantiateOliphauntDirect(module, prepared.layout.module, {
            program: '/bin/postgres',
            args: wasixPostgresArgs(runtimeOptions),
            cwd: '/',
            env: wasixPostgresEnvironment(runtimeOptions, prepared.icuEnabled),
            mount: materialized.mounts,
          }),
        );
      const initialize: DirectInstanceInitializer = async (candidate, storageState) => {
        const response = candidate.startup(startupPacket(options.username, options.database));
        assertSuccessfulStartupResponse(response);
        await configureWasixDatabase(options, prepared, storageState, async (input) =>
          candidate.execProtocolRaw(input),
        );
        return new Uint8Array(response);
      };
      instance = await instantiate();
      const session = new DirectWasixSession(
        instance,
        storage,
        baseDirectory,
        instantiate,
        initialize,
        options.username,
        options.database,
        host,
      );
      opened = session;
      session.#startupResponse = await initialize(instance, storage.state);
      if (storage.state === 'new') {
        await storage.sync(baseDirectory, 'checkpoint');
      }
      return session;
    } catch (error) {
      let failure = directStartupFailure(error);
      if (opened !== undefined) {
        throw await opened.#closeAfterOpenFailure(failure);
      }
      if (instance !== undefined) {
        try {
          instance.close();
        } catch (closeError) {
          failure = composeLifecycleFailure(
            failure,
            'direct WASIX instance cleanup also failed',
            closeError,
          );
        }
      }
      try {
        await storage.close(baseDirectory, 'failed');
      } catch (releaseError) {
        failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
      }
      if (instance !== undefined) {
        try {
          instance.free();
        } catch (freeError) {
          failure = composeLifecycleFailure(
            failure,
            'direct WASIX allocation release also failed',
            freeError,
          );
        }
      }
      throw failure;
    }
  }

  async exec(input: Uint8Array, persistence: WasixPersistenceMode = 'sync'): Promise<Uint8Array> {
    this.#assertHealthy();
    try {
      const response = this.#currentInstance().execProtocolRaw(input);
      if (persistence === 'sync') {
        await this.#storage.sync(this.#baseDirectory, 'operation');
      }
      return response;
    } catch (error) {
      this.#failed = true;
      if (error instanceof WasixStorageError) throw error;
      return Promise.reject(
        new Error(
          `${describeError(error)}; this database can no longer be used and must be reopened`,
          { cause: error },
        ),
      );
    }
  }

  async execStream(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    persistence: WasixPersistenceMode = 'sync',
  ): Promise<void> {
    this.#assertHealthy();
    try {
      this.#currentInstance().execProtocolStream(input, onChunk);
      if (persistence === 'sync') {
        await this.#storage.sync(this.#baseDirectory, 'operation');
      }
    } catch (error) {
      this.#failed = true;
      if (error instanceof WasixStorageError) throw error;
      throw new Error(
        `${describeError(error)}; this database can no longer be used and must be reopened`,
        { cause: error },
      );
    }
  }

  async runPgDump(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertHealthy();
    if (options.tool.name !== 'pg_dump') {
      throw new TypeError('the same-realm tool path supports only pg_dump');
    }
    const cached = await this.#preparePgDump(options.tool);
    const runTool = this.#host.runOliphauntToolDirect;
    if (runTool === undefined) {
      throw new Error('this WASIX host does not support same-realm pg_dump');
    }
    const mounts = await materializeWasixToolMounts(this.#host.Directory, cached.asset);
    let result: WasixToolProcessResult | undefined;
    let failure: Readonly<{ primary: unknown }> | undefined;
    let connection: SynchronousPgDumpConnection | undefined;
    try {
      result = await this.#runToolSession(
        async () => {
          const activeConnection = new SynchronousPgDumpConnection({
            startupResponse: this.#startupResponse,
            startupIdentity: this.identity,
            exec: (input, onChunk) => {
              this.#currentInstance().execProtocolStream(input, onChunk);
            },
          });
          connection = activeConnection;
          const output = await runTool(
            cached.prepared,
            wasixToolRunOptions(cached.asset, options.args, mounts),
            (maximumBytes) => activeConnection.read(maximumBytes),
            (chunk) => activeConnection.write(chunk),
          );
          activeConnection.finish();
          return {
            exitCode: output.code,
            stdout: output.stdoutBytes,
            stderr: output.stderrBytes,
          };
        },
        () => connection?.protocolStarted === true,
      );
    } catch (error) {
      failure = { primary: error };
    }
    if (failure !== undefined) releaseWasixToolMounts(mounts, failure);
    releaseWasixToolMounts(mounts);
    if (result === undefined) throw new Error('pg_dump completed without a process result');
    return result;
  }

  async serve(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): Promise<void> {
    this.#assertHealthy();
    if (mode === 'tool') {
      await this.#runToolSession(() =>
        serveWasixProtocolConnection(connection, {
          startupResponse: this.#startupResponse,
          startupIdentity: this.identity,
          execDuplex: (input, onRead, onWrite) => {
            this.#currentInstance().execProtocolDuplex(input, onRead, onWrite);
          },
          publishIdle: async () => undefined,
          rollback: async () => {
            const response = this.#currentInstance().execProtocolRaw(simpleQuery('ROLLBACK'));
            assertSuccessfulQueryResponse(response);
          },
        }),
      );
      return;
    }
    try {
      await this.#restartProtocolBackend();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    let primaryFailure: unknown;
    try {
      await serveWasixProtocolConnection(connection, {
        startupResponse: this.#startupResponse,
        startupIdentity: this.identity,
        execDuplex: (input, onRead, onWrite) => {
          this.#currentInstance().execProtocolDuplex(input, onRead, onWrite);
        },
        publishIdle: () => this.#storage.sync(this.#baseDirectory, 'operation'),
        rollback: async () => {
          const response = this.#currentInstance().execProtocolRaw(simpleQuery('ROLLBACK'));
          assertSuccessfulQueryResponse(response);
          await this.#storage.sync(this.#baseDirectory, 'operation');
        },
      });
    } catch (error) {
      primaryFailure = error;
    }
    try {
      await this.#resetProtocolSession();
      await this.#storage.sync(this.#baseDirectory, 'operation');
    } catch (cleanupError) {
      this.#failed = true;
      if (primaryFailure === undefined) throw cleanupError;
      throw composeLifecycleFailure(
        primaryFailure instanceof Error ? primaryFailure : new Error(describeError(primaryFailure)),
        'WASIX server session cleanup also failed',
        cleanupError,
      );
    }
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
  }

  async #runToolSession<T>(
    operation: () => Promise<T>,
    outcomeUnknown: () => boolean = () => true,
  ): Promise<T> {
    try {
      await this.#resetProtocolSession();
    } catch (error) {
      this.#failed = true;
      throw error;
    }

    let result: T | undefined;
    let primaryFailure: unknown;
    try {
      result = await operation();
    } catch (error) {
      primaryFailure = error;
    }
    try {
      await this.#resetProtocolSession();
      await this.#storage.sync(this.#baseDirectory, 'operation');
    } catch (cleanupError) {
      this.#failed = true;
      if (primaryFailure === undefined) throw cleanupError;
      throw composeLifecycleFailure(
        asError(primaryFailure),
        'WASIX tool session cleanup also failed',
        cleanupError,
      );
    }
    if (primaryFailure !== undefined) {
      // A failure before either tool protocol callback is a known host/process
      // failure. Once protocol activity begins, the database outcome may have
      // escaped observation even though reset/publication itself succeeded.
      if (outcomeUnknown()) this.#failed = true;
      throw primaryFailure;
    }
    return result as T;
  }

  #preparePgDump(descriptor: WasixPgDumpProcessOptions['tool']): Promise<CachedPgDump> {
    validateWasixToolDescriptor(descriptor);
    if (descriptor.name !== 'pg_dump') {
      return Promise.reject(new TypeError('the same-realm tool path supports only pg_dump'));
    }
    const identity = wasixToolAssetIdentity(descriptor);
    if (this.#pgDump !== undefined) {
      if (this.#pgDumpIdentity !== identity) {
        return Promise.reject(new Error('this database cannot replace its prepared pg_dump'));
      }
      return this.#pgDump;
    }
    const prepare = this.#host.prepareOliphauntTool;
    if (prepare === undefined) {
      return Promise.reject(new Error('this WASIX host does not support same-realm pg_dump'));
    }
    const pending = prepareWasixToolAsset(descriptor).then((asset) => ({
      identity,
      asset,
      prepared: prepare(asset.module, asset.bytes),
    }));
    this.#pgDumpIdentity = identity;
    this.#pgDump = pending;
    void pending.catch(() => {
      if (this.#pgDump === pending) {
        this.#pgDump = undefined;
        this.#pgDumpIdentity = undefined;
      }
    });
    return pending;
  }

  async #resetProtocolSession(): Promise<void> {
    for (const statement of ['ROLLBACK', 'DISCARD ALL']) {
      const response = this.#currentInstance().execProtocolRaw(simpleQuery(statement));
      assertSuccessfulQueryResponse(response);
    }
    await configureWasixRole(this.#username, async (input) =>
      this.#currentInstance().execProtocolRaw(input),
    );
  }

  async #restartProtocolBackend(): Promise<void> {
    const previous = this.#currentInstance();
    this.#instance = undefined;
    let failure: Error | undefined;
    try {
      previous.close();
    } catch (error) {
      failure = new Error(
        `WASIX PostgreSQL backend restart close failed: ${describeError(error)}`,
        {
          cause: error,
        },
      );
    }
    try {
      previous.free();
    } catch (error) {
      failure =
        failure === undefined
          ? new Error(`WASIX PostgreSQL backend restart release failed: ${describeError(error)}`, {
              cause: error,
            })
          : composeLifecycleFailure(failure, 'backend allocation release also failed', error);
    }
    if (failure !== undefined) throw failure;

    let replacement: OliphauntDirectInstance | undefined;
    try {
      replacement = await this.#instantiate();
      const startupResponse = await this.#initialize(replacement, 'existing');
      this.#instance = replacement;
      this.#startupResponse = startupResponse;
    } catch (error) {
      failure = directStartupFailure(error);
      if (replacement !== undefined) {
        try {
          replacement.close();
        } catch (closeError) {
          failure = composeLifecycleFailure(
            failure,
            'replacement WASIX backend cleanup also failed',
            closeError,
          );
        }
        try {
          replacement.free();
        } catch (freeError) {
          failure = composeLifecycleFailure(
            failure,
            'replacement WASIX backend allocation release also failed',
            freeError,
          );
        }
      }
      throw failure;
    }
  }

  async sync(boundary: WasixStorageSyncBoundary): Promise<void> {
    this.#assertHealthy();
    try {
      await this.#storage.sync(this.#baseDirectory, boundary);
    } catch (error) {
      this.#failed = true;
      if (error instanceof WasixStorageError) {
        throw error;
      }
      throw new WasixStorageError(`WASIX PGDATA ${boundary} failed: ${describeError(error)}`, {
        code: 'publication-failed',
        commitState: 'unknown',
        cause: error,
      });
    }
  }

  async backup(): Promise<Uint8Array> {
    this.#assertHealthy();
    try {
      return await createPhysicalArchive(
        (input) => this.#execBackupProtocol(input),
        this.#baseDirectory,
      );
    } catch (error) {
      if (error instanceof BackupModeExitUnconfirmedError) this.#failed = true;
      throw error;
    }
  }

  async #execBackupProtocol(input: Uint8Array): Promise<Uint8Array> {
    return this.#currentInstance().execProtocolRaw(input);
  }

  close(): Promise<void> {
    this.#closeAttempt ??= this.#closeInner();
    return this.#closeAttempt;
  }

  async #closeInner(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const pendingPgDump = this.#pgDump;
    this.#pgDump = undefined;
    this.#pgDumpIdentity = undefined;

    let failure: Error | undefined;
    const instance = this.#instance;
    this.#instance = undefined;
    if (instance !== undefined) {
      try {
        instance.close();
      } catch (error) {
        failure = new Error(`WASIX PostgreSQL direct close failed: ${describeError(error)}`, {
          cause: error,
        });
      }
    }

    try {
      await this.#storage.close(
        this.#baseDirectory,
        failure === undefined && !this.#failed ? 'clean' : 'failed',
      );
    } catch (error) {
      failure =
        failure === undefined
          ? storageCloseFailure(error)
          : composeLifecycleFailure(failure, 'storage release also failed', error);
    }

    if (instance !== undefined) {
      try {
        instance.free();
      } catch (error) {
        failure =
          failure === undefined
            ? new Error(`direct WASIX allocation release failed: ${describeError(error)}`, {
                cause: error,
              })
            : composeLifecycleFailure(
                failure,
                'direct WASIX allocation release also failed',
                error,
              );
      }
    }

    const pgDump = await pendingPgDump?.catch(() => undefined);
    if (pgDump !== undefined) {
      try {
        pgDump.prepared.free();
      } catch (error) {
        failure =
          failure === undefined
            ? new Error(`prepared pg_dump release failed: ${describeError(error)}`, {
                cause: error,
              })
            : composeLifecycleFailure(failure, 'prepared pg_dump release also failed', error);
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  #assertHealthy(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX direct database is closed');
    }
    if (this.#failed) {
      throw new Error('Oliphaunt WASIX direct database failed; close it and open a new one');
    }
  }

  #currentInstance(): OliphauntDirectInstance {
    const instance = this.#instance;
    if (instance === undefined) {
      throw new Error('Oliphaunt WASIX direct database has no live PostgreSQL backend');
    }
    return instance;
  }

  async #closeAfterOpenFailure(failure: Error): Promise<Error> {
    this.#closed = true;
    this.#failed = true;
    const instance = this.#instance;
    this.#instance = undefined;
    if (instance !== undefined) {
      try {
        instance.close();
      } catch (closeError) {
        failure = composeLifecycleFailure(
          failure,
          'direct WASIX instance cleanup also failed',
          closeError,
        );
      }
    }
    try {
      await this.#storage.close(this.#baseDirectory, 'failed');
    } catch (releaseError) {
      failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
    }
    if (instance !== undefined) {
      try {
        instance.free();
      } catch (freeError) {
        failure = composeLifecycleFailure(
          failure,
          'direct WASIX allocation release also failed',
          freeError,
        );
      }
    }
    return failure;
  }
}

function assertDirectExtensionCompatibility(options: SerializedOpenOptions): void {
  const unsupported = Object.values(options.extensionCarriers)
    .flatMap((carrier) =>
      carrier.install.nativeModules
        .filter((module) => module.size > CHROMIUM_SYNC_WASM_LIMIT_BYTES)
        .map((module) => ({
          extension: carrier.sqlName,
          module,
        })),
    )
    .sort((left, right) => left.extension.localeCompare(right.extension));
  if (unsupported.length === 0) {
    return;
  }
  const detail = unsupported
    .map(
      ({ extension, module }) =>
        `${extension}:${module.path} (${module.size.toLocaleString('en-US')} bytes)`,
    )
    .join(', ');
  throw new TypeError(
    `@oliphaunt/wasix-ts direct execution cannot load native extension modules larger than 8 MiB in Chromium; use execution: "worker" for ${detail}`,
  );
}

function directStartupFailure(error: unknown): Error {
  const protocolResponse = directProtocolResponse(error);
  if (protocolResponse !== undefined) {
    try {
      assertSuccessfulStartupResponse(protocolResponse);
    } catch (postgresError) {
      if (postgresError instanceof Error) {
        return postgresError;
      }
    }
  }
  if (error instanceof WasixStorageError || error instanceof PostgresError) {
    return error;
  }
  return new Error(`WASIX PostgreSQL direct startup failed: ${describeError(error)}`, {
    cause: error,
  });
}

function newStorageRoleError(username: string): WasixStorageError {
  return new WasixStorageError(
    `PostgreSQL username ${JSON.stringify(username)} selects an existing role; new storage must first be opened as postgres`,
    { code: 'unavailable', commitState: 'unchanged' },
  );
}

function directProtocolResponse(error: unknown): Uint8Array | undefined {
  if (typeof error !== 'object' || error === null || !('protocolResponse' in error)) {
    return undefined;
  }
  const response = (error as { protocolResponse?: unknown }).protocolResponse;
  return response instanceof Uint8Array ? response : undefined;
}

function storageCloseFailure(error: unknown): Error {
  if (error instanceof WasixStorageError) {
    return error;
  }
  return new WasixStorageError(`WASIX PGDATA close failed: ${describeError(error)}`, {
    code: 'publication-failed',
    commitState: 'unknown',
    cause: error,
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error));
}

/** @internal Cache verified runtime materialization without caching transient failures. */
export function prepareRuntimeCached(
  options: SerializedOpenOptions,
  prepare: (options: SerializedOpenOptions) => Promise<PreparedWasixRuntime> = prepareWasixRuntime,
): Promise<PreparedWasixRuntime> {
  const identity = preparedRuntimeIdentity(options);
  let prepared = preparedRuntimes.get(identity);
  if (prepared === undefined) {
    const attempt = prepare(options);
    prepared = attempt;
    preparedRuntimes.set(identity, attempt);
    void attempt.catch(() => {
      if (preparedRuntimes.get(identity) === attempt) {
        preparedRuntimes.delete(identity);
      }
    });
    while (preparedRuntimes.size > MAX_PREPARED_RUNTIMES) {
      const oldest = preparedRuntimes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      preparedRuntimes.delete(oldest);
    }
  }
  return prepared;
}

function initializeHost(host: DirectWasixHost): Promise<void> {
  let initialized = initializedHosts.get(host);
  if (initialized === undefined) {
    initialized = host.init({}).then(() => undefined);
    initializedHosts.set(host, initialized);
    void initialized.catch(() => {
      if (initializedHosts.get(host) === initialized) {
        initializedHosts.delete(host);
      }
    });
  }
  return initialized;
}

/** Keep direct host startup observable to every JS event loop and bound genuine stalls. */
function instantiateDirectWithDeadline(
  operation: Promise<OliphauntDirectInstance>,
): Promise<OliphauntDirectInstance> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error(`Oliphaunt WASIX direct startup exceeded ${DIRECT_INSTANCE_DEADLINE_MS}ms`));
    }, DIRECT_INSTANCE_DEADLINE_MS);
    void operation.then(
      (instance) => {
        if (expired) {
          try {
            instance.close();
          } catch {
            // Startup has already failed; continue to release the late allocation.
          }
          try {
            instance.free();
          } catch {
            // The primary timeout remains the actionable failure.
          }
          return;
        }
        clearTimeout(timer);
        resolve(instance);
      },
      (error) => {
        if (expired) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function preparedRuntimeIdentity(options: SerializedOpenOptions): string {
  const runtime = options.runtime;
  return canonicalJson({
    runtime: {
      product: runtime.product,
      version: runtime.version,
      runtimeArchive: assetIdentity(runtime.runtimeArchive),
      standardSeedArchive: assetIdentity(runtime.standardSeedArchive),
      standardSeedManifest: {
        sha256: runtime.standardSeedManifest.sha256,
        size: runtime.standardSeedManifest.size,
      },
      manifest: {
        sha256: runtime.manifest.sha256,
        size: runtime.manifest.size,
      },
    },
    icu:
      options.icu === undefined
        ? null
        : {
            product: options.icu.product,
            version: options.icu.version,
            compatibility: options.icu.compatibility,
            dataArchive: assetIdentity(options.icu.dataArchive),
            clusterSeedArchive: assetIdentity(options.icu.clusterSeedArchive),
            clusterSeedManifest: {
              sha256: options.icu.clusterSeedManifest.sha256,
              size: options.icu.clusterSeedManifest.size,
            },
          },
    extensions: options.extensions,
    carriers: Object.values(options.extensionCarriers)
      .sort((left, right) => left.sqlName.localeCompare(right.sqlName))
      .map(({ source: _source, ...carrier }) => carrier),
    startupGUCs: options.startupGUCs,
  });
}

function assetIdentity(asset: { archive: string; sha256: string; size: number }) {
  return { archive: asset.archive, sha256: asset.sha256, size: asset.size };
}
