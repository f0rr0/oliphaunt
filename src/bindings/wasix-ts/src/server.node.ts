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
import { openWasix } from './node-client.js';
import type { OliphauntDatabase, OpenConfig } from './types.js';

const LOOPBACK = '127.0.0.1';
const DEFAULT_POSTGRES_PORT = 5432;

export type ServerListen =
  | Readonly<{ transport: 'tcp'; port?: number }>
  | Readonly<{ transport: 'unix'; directory: string; port?: number }>;

export type ServerOpenConfig = Omit<OpenConfig, 'execution'> & Readonly<{ listen?: ServerListen }>;

export type OliphauntServer = Readonly<{
  connectionString: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}>;

/** Open one local PostgreSQL compatibility endpoint backed by one WASIX session. */
export async function openServer(config: ServerOpenConfig = {}): Promise<OliphauntServer> {
  const listen = await prepareListen(config.listen ?? { transport: 'tcp' });
  const { listen: _listen, ...databaseConfig } = config;
  const database = await openWasix({ ...databaseConfig, execution: 'worker' });
  let state: ServerState | undefined;
  try {
    state = await ServerState.open(
      database,
      listen,
      config.username ?? 'postgres',
      config.database ?? 'postgres',
    );
    return state.publicHandle();
  } catch (error) {
    await state?.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await listen.cleanup().catch(() => undefined);
    throw error;
  }
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
  readonly #server: Server;
  readonly #connectionString: string;
  #active: ActiveConnection | undefined;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;
  #listenerFailure: unknown;

  private constructor(
    database: OliphauntDatabase,
    listen: PreparedListen,
    server: Server,
    connectionString: string,
  ) {
    this.#database = database;
    this.#listen = listen;
    this.#server = server;
    this.#connectionString = connectionString;
  }

  static async open(
    database: OliphauntDatabase,
    listen: PreparedListen,
    username: string,
    databaseName: string,
  ): Promise<ServerState> {
    let state: ServerState | undefined;
    const server = createServer((socket) => {
      if (state === undefined) socket.destroy();
      else state.accept(socket);
    });
    try {
      await listenNodeServer(server, listen.node);
      await listen.didListen();
      const connectionString = listen.connectionString(username, databaseName, server.address());
      state = new ServerState(database, listen, server, connectionString);
      server.on('error', (error) => state?.listenerFailed(error));
      return state;
    } catch (error) {
      await closeNodeServer(server).catch(() => undefined);
      throw error;
    }
  }

  publicHandle(): OliphauntServer {
    return Object.freeze({
      connectionString: this.#connectionString,
      close: () => this.close(),
      [Symbol.asyncDispose]: () => this.close(),
    });
  }

  accept(socket: Socket): void {
    if (this.#closed) {
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
    this.#active?.stop();
  }

  close(): Promise<void> {
    this.#closeAttempt ??= this.#closeInner();
    return this.#closeAttempt;
  }

  async #closeInner(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    active?.stop();
    // Close the database concurrently with the active stream. Its bounded
    // worker shutdown is what prevents a long-running guest query from making
    // server.close() wait forever.
    const shutdown = await Promise.allSettled([
      closeNodeServer(this.#server),
      active?.finished ?? Promise.resolve(),
      this.#database.close(),
    ]);
    const results = [...shutdown, await settled(this.#listen.cleanup())];
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (this.#listenerFailure !== undefined) failures.push(this.#listenerFailure);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'could not close Oliphaunt WASIX server cleanly');
    }
  }
}

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
