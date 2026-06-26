import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createServer } from 'node:net';

import type { NormalizedOpenConfig } from '../config.js';
import { simpleQuery } from '../protocol.js';
import type { BackupFormat, EngineCapabilities, EngineModeSupport } from '../types.js';
import {
  connectEndpoint,
  removeTree,
  spawnManagedChild,
  type LocalEndpoint,
  type ManagedChild,
} from './node-adapter.js';
import { createPhysicalArchive } from './physical-archive.js';
import { PostgresWireClient } from './pgwire.js';
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

export function createServerRuntimeBinding(): RuntimeBinding {
  return {
    runtime: runtimeName(),
    rawProtocolTransport: 'server-wire',
    protocolStream: true,
    capabilities(handle: RuntimeHandle): EngineCapabilities {
      return asServerHandle(handle).capabilities();
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
    execProtocolStream(
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      return asServerHandle(handle).execProtocolStream(request, onChunk);
    },
    backup(handle: RuntimeHandle, format: BackupFormat): Promise<Uint8Array> {
      return asServerHandle(handle).backup(format);
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return asServerHandle(handle).cancel();
    },
    detach(handle: RuntimeHandle): Promise<void> {
      return asServerHandle(handle).detach();
    },
  };
}

export async function serverModeSupport(options: {
  serverExecutable?: string;
  serverToolDirectory?: string;
}): Promise<EngineModeSupport> {
  const capabilities = serverCapabilities(32);
  try {
    await resolveServerTools(options);
    return { engine: 'nativeServer', available: true, capabilities };
  } catch (error) {
    return {
      engine: 'nativeServer',
      available: false,
      capabilities,
      unavailableReason: `native server executable is unavailable: ${errorString(error)}`,
    };
  }
}

export function serverCapabilities(
  maxClientSessions: number,
  connectionString?: string,
): EngineCapabilities {
  return {
    engine: 'nativeServer',
    processIsolated: true,
    multiRoot: false,
    reopenable: true,
    sameRootLogicalReopen: false,
    rootSwitchable: true,
    crashRestartable: false,
    independentSessions: true,
    maxClientSessions,
    protocolRaw: true,
    protocolStream: true,
    queryCancel: true,
    backupRestore: true,
    backupFormats: ['sql', 'physicalArchive'],
    restoreFormats: ['physicalArchive'],
    simpleQuery: true,
    extensions: true,
    connectionString,
    rawProtocolTransport: 'server-wire',
  };
}

class ServerHandle {
  #closed = false;

  constructor(
    readonly child: ManagedChild,
    readonly client: PostgresWireClient,
    readonly root: string,
    readonly pgdata: string,
    readonly pgCtl: string | undefined,
    readonly pgDump: string | undefined,
    readonly socketDir: string | undefined,
    readonly connectionString: string,
    readonly maxClientSessions: number,
    readonly temporary: boolean,
  ) {}

  capabilities(): EngineCapabilities {
    return serverCapabilities(this.maxClientSessions, this.connectionString);
  }

  async execProtocolRaw(request: Uint8Array): Promise<Uint8Array> {
    this.assertOpen();
    return this.client.execProtocolRaw(request);
  }

  async execProtocolStream(
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    this.assertOpen();
    await this.client.execProtocolStream(request, onChunk);
  }

  async backup(format: BackupFormat): Promise<Uint8Array> {
    this.assertOpen();
    if (format === 'sql') {
      if (this.pgDump === undefined) {
        throw new Error('native server SQL backup requires pg_dump');
      }
      return runPgDump(this.pgDump, this.connectionString);
    }
    if (format === 'physicalArchive') {
      return createPhysicalArchive({
        pgdata: this.pgdata,
        execSimpleQuery: (sql) => this.execProtocolRaw(simpleQuery(sql)),
      });
    }
    throw new Error(`${format} backup is not supported by nativeServer`);
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
    await this.client.terminate().catch(() => {});
    if (this.pgCtl !== undefined && (await isFile(this.pgCtl))) {
      await runCommand(this.pgCtl, ['-D', this.pgdata, '-m', 'fast', '-w', 'stop']).catch(() => {});
    }
    const exited = await waitForChild(this.child, STOP_TIMEOUT_MS);
    if (!exited) {
      this.child.kill('SIGKILL');
      await this.child.wait();
    }
    await removeTree(this.socketDir);
    if (this.temporary) {
      await removeTree(this.root);
    }
  }

  assertOpen(): void {
    if (this.#closed) {
      throw new Error('native server session is closed');
    }
  }
}

async function openServer(config: NormalizedOpenConfig): Promise<ServerHandle> {
  const startupTimeoutMs = serverStartupTimeoutMs();
  const tools = await resolveServerTools({
    serverExecutable: config.serverExecutable,
    serverToolDirectory: config.serverToolDirectory,
    extensions: config.extensions,
  });
  const executable = tools.executable;
  const toolDirectory = tools.toolDirectory;
  let socketDir: string | undefined;
  let child: ManagedChild | undefined;
  try {
    await initializeServerDataDir(config, toolDirectory);
    const pgCtl = await optionalTool(toolDirectory, 'pg_ctl');
    const pgDump = await optionalTool(toolDirectory, 'pg_dump');
    const port = config.serverPort ?? (await pickPort());
    socketDir = process.platform === 'win32' ? undefined : await createSocketDir();
    child = spawnManagedChild({
      executable,
      args: postgresArgs(config, port, socketDir),
      env: await nativeServerRuntimeEnv(toolDirectory),
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
      config.root,
      config.pgdata,
      pgCtl,
      pgDump,
      socketDir,
      serverConnectionString(config.username, config.database, port),
      config.maxClientSessions,
      config.temporary,
    );
  } catch (error) {
    if (child !== undefined) {
      child.kill('SIGKILL');
      await child.wait();
    }
    await removeTree(socketDir);
    if (config.temporary) {
      await removeTree(config.root);
    }
    throw error;
  }
}

async function initializeServerDataDir(
  config: NormalizedOpenConfig,
  toolDirectory: string,
): Promise<void> {
  if (await isFile(join(config.pgdata, 'PG_VERSION'))) {
    return;
  }
  const initdb = await optionalTool(toolDirectory, 'initdb');
  if (initdb === undefined) {
    throw new Error(`native server bootstrap requires initdb in ${toolDirectory}`);
  }
  await mkdir(config.pgdata, { recursive: true });
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
  args.push('-c', `max_connections=${config.maxClientSessions}`);
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

export function serverConnectionString(username: string, database: string, port: number): string {
  return `postgres://${percentEncode(username)}@${SERVER_HOST}:${port}/${percentEncode(database)}`;
}

function percentEncode(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) =>
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
}

function serverStartupTimeoutMs(): number {
  const value = process.env[SERVER_STARTUP_TIMEOUT_MS_ENV];
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
  serverToolDirectory?: string;
  extensions?: readonly string[];
}): Promise<{ executable: string; toolDirectory: string }> {
  const candidates = [
    options.serverExecutable,
    process.env.OLIPHAUNT_POSTGRES,
    options.serverToolDirectory === undefined
      ? undefined
      : join(options.serverToolDirectory, executableName('postgres')),
  ].filter((value): value is string => value !== undefined && value.length > 0);
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return {
        executable: candidate,
        toolDirectory: options.serverToolDirectory ?? dirname(candidate),
      };
    }
  }
  if (options.serverExecutable !== undefined || options.serverToolDirectory !== undefined) {
    throw new Error('set serverExecutable, serverToolDirectory, or OLIPHAUNT_POSTGRES');
  }
  const install = await materializeNodeExtensionInstall(
    await resolveNodeNativeInstall(),
    options.extensions ?? [],
  );
  if (install.runtimeDirectory !== undefined) {
    const toolDirectory = join(install.runtimeDirectory, 'bin');
    const executable = join(toolDirectory, executableName('postgres'));
    if (await isFile(executable)) {
      return { executable, toolDirectory };
    }
  }
  throw new Error(
    'set serverExecutable, serverToolDirectory, or OLIPHAUNT_POSTGRES, or install @oliphaunt/ts with optional native runtime packages enabled',
  );
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
  return process.platform === 'win32' ? `${name}.exe` : name;
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

export async function nativeServerRuntimeEnv(toolDirectory: string): Promise<Record<string, string>> {
  const runtimeDirectory = dirname(toolDirectory);
  const env: Record<string, string> = {};
  const dynamicLibraryDirs = await nativeDynamicLibraryDirs(runtimeDirectory);
  const dynamicLibraryEnv = prependEnvPaths(
    nativeDynamicLibraryEnvName(),
    dynamicLibraryDirs,
    process.env[nativeDynamicLibraryEnvName()],
  );
  if (dynamicLibraryEnv !== undefined) {
    env[nativeDynamicLibraryEnvName()] = dynamicLibraryEnv;
  }

  const icuData = join(runtimeDirectory, 'share/icu');
  if (await isDirectory(icuData)) {
    env.ICU_DATA = icuData;
    return env;
  }
  const packagedIcuData = await resolveNodeIcuDataDirectory();
  if (packagedIcuData !== undefined) {
    env.ICU_DATA = packagedIcuData;
  }
  return env;
}

function nativeDynamicLibraryEnvName(): 'DYLD_LIBRARY_PATH' | 'LD_LIBRARY_PATH' | 'PATH' {
  if (process.platform === 'darwin') {
    return 'DYLD_LIBRARY_PATH';
  }
  if (process.platform === 'win32') {
    return 'PATH';
  }
  return 'LD_LIBRARY_PATH';
}

async function nativeDynamicLibraryDirs(runtimeDirectory: string): Promise<string[]> {
  const dirs: string[] = [];
  if (process.platform === 'win32') {
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

async function runPgDump(pgDump: string, connectionString: string): Promise<Uint8Array> {
  return runCommand(
    pgDump,
    [connectionString],
    await nativeServerRuntimeEnv(dirname(pgDump)),
  );
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
