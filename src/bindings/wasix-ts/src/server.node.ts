import { lstat, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
  readWasixByteChannel,
  writeWasixByteChannel,
  type WasixByteChannel,
} from './byte-channel.js';
import { runWasixProtocolConnection } from './database.js';
import { openWasix } from './worker-node-client.js';
import type { OliphauntDatabase, OpenConfig } from './types.js';

const LOOPBACK = '127.0.0.1';
const DEFAULT_POSTGRES_PORT = 5432;

export type ServerListen =
  | Readonly<{ transport: 'tcp'; port?: number }>
  | Readonly<{ transport: 'unix'; directory: string; port?: number }>;

export type ServerOpenConfig = OpenConfig & Readonly<{ listen?: ServerListen }>;

export type OliphauntServer = Readonly<{
  connectionString: string;
  /** True after the one terminal close attempt settles, including on failure. */
  readonly closed: boolean;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}>;

/** Open one local PostgreSQL compatibility endpoint backed by one WASIX session. */
export async function openServer(config: ServerOpenConfig = {}): Promise<OliphauntServer> {
  const listen = await prepareListen(config.listen ?? { transport: 'tcp' });
  const { listen: _listen, ...databaseConfig } = config;
  const database = await openWasix(databaseConfig);
  const state = await ServerState.open(
    database,
    listen,
    config.username ?? 'postgres',
    config.database ?? 'postgres',
  );
  return state.publicHandle();
}

type PreparedListen = Readonly<{
  node: Readonly<{ host: string; port: number }> | string;
  didListen(): Promise<void>;
  connectionString(
    username: string,
    database: string,
    address: ReturnType<Server['address']>,
  ): string;
  cleanup(): Promise<void>;
}>;

class ServerState {
  readonly #database: OliphauntDatabase;
  readonly #listen: PreparedListen;
  #server: Server | undefined;
  #connectionString: string | undefined;
  #active: ActiveConnection | undefined;
  #accepting = false;
  #closing = false;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;
  #listenerFailure: unknown;
  #listenerClosedConfirmed = false;
  #databaseCleanupConfirmed = false;
  #listenCleanupConfirmed = false;
  #cleanupRetryScheduled = false;

  private constructor(database: OliphauntDatabase, listen: PreparedListen) {
    this.#database = database;
    this.#listen = listen;
  }

  static async open(
    database: OliphauntDatabase,
    listen: PreparedListen,
    username: string,
    databaseName: string,
  ): Promise<ServerState> {
    const state = new ServerState(database, listen);
    try {
      const server = createServer((socket) => state.accept(socket));
      state.#server = server;
      server.on('error', (error) => state.listenerFailed(error));
      await listenNodeServer(server, listen.node);
      await listen.didListen();
      state.#connectionString = listen.connectionString(username, databaseName, server.address());
      if (state.#listenerFailure !== undefined) throw state.#listenerFailure;
      state.#accepting = true;
      return state;
    } catch (error) {
      const cleanupFailures = (await state.#closeOwnedResources()).filter(
        (failure) => !Object.is(failure, error),
      );
      state.#closed = true;
      state.#retainUnconfirmedOwnership();
      if (cleanupFailures.length === 0) throw error;
      throw new AggregateError(
        [error, ...cleanupFailures],
        'could not open Oliphaunt WASIX server and clean up its resources',
      );
    }
  }

  publicHandle(): OliphauntServer {
    const connectionString = this.#connectionString;
    if (connectionString === undefined) {
      throw new Error('Oliphaunt WASIX server was published before it became ready');
    }
    const state = this;
    return Object.freeze({
      connectionString,
      get closed() {
        return state.closed;
      },
      close: () => this.close(),
      [Symbol.asyncDispose]: () => this.close(),
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  accept(socket: Socket): void {
    if (!this.#accepting || this.#closing || this.#closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    if (this.#active !== undefined) {
      socket.destroy();
      return;
    }
    this.start(new ActiveConnection(socket, this.#database));
  }

  start(active: ActiveConnection): void {
    this.#active = active;
    void active.run().then(
      () => this.clearActive(active),
      () => this.clearActive(active),
    );
  }

  clearActive(active: ActiveConnection): void {
    if (this.#active !== active) return;
    this.#active = undefined;
  }

  listenerFailed(error: unknown): void {
    this.#listenerFailure ??= error;
    this.#accepting = false;
    this.#active?.stop();
  }

  close(): Promise<void> {
    this.#closeAttempt ??= this.#closeInner();
    return this.#closeAttempt;
  }

  async #closeInner(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#accepting = false;
    try {
      const failures = await this.#closeOwnedResources();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'could not close Oliphaunt WASIX server cleanly');
      }
    } finally {
      this.#closed = true;
      this.#closing = false;
      this.#retainUnconfirmedOwnership();
    }
  }

  async #closeOwnedResources(): Promise<unknown[]> {
    this.#accepting = false;
    const active = this.#active;
    active?.stop();
    // Closing is terminal for the public database, but the listener and its
    // socket path remain separately owned until Node confirms it is no longer
    // listening. Never unlink a Unix endpoint under a possibly live listener.
    const server = this.#server;
    const shutdown = await Promise.allSettled([
      server === undefined ? Promise.resolve() : closeNodeServer(server),
      active?.finished ?? Promise.resolve(),
      this.#database.close(),
    ]);
    const failures: unknown[] = [];
    for (const result of shutdown) {
      if (result.status === 'rejected') pushUniqueFailure(failures, result.reason);
    }
    if (shutdown[2]?.status === 'fulfilled') this.#databaseCleanupConfirmed = true;
    this.#listenerClosedConfirmed = server === undefined || !server.listening;
    if (this.#listenerClosedConfirmed) {
      const cleanup = await settled(this.#listen.cleanup());
      if (cleanup.status === 'fulfilled') this.#listenCleanupConfirmed = true;
      else pushUniqueFailure(failures, cleanup.reason);
    }
    if (this.#listenerFailure !== undefined) {
      pushUniqueFailure(failures, this.#listenerFailure);
    }
    return failures;
  }

  #retainUnconfirmedOwnership(): void {
    if (this.#ownsUnconfirmedResources()) {
      retainedFailedServerStates.add(this);
      this.#scheduleCleanupRetry();
    } else {
      retainedFailedServerStates.delete(this);
    }
  }

  #ownsUnconfirmedResources(): boolean {
    return (
      !this.#listenerClosedConfirmed ||
      !this.#databaseCleanupConfirmed ||
      !this.#listenCleanupConfirmed
    );
  }

  #scheduleCleanupRetry(): void {
    if (this.#cleanupRetryScheduled) return;
    this.#cleanupRetryScheduled = true;
    const scheduled = setImmediate(() => {
      this.#cleanupRetryScheduled = false;
      void this.#retryUnconfirmedCleanup();
    });
    scheduled.unref();
  }

  async #retryUnconfirmedCleanup(): Promise<void> {
    // Database close is a one-shot terminal contract. Its owner remains
    // retained after failure, while listener/path cleanup can be retried
    // without resending database teardown or exposing a second public close.
    if (!this.#listenerClosedConfirmed) {
      const server = this.#server;
      if (server !== undefined) {
        await closeNodeServer(server).catch(() => undefined);
        this.#listenerClosedConfirmed = !server.listening;
      } else {
        this.#listenerClosedConfirmed = true;
      }
    }
    if (this.#listenerClosedConfirmed && !this.#listenCleanupConfirmed) {
      try {
        await this.#listen.cleanup();
        this.#listenCleanupConfirmed = true;
      } catch {
        // Retain the exact listener/path owner for process lifetime.
      }
    }
    if (!this.#ownsUnconfirmedResources()) retainedFailedServerStates.delete(this);
  }
}

// Public open and close have one terminal outcome. Keep unpublished or failed
// owners alive whenever Node cannot prove listener, database, and socket-path
// cleanup; an exact retained owner is safer than deleting live infrastructure.
const retainedFailedServerStates = new Set<ServerState>();

class ActiveConnection {
  readonly #socket: Socket;
  readonly #database: OliphauntDatabase;
  readonly #frontend = createWasixByteChannel();
  readonly #backend = createWasixByteChannel();
  readonly #input: Promise<PromiseSettledResult<void>>;
  #finished: Promise<void> | undefined;

  constructor(socket: Socket, database: OliphauntDatabase) {
    this.#socket = socket;
    this.#database = database;
    this.#input = settled(pumpSocketInput(this.#socket, this.#frontend));
  }

  get finished(): Promise<void> {
    if (this.#finished === undefined) {
      throw new Error('Oliphaunt WASIX server connection has not started');
    }
    return this.#finished;
  }

  run(): Promise<void> {
    this.#finished ??= this.#run();
    return this.#finished;
  }

  stop(): void {
    closeWasixByteChannel(this.#frontend);
    this.#socket.destroy();
  }

  async #run(): Promise<void> {
    const fail = (error: unknown): never => {
      failWasixByteChannel(this.#frontend);
      failWasixByteChannel(this.#backend);
      this.#socket.destroy();
      throw error;
    };
    const serving = runWasixProtocolConnection(
      this.#database,
      { frontend: this.#frontend, backend: this.#backend },
      'server',
    ).catch(fail);
    const output = pumpSocketOutput(this.#backend, this.#socket).catch(fail);
    const protocolResults = await Promise.allSettled([serving, output]);
    this.#socket.destroy();
    const inputResult = await this.#input;
    failWasixByteChannel(this.#frontend);
    failWasixByteChannel(this.#backend);
    const failure = [...protocolResults, inputResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }
}

async function pumpSocketInput(socket: Socket, frontend: WasixByteChannel): Promise<void> {
  try {
    const input = socket[Symbol.asyncIterator]();
    let next = input.next();
    socket.resume();
    for (;;) {
      const chunk = await next;
      if (chunk.done) break;
      next = input.next();
      await writeWasixByteChannel(frontend, chunk.value as Uint8Array);
    }
  } catch (error) {
    if (!isSocketDisconnect(error, socket)) throw error;
  } finally {
    closeWasixByteChannel(frontend);
  }
}

async function pumpSocketOutput(backend: WasixByteChannel, socket: Socket): Promise<void> {
  let disconnected = false;
  for (;;) {
    const chunk = await readWasixByteChannel(backend);
    if (chunk.length === 0) break;
    if (disconnected || socket.destroyed) {
      disconnected = true;
      continue;
    }
    try {
      if (!socket.write(chunk)) await waitForDrain(socket);
    } catch (error) {
      if (!isSocketDisconnect(error, socket)) throw error;
      disconnected = true;
    }
  }
  try {
    await finishSocketOutput(socket);
  } catch (error) {
    if (!isSocketDisconnect(error, socket)) throw error;
  }
}

function isSocketDisconnect(error: unknown, socket: Socket): boolean {
  if (socket.destroyed) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
    String(error.code),
  );
}

function waitForDrain(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('drain', onDrain);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    socket.once('drain', onDrain);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (socket.destroyed) onClose();
  });
}

function finishSocketOutput(socket: Socket): Promise<void> {
  if (socket.destroyed || socket.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('finish', onFinish);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    socket.once('finish', onFinish);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (socket.destroyed) {
      onClose();
      return;
    }
    if (socket.writableFinished) {
      onFinish();
      return;
    }
    if (!socket.writableEnded) {
      try {
        socket.end();
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
  });
}

function listenNodeServer(server: Server, endpoint: PreparedListen['node']): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeNodeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function pushUniqueFailure(failures: unknown[], failure: unknown): void {
  if (!failures.some((candidate) => Object.is(candidate, failure))) failures.push(failure);
}

async function prepareListen(listen: ServerListen): Promise<PreparedListen> {
  const port = validatePort(listen.port);
  if (listen.transport === 'tcp') {
    return {
      node: { host: LOOPBACK, port: port ?? 0 },
      didListen: async () => undefined,
      connectionString(username, database, address) {
        if (address === null || typeof address === 'string') {
          throw new Error('Oliphaunt WASIX TCP listener did not report a port');
        }
        return `postgresql://${encodeURIComponent(username)}@${LOOPBACK}:${address.port}/${encodeURIComponent(database)}?sslmode=disable`;
      },
      cleanup: async () => undefined,
    };
  }
  if (process.platform === 'win32') {
    throw new Error('Unix-domain server listeners are not supported on Windows');
  }
  if (
    typeof listen.directory !== 'string' ||
    listen.directory.trim() === '' ||
    listen.directory.includes('\0')
  ) {
    throw new TypeError('WASIX server Unix socket directory must be non-empty without NUL bytes');
  }
  const directory = resolve(listen.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error('WASIX server Unix socket directory must be a real directory, not a symlink');
  }
  const resolvedPort = port ?? DEFAULT_POSTGRES_PORT;
  const path = join(directory, `.s.PGSQL.${resolvedPort}`);
  await rejectExistingPath(path);
  let identity: Readonly<{ dev: number; ino: number }> | undefined;
  return {
    node: path,
    async didListen() {
      identity = await socketIdentity(path);
      if (identity === undefined) {
        throw new Error('Oliphaunt WASIX Unix listener did not create its socket');
      }
    },
    connectionString(username, database) {
      return `postgresql:///${encodeURIComponent(database)}?host=${encodeURIComponent(directory)}&port=${resolvedPort}&user=${encodeURIComponent(username)}&sslmode=disable`;
    },
    async cleanup() {
      if (identity === undefined) return;
      const current = await socketIdentity(path);
      if (current !== undefined && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(path);
      }
    },
  };
}

function validatePort(port: number | undefined): number | undefined {
  if (port === undefined) return undefined;
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) {
    throw new TypeError('WASIX server port must be an integer in the range 1..65535');
  }
  return port;
}

async function rejectExistingPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`WASIX server Unix socket path already exists: ${path}`);
}

async function socketIdentity(
  path: string,
): Promise<Readonly<{ dev: number; ino: number }> | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) throw new Error(`WASIX server endpoint is not a socket: ${path}`);
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function settled(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation;
    return { status: 'fulfilled', value: undefined };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
