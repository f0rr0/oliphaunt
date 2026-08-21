import type { WasixDirectoryMount } from './archive.js';
import {
  WasixDatabaseImpl,
  type WasixDatabaseSession,
  type WasixPersistenceMode,
} from './database.js';
import { WasixStorageError } from './errors.js';
import { type PreparedWasixRuntime, prepareWasixRuntime } from './extensions.js';
import type {
  Directory,
  OliphauntDirectInstance,
  RunWasixOptions,
  WasmerInitOptions,
} from './host/index.mjs';
import { assertSuccessfulStartupResponse, startupPacket } from './pgwire.js';
import { createPhysicalArchive } from './physical-archive.js';
import { PostgresError } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import {
  acquireWasixStorage,
  canonicalJson,
  type WasixStorageLease,
  type WasixStorageSyncBoundary,
} from './storage-provider.js';
import type { OliphauntDatabase } from './types.js';
import {
  compileWasixModule,
  composeLifecycleFailure,
  configureWasixDatabase,
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
}>;

/** @internal Dependency seam for deterministic direct-lifecycle qualification. */
export type DirectWasixDependencies = Readonly<{
  prepareRuntime(options: SerializedOpenOptions): Promise<PreparedWasixRuntime>;
  acquireStorage(
    storage: SerializedOpenOptions['storage'],
    template: WasixDirectoryMount,
    identity: PreparedWasixRuntime['physicalIdentity'],
  ): Promise<WasixStorageLease>;
  compileModule(module: Uint8Array, sha256: string): Promise<WebAssembly.Module>;
}>;

export type DirectWasixEnvironment = 'browser-main' | 'browser-worker' | 'node';

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
  readonly #instance: OliphauntDirectInstance;
  readonly #storage: WasixStorageLease;
  readonly #baseDirectory: Directory;
  #closed = false;
  #failed = false;
  #closeAttempt: Promise<void> | undefined;

  private constructor(
    instance: OliphauntDirectInstance,
    storage: WasixStorageLease,
    baseDirectory: Directory,
  ) {
    this.#instance = instance;
    this.#storage = storage;
    this.#baseDirectory = baseDirectory;
  }

  static async open(
    options: SerializedOpenOptions,
    host: DirectWasixHost,
    dependencies: DirectWasixDependencies = defaultDependencies,
    environment: DirectWasixEnvironment = 'browser-main',
  ): Promise<DirectWasixSession> {
    if (environment === 'browser-main') assertDirectExtensionCompatibility(options);
    const prepared = await dependencies.prepareRuntime(options);
    const pgdataTemplate = prepared.layout.mounts['/base'];
    if (pgdataTemplate === undefined) {
      throw new Error('prepared WASIX runtime has no PGDATA mount');
    }

    await initializeHost(host);
    const module = await dependencies.compileModule(prepared.layout.module, prepared.moduleSha256);
    // Acquire persistent ownership only after every non-owning preparation
    // step succeeds, so a compilation rejection cannot strand its lock.
    const storage = await dependencies.acquireStorage(
      options.storage,
      pgdataTemplate,
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
      );
      baseDirectory = materialized.baseDirectory;
      const runtimeOptions = { ...options, startupGUCs: prepared.startupGUCs };
      instance = await instantiateDirectWithDeadline(
        host.instantiateOliphauntDirect(module, prepared.layout.module, {
          program: '/bin/postgres',
          args: wasixPostgresArgs(runtimeOptions),
          cwd: '/',
          env: wasixPostgresEnvironment(runtimeOptions),
          mount: materialized.mounts,
        }),
      );
      const session = new DirectWasixSession(instance, storage, baseDirectory);
      opened = session;
      assertSuccessfulStartupResponse(
        instance.startup(startupPacket(options.username, options.database)),
      );
      await configureWasixDatabase(options, prepared, storage.state, (input) =>
        session.exec(input),
      );
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
      const response = this.#instance.execProtocolRaw(input);
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

  backup(): Promise<Uint8Array> {
    this.#assertHealthy();
    return createPhysicalArchive(
      (input, persistence) => this.exec(input, persistence),
      this.#baseDirectory,
    );
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

    let failure: Error | undefined;
    try {
      this.#instance.close();
    } catch (error) {
      failure = new Error(`WASIX PostgreSQL direct close failed: ${describeError(error)}`, {
        cause: error,
      });
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

    try {
      this.#instance.free();
    } catch (error) {
      failure =
        failure === undefined
          ? new Error(`direct WASIX allocation release failed: ${describeError(error)}`, {
              cause: error,
            })
          : composeLifecycleFailure(failure, 'direct WASIX allocation release also failed', error);
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

  async #closeAfterOpenFailure(failure: Error): Promise<Error> {
    this.#closed = true;
    this.#failed = true;
    try {
      this.#instance.close();
    } catch (closeError) {
      failure = composeLifecycleFailure(
        failure,
        'direct WASIX instance cleanup also failed',
        closeError,
      );
    }
    try {
      await this.#storage.close(this.#baseDirectory, 'failed');
    } catch (releaseError) {
      failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
    }
    try {
      this.#instance.free();
    } catch (freeError) {
      failure = composeLifecycleFailure(
        failure,
        'direct WASIX allocation release also failed',
        freeError,
      );
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
    void prepared.catch(() => {
      if (preparedRuntimes.get(identity) === prepared) {
        preparedRuntimes.delete(identity);
      }
    });
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
      pgdataArchive: assetIdentity(runtime.pgdataArchive),
      manifest: {
        sha256: runtime.manifest.sha256,
        size: runtime.manifest.size,
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
