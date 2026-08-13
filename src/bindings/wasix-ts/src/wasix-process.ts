import type { Directory, Instance, WasmerInitOptions } from './host/index.mjs';

import type { BrowserDirectoryMount, BrowserRuntimeLayout } from './archive.js';
import { WasixStorageError } from './errors.js';
import { prepareBrowserRuntime, type PreparedBrowserRuntime } from './extensions.js';
import { assertSuccessfulStartupResponse, PgwireStream, startupPacket } from './pgwire.js';
import { simpleQuery } from './protocol.js';
import { assertSuccessfulQueryResponse, PostgresError } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import { acquireBrowserStorage, type BrowserStorageLease } from './storage-provider.js';

export type WasixHost = Readonly<{
  Directory: typeof Directory;
  init(options?: WasmerInitOptions): Promise<unknown>;
  runWasix(
    module: Uint8Array | WebAssembly.Module,
    options: {
      program: string;
      moduleBytes?: Uint8Array;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      mount: Record<string, Directory>;
    },
  ): Promise<Instance>;
}>;

/** @internal Dependency seam for deterministic lifecycle-failure qualification. */
export type WasixProcessDependencies = Readonly<{
  prepareRuntime(options: SerializedOpenOptions): Promise<PreparedBrowserRuntime>;
  acquireStorage(
    storage: SerializedOpenOptions['storage'],
    template: BrowserDirectoryMount,
    compatibility: PreparedBrowserRuntime['storageCompatibility'],
  ): Promise<BrowserStorageLease>;
  /** Test seam; production caches the verified guest compilation per JS realm. */
  compileModule?(module: Uint8Array, sha256: string): Promise<WebAssembly.Module>;
}>;

const defaultDependencies: WasixProcessDependencies = {
  prepareRuntime: prepareBrowserRuntime,
  acquireStorage: acquireBrowserStorage,
  compileModule: compileWasixModule,
};

let compiledModuleCache: { sha256: string; module: Promise<WebAssembly.Module> } | undefined;

/** @internal Verified-module compilation cache shared by direct opens in one JS realm. */
export function compileWasixModule(
  module: Uint8Array,
  sha256: string,
): Promise<WebAssembly.Module> {
  if (compiledModuleCache?.sha256 !== sha256) {
    const source =
      module.buffer instanceof ArrayBuffer
        ? (module as Uint8Array<ArrayBuffer>)
        : Uint8Array.from(module);
    const compiled = WebAssembly.compile(source);
    compiledModuleCache = { sha256, module: compiled };
    void compiled.catch(() => {
      if (compiledModuleCache?.module === compiled) {
        compiledModuleCache = undefined;
      }
    });
  }
  return compiledModuleCache.module;
}

/** Host-neutral PostgreSQL/WASIX lifecycle shared by browser and Node workers. */
export class WasixProcess {
  readonly #instance: Instance;
  readonly #wire: PgwireStream;
  readonly #stderr: Promise<string>;
  readonly #storage: BrowserStorageLease;
  readonly #baseDirectory: Directory;
  #closed = false;
  #failed = false;

  private constructor(
    instance: Instance,
    wire: PgwireStream,
    stderr: Promise<string>,
    storage: BrowserStorageLease,
    baseDirectory: Directory,
  ) {
    this.#instance = instance;
    this.#wire = wire;
    this.#stderr = stderr;
    this.#storage = storage;
    this.#baseDirectory = baseDirectory;
  }

  static async open(
    options: SerializedOpenOptions,
    host: WasixHost,
    dependencies: WasixProcessDependencies = defaultDependencies,
  ): Promise<WasixProcess> {
    const prepared = await dependencies.prepareRuntime(options);
    const module =
      dependencies.compileModule === undefined
        ? prepared.layout.module
        : await dependencies.compileModule(
            prepared.layout.module,
            prepared.storageCompatibility.runtime.moduleSha256,
          );
    const runtimeOptions = { ...options, startupGUCs: prepared.startupGUCs };
    await host.init({});
    const pgdataTemplate = prepared.layout.mounts['/base'];
    if (pgdataTemplate === undefined) {
      throw new Error('prepared WASIX runtime has no PGDATA mount');
    }
    const storage = await dependencies.acquireStorage(
      options.storage,
      pgdataTemplate,
      prepared.storageCompatibility,
    );

    let instance: Instance | undefined;
    let opened: WasixProcess | undefined;
    let baseDirectory: Directory | undefined;
    try {
      const materialized = await materializeWasixMounts(
        host.Directory,
        prepared.layout,
        storage.mount,
      );
      baseDirectory = materialized.baseDirectory;
      instance = await host.runWasix(module, {
        program: '/bin/oliphaunt',
        moduleBytes: prepared.layout.module,
        args: wasixPostgresArgs(runtimeOptions),
        cwd: '/',
        env: wasixPostgresEnvironment(runtimeOptions),
        mount: materialized.mounts,
      });
      if (instance.stdin === undefined) {
        throw new Error('Wasmer did not expose a writable stdin stream for the WASIX process');
      }

      const stderr = captureText(instance.stderr).catch(
        (error) => `stderr capture failed: ${describeError(error)}`,
      );
      const wire = new PgwireStream(instance.stdout, instance.stdin);
      const process = new WasixProcess(instance, wire, stderr, storage, baseDirectory);
      opened = process;
      assertSuccessfulStartupResponse(
        await wire.startup(startupPacket(options.username, options.database)),
      );
      // The standalone main loop reports its final GUC values and another
      // ReadyForQuery after the explicit startup response. Drain and validate
      // that transition before exposing the session to callers.
      await wire.settleStartup();
      await configureWasixDatabase(options, prepared, storage.state, (input) =>
        process.exec(input),
      );
      return process;
    } catch (error) {
      const detail = opened === undefined ? '' : await opened.#stderrSnapshot();
      let failure: Error =
        error instanceof WasixStorageError || error instanceof PostgresError
          ? error
          : new Error(`WASIX PostgreSQL startup failed: ${describeError(error)}${detail}`, {
              cause: error,
            });
      if (opened !== undefined) {
        throw await opened.#closeAfterOpenFailure(failure);
      }
      if (instance !== undefined) {
        try {
          instance.free();
        } catch (freeError) {
          failure = composeLifecycleFailure(
            failure,
            'WASIX instance cleanup also failed',
            freeError,
          );
        }
      }
      try {
        await storage.close(baseDirectory, 'failed');
      } catch (releaseError) {
        failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
      }
      throw failure;
    }
  }

  async exec(input: Uint8Array): Promise<Uint8Array> {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX process is closed');
    }
    if (this.#failed) {
      throw new Error('Oliphaunt WASIX process failed; close this database and open a new one');
    }
    try {
      return await this.#wire.exchange(input);
    } catch (error) {
      this.#failed = true;
      const detail = await this.#stderrSnapshot();
      throw new Error(
        `${describeError(error)}; this database can no longer be used and must be reopened${detail}`,
      );
    }
  }

  async checkpoint(): Promise<void> {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX process is closed');
    }
    if (this.#failed) {
      throw new Error('Oliphaunt WASIX process failed; close this database and open a new one');
    }
    try {
      await this.#storage.checkpoint(this.#baseDirectory);
    } catch (error) {
      // The preceding PostgreSQL CHECKPOINT may already include committed
      // application work. Do not allow another query or encourage an unsafe
      // retry after the atomic host snapshot failed to publish.
      this.#failed = true;
      if (error instanceof WasixStorageError) {
        throw error;
      }
      throw new WasixStorageError(`WASIX PGDATA checkpoint failed: ${describeError(error)}`, {
        code: 'checkpoint-failed',
        durability: 'unknown',
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // Disposal remains safe after a genuine transport/runtime failure, where
    // stdin/stdout may already be closed. PostgreSQL statement errors are
    // recovered by the transport-scoped host pump and do not enter this path.
    // wait() consumes the Wasmer Instance handle; do not call free() afterwards.
    if (this.#failed) {
      await this.#wire.close().catch(() => undefined);
      await this.#instance.wait().catch(() => undefined);
      await this.#storage.close(this.#baseDirectory, 'failed');
      return;
    }

    let closeError: unknown;
    let closeFailed = false;
    try {
      await this.#wire.close();
    } catch (error) {
      closeError = error;
      closeFailed = true;
    }

    let output: Awaited<ReturnType<Instance['wait']>> | undefined;
    let waitError: unknown;
    try {
      output = await this.#instance.wait();
    } catch (error) {
      waitError = error;
    }
    const detail = await this.#stderrSnapshot();
    let failure: Error | undefined;
    if (closeFailed) {
      failure = new Error(
        `WASIX PostgreSQL terminate failed: ${describeError(closeError)}${detail}`,
        { cause: closeError },
      );
    } else if (waitError !== undefined) {
      failure = new Error(`WASIX PostgreSQL wait failed: ${describeError(waitError)}${detail}`, {
        cause: waitError,
      });
    } else if (output === undefined) {
      failure = new Error(`WASIX PostgreSQL produced no exit result${detail}`);
    } else if (!output.ok || output.code !== 0) {
      failure = new Error(`WASIX PostgreSQL exited with code ${output.code}${detail}`);
    }
    if (failure !== undefined) {
      try {
        await this.#storage.close(this.#baseDirectory, 'failed');
      } catch (releaseError) {
        failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
      }
      throw failure;
    }
    await this.#storage.close(this.#baseDirectory, 'clean');
  }

  async #stderrSnapshot(): Promise<string> {
    const stderr = await Promise.race([
      this.#stderr.catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 100)),
    ]);
    return stderr.length > 0 ? `\nWASIX stderr:\n${stderr}` : '';
  }

  async #closeAfterOpenFailure(failure: Error): Promise<Error> {
    this.#closed = true;
    this.#failed = true;
    try {
      await this.#wire.close();
    } catch (terminateError) {
      failure = composeLifecycleFailure(
        failure,
        'WASIX terminate after failed open also failed',
        terminateError,
      );
    }
    try {
      // wait() is the ownership boundary for a started Wasmer instance.
      await this.#instance.wait();
    } catch (waitError) {
      failure = composeLifecycleFailure(
        failure,
        'WASIX wait after failed open also failed',
        waitError,
      );
    }
    try {
      await this.#storage.close(this.#baseDirectory, 'failed');
    } catch (releaseError) {
      failure = composeLifecycleFailure(failure, 'storage release also failed', releaseError);
    }
    return failure;
  }
}

/** @internal Materialize the exact runtime mounts shared by both execution placements. */
export async function materializeWasixMounts(
  DirectoryConstructor: typeof Directory,
  layout: BrowserRuntimeLayout,
  pgdata: BrowserDirectoryMount,
): Promise<{ mounts: Record<string, Directory>; baseDirectory: Directory }> {
  const mounts: Record<string, Directory> = {};
  for (const [mountPath, contents] of Object.entries(layout.mounts)) {
    mounts[mountPath] = await materializeDirectory(
      DirectoryConstructor,
      mountPath === '/base' ? pgdata : contents,
    );
  }
  const baseDirectory = mounts['/base'];
  if (baseDirectory === undefined) {
    throw new Error('materialized WASIX runtime has no /base mount');
  }
  return { mounts, baseDirectory };
}

async function materializeDirectory(
  DirectoryConstructor: typeof Directory,
  contents: BrowserDirectoryMount,
): Promise<Directory> {
  const directory = new DirectoryConstructor(contents.files);
  const existing = directoriesImpliedByFiles(Object.keys(contents.files));
  const explicit = [...new Set(contents.directories)].sort(compareDirectoryDepth);
  for (const path of explicit) {
    if (existing.has(path)) {
      continue;
    }
    await directory.createDir(path);
    existing.add(path);
  }
  return directory;
}

function directoriesImpliedByFiles(paths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return directories;
}

function compareDirectoryDepth(left: string, right: string): number {
  return left.split('/').length - right.split('/').length || left.localeCompare(right);
}

/** @internal PostgreSQL argv shared by both execution placements. */
export function wasixPostgresArgs(options: SerializedOpenOptions): string[] {
  const args = ['--single', '-F', '-O', '-j'];
  const startupGUCs = { ...options.startupGUCs };
  for (const protectedName of ['exit_on_error']) {
    const configuredName = Object.keys(startupGUCs).find(
      (name) => name.toLowerCase() === protectedName,
    );
    if (configuredName !== undefined) {
      throw new Error(
        `PostgreSQL setting ${JSON.stringify(configuredName)} is managed by @oliphaunt/wasix and cannot be overridden`,
      );
    }
  }
  for (const [name, value] of Object.entries({
    search_path: 'public',
    exit_on_error: 'false',
    log_checkpoints: 'false',
    max_wal_senders: '0',
    max_worker_processes: '0',
    max_parallel_workers: '0',
    max_parallel_workers_per_gather: '0',
    io_method: 'sync',
    wal_buffers: '4MB',
    min_wal_size: '80MB',
    shared_buffers: '128MB',
    ...startupGUCs,
  })) {
    validateGuc(name, value);
    args.push('-c', `${name}=${value}`);
  }
  // Keep a database name that begins with `-` out of PostgreSQL's option
  // parser. PostgreSQL's bundled getopt honors this standard delimiter.
  args.push('-D', '/base', '--', options.database);
  return args;
}

/** @internal PostgreSQL environment shared by both execution placements. */
export function wasixPostgresEnvironment(
  options: SerializedOpenOptions,
): Record<string, string> {
  return {
    PREFIX: '/',
    PGDATA: '/base',
    PGUSER: options.username,
    PGDATABASE: options.database,
    MODE: 'REACT',
    REPL: 'N',
    PGSYSCONFDIR: '/base',
    PGCLIENTENCODING: 'UTF8',
    HOME: '/home/postgres',
    USER: options.username,
    LOGNAME: options.username,
    PATH: '/bin',
    LC_CTYPE: 'C.UTF-8',
    TZ: 'UTC',
    PGTZ: 'UTC',
    PG_COLOR: 'never',
    PROJ_DATA: '/share/proj',
    OLIPHAUNT_WASIX_STDIO_PGWIRE: '1',
  };
}

function validateGuc(name: string, value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
    throw new Error(`invalid PostgreSQL setting name ${JSON.stringify(name)}`);
  }
  if (value.includes('\0')) {
    throw new Error(`PostgreSQL setting ${name} contains a NUL byte`);
  }
}

async function captureText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  while (true) {
    const next = await reader.read();
    if (next.done) {
      tail += decoder.decode();
      return tail.length > 16_384 ? tail.slice(-16_384) : tail;
    }
    tail += decoder.decode(next.value, { stream: true });
    if (tail.length > 16_384) {
      tail = tail.slice(-16_384);
    }
  }
}

/** @internal Normalize lifecycle diagnostics without discarding structured primary errors. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const detailed = (error as Error & { detailedMessage?: unknown }).detailedMessage;
  return typeof detailed === 'string' && detailed.length > 0 && detailed !== error.message
    ? `${error.message}: ${detailed}`
    : error.message;
}

/** @internal Preserve a structured primary while attaching cleanup diagnostics. */
export function composeLifecycleFailure(primary: Error, label: string, secondary: unknown): Error {
  const message = `${primary.message}; ${label}: ${describeError(secondary)}`;
  const cause = new AggregateError(
    [primary, secondary],
    `${label} while handling ${primary.name || 'Error'}`,
  );
  if (primary instanceof PostgresError) {
    const composed = new PostgresError(primary.fields.map((field) => ({ ...field })));
    composed.message = message;
    Object.defineProperty(composed, 'cause', { configurable: true, value: cause });
    return composed;
  }
  if (primary instanceof WasixStorageError) {
    return new WasixStorageError(message, {
      code: primary.code,
      durability: primary.durability,
      cause,
    });
  }
  return new Error(message, { cause });
}

/** @internal Complete extension and role setup after either transport reaches ReadyForQuery. */
export async function configureWasixDatabase(
  options: SerializedOpenOptions,
  prepared: PreparedBrowserRuntime,
  storageState: BrowserStorageLease['state'],
  exec: (input: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  // Imported carrier install contracts own extension lifecycle. Activate them
  // while the fixed bootstrap superuser is selected, then apply the caller's role.
  if (storageState === 'new') {
    for (const sql of prepared.setupSql) {
      assertSuccessfulQueryResponse(await exec(simpleQuery(sql)));
    }
  }
  if (options.username !== 'postgres') {
    const username = options.username.replaceAll('"', '""');
    assertSuccessfulQueryResponse(await exec(simpleQuery(`SET ROLE "${username}"`)));
  }
}
