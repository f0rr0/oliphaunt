import type { WasixDirectoryMount, WasixRuntimeLayout } from './archive.js';
import { WasixStorageError } from './errors.js';
import type { PreparedWasixRuntime } from './extensions.js';
import type { Directory } from './host/index.mjs';
import { simpleQuery } from './protocol.js';
import { assertSuccessfulQueryResponse, PostgresError } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { WasixStorageLease } from './storage-provider.js';

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

/** @internal Materialize the exact runtime mounts shared by both execution placements. */
export async function materializeWasixMounts(
  DirectoryConstructor: typeof Directory,
  layout: WasixRuntimeLayout,
  pgdata: WasixDirectoryMount | undefined,
  createPgdataDirectory?: (DirectoryConstructor: typeof Directory) => Promise<Directory>,
): Promise<{ mounts: Record<string, Directory>; baseDirectory: Directory }> {
  const mounts = await materializeMountMap(DirectoryConstructor, layout);
  let baseDirectory: Directory;
  if (createPgdataDirectory !== undefined) {
    baseDirectory = await createPgdataDirectory(DirectoryConstructor);
  } else {
    if (pgdata === undefined) {
      throw new Error('portable WASIX storage did not provide a PGDATA mount');
    }
    baseDirectory = await materializeDirectory(DirectoryConstructor, pgdata);
  }
  mounts['/base'] = baseDirectory;
  return { mounts, baseDirectory };
}

/** @internal Materialize runtime support mounts for frontend tools. */
export function materializeWasixSupportMounts(
  DirectoryConstructor: typeof Directory,
  layout: Pick<WasixRuntimeLayout, 'mounts'>,
): Promise<Record<string, Directory>> {
  return materializeMountMap(DirectoryConstructor, layout);
}

async function materializeMountMap(
  DirectoryConstructor: typeof Directory,
  layout: Pick<WasixRuntimeLayout, 'mounts'>,
): Promise<Record<string, Directory>> {
  const mounts: Record<string, Directory> = {};
  for (const [mountPath, contents] of Object.entries(layout.mounts)) {
    mounts[mountPath] = await materializeDirectory(DirectoryConstructor, contents);
  }
  return mounts;
}

async function materializeDirectory(
  DirectoryConstructor: typeof Directory,
  contents: WasixDirectoryMount,
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
  const args = ['--single'];
  if (options.storage.kind === 'memory') args.push('-F');
  args.push('-O', '-j');
  const startupGUCs = Object.fromEntries(
    Object.entries(options.startupGUCs).map(([name, value]) => [name.trim(), value]),
  );
  for (const [configuredName, configuredValue] of Object.entries(startupGUCs)) {
    const managed = Object.entries(SINGLE_BACKEND_GUCS).find(
      ([name]) => name === configuredName.toLowerCase(),
    );
    if (managed === undefined) continue;
    const [, requiredValue] = managed;
    if (configuredValue !== requiredValue) {
      throw new Error(
        `PostgreSQL startup GUC ${JSON.stringify(configuredName)} is managed by @oliphaunt/wasix-ts and must remain ${JSON.stringify(requiredValue)}`,
      );
    }
    delete startupGUCs[configuredName];
  }
  for (const [name, value] of Object.entries({
    search_path: 'public',
    log_checkpoints: 'false',
    wal_buffers: '4MB',
    min_wal_size: '80MB',
    shared_buffers: '128MB',
    ...SINGLE_BACKEND_GUCS,
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

const SINGLE_BACKEND_GUCS = {
  exit_on_error: 'false',
  max_wal_senders: '0',
  max_worker_processes: '0',
  max_parallel_workers: '0',
  max_parallel_workers_per_gather: '0',
  max_parallel_maintenance_workers: '0',
  io_method: 'sync',
  // WASIX VirtualFile cannot represent PostgreSQL's O_DSYNC open flag.
  // fdatasync keeps the durability boundary explicit for direct storage.
  wal_sync_method: 'fdatasync',
} as const;

/** @internal PostgreSQL environment shared by both execution placements. */
export function wasixPostgresEnvironment(
  options: SerializedOpenOptions,
  icuEnabled = false,
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
    ...(icuEnabled ? { ICU_DATA: '/share/icu' } : {}),
    // The canonical guest specializes backend atomics for a one-backend
    // WebAssembly instance. Every host placement must enforce that invariant.
    OLIPHAUNT_WASIX_SINGLE_BACKEND: '1',
  };
}

function validateGuc(name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/u.test(name)) {
    throw new Error(
      `PostgreSQL startup GUC name ${JSON.stringify(name)} must use dot-separated components that start with an ASCII letter or '_' and continue with ASCII letters, digits, '_', or '$'`,
    );
  }
  if (value.includes('\0')) {
    throw new Error(`PostgreSQL startup GUC ${JSON.stringify(name)} contains a NUL byte`);
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
    Object.defineProperty(composed, 'cause', {
      configurable: true,
      value: cause,
    });
    return composed;
  }
  if (primary instanceof WasixStorageError) {
    return new WasixStorageError(message, {
      code: primary.code,
      commitState: primary.commitState,
      cause,
    });
  }
  return new Error(message, { cause });
}

/** @internal Complete extension and role setup after the direct bridge reaches ReadyForQuery. */
export async function configureWasixDatabase(
  options: SerializedOpenOptions,
  prepared: PreparedWasixRuntime,
  storageState: WasixStorageLease['state'],
  exec: (input: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  // Imported carrier install contracts own extension lifecycle. Activate them
  // while the fixed bootstrap superuser is selected, then apply the caller's role.
  if (storageState === 'new') {
    for (const sql of prepared.setupSql) {
      assertSuccessfulQueryResponse(await exec(simpleQuery(sql)));
    }
  }
  await configureWasixRole(options.username, exec);
}

/** @internal Restore the configured application role after DISCARD ALL. */
export async function configureWasixRole(
  username: string,
  exec: (input: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  if (username === 'postgres') return;
  const quoted = username.replaceAll('"', '""');
  assertSuccessfulQueryResponse(await exec(simpleQuery(`SET ROLE "${quoted}"`)));
}
