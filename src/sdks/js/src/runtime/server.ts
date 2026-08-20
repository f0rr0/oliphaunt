import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';

import type { NormalizedOpenConfig } from '../config.js';
import { simpleQuery } from '../protocol.js';
import { envVar } from '../native/common.js';
import {
  connectEndpoint,
  removeTree,
  spawnManagedChild,
  unixSocketPathsFit,
  type LocalEndpoint,
  type ManagedChild,
} from './node-adapter.js';
import { PostgresWireClient } from './pgwire.js';
import { publishNativeDescriptor, validateManagedRoot } from '../root-descriptor.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';
import {
  materializeNodeExtensionInstall,
  resolveNodeIcuDataDirectory,
  resolveNodeNativeInstall,
} from '../native/assets-node.js';

const SERVER_HOST = '127.0.0.1';
const SERVER_STARTUP_TIMEOUT_MS_ENV = 'OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const CONNECT_RETRY_MS = 50;
const STOP_TIMEOUT_MS = 5_000;
const OLIPHAUNT_POSTGRES_ENV = 'OLIPHAUNT_POSTGRES';

type ServerTools = {
  executable: string;
  toolDirectory: string;
  icuDataDirectory?: string;
};

export function createServerRuntimeBinding(): RuntimeBinding {
  return {
    connectionString(handle: RuntimeHandle): string {
      return asServerHandle(handle).connectionString;
    },
    async open(config: NormalizedOpenConfig): Promise<ServerHandle> {
      return openServer(config);
    },
    execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array> {
      return asServerHandle(handle).execProtocolRaw(request);
    },
    execSimpleQuery(handle: RuntimeHandle, sql: string): Promise<Uint8Array> {
      return asServerHandle(handle).execProtocolRaw(simpleQuery(sql));
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return asServerHandle(handle).cancel();
    },
    detach(handle: RuntimeHandle): Promise<void> {
      return asServerHandle(handle).detach();
    },
  };
}

class ServerHandle {
  #closed = false;

  constructor(
    readonly child: ManagedChild,
    readonly client: PostgresWireClient,
    readonly instanceDirectory: string,
    readonly pgdata: string,
    readonly pgCtl: string | undefined,
    readonly socketDir: string | undefined,
    readonly connectionString: string,
    readonly temporaryDirectory: boolean,
    readonly releaseRoot: () => Promise<void>,
  ) {}

  async execProtocolRaw(request: Uint8Array): Promise<Uint8Array> {
    this.assertOpen();
    return this.client.execProtocolRaw(request);
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    await this.client.cancel();
  }

  async detach(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.client.terminate().catch(() => {});
      if (this.pgCtl !== undefined && (await isFile(this.pgCtl))) {
        await runCommand(this.pgCtl, ['-D', this.pgdata, '-m', 'fast', '-w', 'stop']).catch(
          () => {},
        );
      }
      const exited = await waitForChild(this.child, STOP_TIMEOUT_MS);
      if (!exited) {
        this.child.kill('SIGKILL');
        await this.child.wait();
      }
      await removeTree(this.socketDir);
      if (this.temporaryDirectory) {
        await removeTree(this.instanceDirectory);
      }
    } finally {
      await this.releaseRoot();
    }
  }

  assertOpen(): void {
    if (this.#closed) {
      throw new Error('native server session is closed');
    }
  }
}

async function openServer(config: NormalizedOpenConfig): Promise<ServerHandle> {
  const releaseRoot = await acquireServerRoot(config.instanceDirectory);
  let socketDir: string | undefined;
  let child: ManagedChild | undefined;
  try {
    const startupTimeoutMs = serverStartupTimeoutMs();
    const tools = await resolveServerTools({
      serverExecutable: config.serverExecutable,
      runtimeDirectory: config.runtimeDirectory,
      extensions: config.extensions,
    });
    const executable = tools.executable;
    const toolDirectory = tools.toolDirectory;
    await initializeServerDataDir(config, toolDirectory);
    const pgCtl = await optionalTool(toolDirectory, 'pg_ctl');
    const port = config.serverPort ?? (await pickPort());
    socketDir = hostPlatform() === 'win32' ? undefined : await createSocketDir();
    if (socketDir !== undefined && !unixSocketPathsFit(join(socketDir, `.s.PGSQL.${port}`))) {
      await removeTree(socketDir);
      socketDir = undefined;
    }
    child = spawnManagedChild({
      executable,
      args: postgresArgs(config, port, socketDir),
      env: await nativeServerRuntimeEnv(toolDirectory, tools.icuDataDirectory),
    });
    const endpoint = sdkEndpoint(port, socketDir);
    const client = await waitForServer(
      endpoint,
      child,
      config.username,
      config.database,
      startupTimeoutMs,
    );
    return new ServerHandle(
      child,
      client,
      config.instanceDirectory,
      config.pgdata,
      pgCtl,
      socketDir,
      serverConnectionString(config.username, config.database, port),
      config.temporaryDirectory,
      releaseRoot,
    );
  } catch (error) {
    if (child !== undefined) {
      child.kill('SIGKILL');
      await child.wait();
    }
    await removeTree(socketDir);
    if (config.temporaryDirectory) {
      await removeTree(config.instanceDirectory);
    }
    await releaseRoot();
    throw error;
  }
}

/** @internal Atomic ownership for this binding's server provider. */
export async function acquireServerRoot(root: string): Promise<() => Promise<void>> {
  const absolute = resolve(root);
  const lock = join(dirname(absolute), `.${basename(absolute)}.oliphaunt-server`);
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `native server owner directory ${lock} already exists; remove it only after confirming no native server owns root ${absolute}`,
      );
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rmdir(lock);
  };
}

export async function initializeServerDataDir(
  config: NormalizedOpenConfig,
  toolDirectory: string,
): Promise<void> {
  if (await validateManagedRoot(config.instanceDirectory)) return;
  const initdb = await optionalTool(toolDirectory, 'initdb');
  if (initdb === undefined) {
    throw new Error(`native server bootstrap requires initdb in ${toolDirectory}`);
  }
  await mkdir(config.pgdata);
  try {
    await runCommand(
      initdb,
      [
        '-D',
        config.pgdata,
        '-U',
        config.username,
        '--auth=trust',
        '--no-sync',
        '--locale-provider=libc',
        '--locale=C',
        '--encoding=UTF8',
      ],
      await nativeServerRuntimeEnv(toolDirectory),
    );
    await publishNativeDescriptor(config.instanceDirectory);
  } catch (error) {
    await removeTree(config.pgdata);
    throw error;
  }
}

function postgresArgs(
  config: NormalizedOpenConfig,
  port: number,
  socketDir: string | undefined,
): string[] {
  const args = [
    '-D',
    config.pgdata,
    '-h',
    SERVER_HOST,
    '-p',
    String(port),
    '-c',
    'logging_collector=off',
    '-c',
    'listen_addresses=127.0.0.1',
  ];
  args.push(
    '-c',
    socketDir === undefined ? 'unix_socket_directories=' : `unix_socket_directories=${socketDir}`,
  );
  args.push(...config.startupArgs);
  return args;
}

async function waitForServer(
  endpoint: LocalEndpoint,
  child: ManagedChild,
  username: string,
  database: string,
  startupTimeoutMs: number,
): Promise<PostgresWireClient> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      child.exited().then((code) => ({ exited: true, code })),
      sleep(0).then(() => ({ exited: false, code: null })),
    ]);
    if (exited.exited) {
      throw new Error(`native server exited before accepting connections with code ${exited.code}`);
    }
    try {
      return await PostgresWireClient.connect(endpoint, username, database);
    } catch (error) {
      lastError = error;
      await sleep(CONNECT_RETRY_MS);
    }
  }
  throw new Error(`native server did not accept SDK connections: ${errorString(lastError)}`);
}

function sdkEndpoint(port: number, socketDir: string | undefined): LocalEndpoint {
  if (socketDir !== undefined) {
    return { kind: 'unix', path: join(socketDir, `.s.PGSQL.${port}`) };
  }
  return { kind: 'tcp', host: SERVER_HOST, port };
}

function serverConnectionString(username: string, database: string, port: number): string {
  return `postgres://${encodeURIComponent(username)}@${SERVER_HOST}:${port}/${encodeURIComponent(database)}`;
}

function serverStartupTimeoutMs(): number {
  const value = envVar(SERVER_STARTUP_TIMEOUT_MS_ENV);
  if (value === undefined || value.length === 0) {
    return DEFAULT_STARTUP_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed.toString() !== value.trim()) {
    throw new Error(
      `${SERVER_STARTUP_TIMEOUT_MS_ENV} must be a positive integer number of milliseconds`,
    );
  }
  return parsed;
}

async function resolveServerTools(options: {
  serverExecutable?: string;
  runtimeDirectory?: string;
  extensions?: readonly string[];
}): Promise<ServerTools> {
  const candidates = [
    options.serverExecutable,
    envVar(OLIPHAUNT_POSTGRES_ENV),
    options.runtimeDirectory === undefined
      ? undefined
      : join(options.runtimeDirectory, executableName('postgres')),
  ].filter((value): value is string => value !== undefined && value.length > 0);
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      const toolDirectory = options.runtimeDirectory ?? dirname(candidate);
      return {
        executable: candidate,
        toolDirectory,
      };
    }
  }
  if (options.serverExecutable !== undefined || options.runtimeDirectory !== undefined) {
    throw new Error(`set serverExecutable, runtimeDirectory, or ${OLIPHAUNT_POSTGRES_ENV}`);
  }
  const install = await resolvePackageManagedServerInstall(options.extensions ?? []);
  if (install.runtimeDirectory !== undefined) {
    const toolDirectory = join(install.runtimeDirectory, 'bin');
    const executable = join(toolDirectory, executableName('postgres'));
    if (await isFile(executable)) {
      return { executable, toolDirectory, icuDataDirectory: install.icuDataDirectory };
    }
  }
  throw new Error(
    `set serverExecutable, runtimeDirectory, or ${OLIPHAUNT_POSTGRES_ENV}, or install @oliphaunt/ts with optional native runtime packages enabled`,
  );
}

async function resolvePackageManagedServerInstall(
  extensions: readonly string[],
): Promise<{ runtimeDirectory?: string; icuDataDirectory?: string }> {
  if (runtimeName() === 'deno') {
    if (extensions.length > 0) {
      throw new Error(
        `Deno server execution does not automatically materialize extension packages; pass runtimeDirectory with the selected extension assets or use Node/Bun openServer(). Selected extensions: ${extensions.join(', ')}`,
      );
    }
    const install = await import('../native/assets-deno.js').then((module) =>
      module.resolveDenoNativeInstall(),
    );
    return {
      runtimeDirectory: install.runtimeDirectory,
      icuDataDirectory: install.icuDataDirectory,
    };
  }

  return materializeNodeExtensionInstall(await resolveNodeNativeInstall(), extensions);
}

async function optionalTool(
  directory: string | undefined,
  name: string,
): Promise<string | undefined> {
  if (directory === undefined) {
    return undefined;
  }
  const path = join(directory, executableName(name));
  return (await isFile(path)) ? path : undefined;
}

function executableName(name: string): string {
  return hostPlatform() === 'win32' ? `${name}.exe` : name;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function nativeServerRuntimeEnv(
  toolDirectory: string,
  icuDataDirectory?: string,
): Promise<Record<string, string>> {
  const runtimeDirectory = dirname(toolDirectory);
  const env: Record<string, string> = {};
  const dynamicLibraryDirs = await nativeDynamicLibraryDirs(runtimeDirectory);
  const dynamicLibraryEnv = prependEnvPaths(
    nativeDynamicLibraryEnvName(),
    dynamicLibraryDirs,
    envVar(nativeDynamicLibraryEnvName()),
  );
  if (dynamicLibraryEnv !== undefined) {
    env[nativeDynamicLibraryEnvName()] = dynamicLibraryEnv;
  }

  const icuData = join(runtimeDirectory, 'share/icu');
  if (await isDirectory(icuData)) {
    env.ICU_DATA = icuData;
    return env;
  }
  if (icuDataDirectory !== undefined) {
    env.ICU_DATA = icuDataDirectory;
    return env;
  }
  if (runtimeName() === 'deno') {
    return env;
  }
  const packagedIcuData = await resolveNodeIcuDataDirectory();
  if (packagedIcuData !== undefined) {
    env.ICU_DATA = packagedIcuData;
  }
  return env;
}

function nativeDynamicLibraryEnvName(): 'DYLD_LIBRARY_PATH' | 'LD_LIBRARY_PATH' | 'PATH' {
  const platform = hostPlatform();
  if (platform === 'darwin') {
    return 'DYLD_LIBRARY_PATH';
  }
  if (platform === 'win32') {
    return 'PATH';
  }
  return 'LD_LIBRARY_PATH';
}

async function nativeDynamicLibraryDirs(runtimeDirectory: string): Promise<string[]> {
  const dirs: string[] = [];
  if (hostPlatform() === 'win32') {
    const bin = join(runtimeDirectory, 'bin');
    if (await isDirectory(bin)) {
      dirs.push(bin);
    }
  }
  const lib = join(runtimeDirectory, 'lib');
  if (await isDirectory(lib)) {
    dirs.push(lib);
  }
  return dirs;
}

function prependEnvPaths(
  name: string,
  paths: string[],
  existing: string | undefined,
): string | undefined {
  const entries = paths.filter((path) => path.length > 0);
  if (existing !== undefined && existing.length > 0) {
    entries.push(existing);
  }
  return entries.length === 0 ? undefined : entries.join(delimiter);
}

async function pickPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    server.once('error', rejectOpen);
    server.listen(0, SERVER_HOST, resolveOpen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (address === null || typeof address === 'string') {
    throw new Error('failed to allocate a native server TCP port');
  }
  return address.port;
}

async function createSocketDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lpo-s-'));
  await chmod(path, 0o700);
  return path;
}

async function runCommand(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Uint8Array> {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const chunks: Uint8Array[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0) {
    throw new Error(`${command} exited with status ${code}`);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function waitForChild(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  return Promise.race([child.wait().then(() => true), sleep(timeoutMs).then(() => false)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function hostPlatform(): string {
  const denoOs = (globalThis as { Deno?: { build?: { os?: string } } }).Deno?.build?.os;
  if (denoOs === 'windows') {
    return 'win32';
  }
  return denoOs ?? process.platform;
}

function asServerHandle(handle: RuntimeHandle): ServerHandle {
  if (handle instanceof ServerHandle) {
    return handle;
  }
  throw new Error('invalid native server handle');
}

function runtimeName(): 'node' | 'bun' | 'deno' {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') {
    return 'deno';
  }
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return 'bun';
  }
  return 'node';
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
