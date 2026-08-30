import { resolve } from 'node:path';

import { serializeOpenConfig } from './client-common.js';
import type { NativeWasixServerHandle, NativeWasixServerListen } from './native-addon.js';
import {
  mapNativeError,
  nativeWasixOpenOptions,
  requireCompatibleNativeWasixAddon,
} from './native-session.js';
import { requireNodeStorage } from './node-client-common.js';
import type { OpenConfig } from './types.js';

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

/** Open the Rust WASIX local server without a JavaScript socket/protocol relay. */
export async function openServer(config: ServerOpenConfig = {}): Promise<OliphauntServer> {
  const { listen: requestedListen, ...databaseConfig } = config;
  const options = serializeOpenConfig(databaseConfig);
  requireNodeStorage(options);
  const addon = requireCompatibleNativeWasixAddon(options);
  const listen = nativeListen(requestedListen ?? { transport: 'tcp' });

  let storage: Parameters<typeof nativeWasixOpenOptions>[1];
  if (options.storage.kind === 'memory') {
    storage = { kind: 'memory' };
  } else if (options.storage.kind === 'directory') {
    storage = { kind: 'directory', path: options.storage.path };
  } else {
    throw new TypeError('Oliphaunt WASIX native server requires memory or directory storage');
  }

  let handle: NativeWasixServerHandle;
  let connectionString: string;
  try {
    handle = await addon.NativeWasixServer.open({
      ...nativeWasixOpenOptions(options, storage),
      listen,
    });
    connectionString = validateServerHandle(handle);
  } catch (error) {
    throw mapNativeError(error);
  }
  return new NativeServerState(handle, connectionString).publicHandle();
}

class NativeServerState {
  readonly #handle: NativeWasixServerHandle;
  readonly #connectionString: string;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;

  constructor(handle: NativeWasixServerHandle, connectionString: string) {
    this.#handle = handle;
    this.#connectionString = connectionString;
  }

  publicHandle(): OliphauntServer {
    const state = this;
    return Object.freeze({
      connectionString: this.#connectionString,
      get closed() {
        return state.#closed || state.#handle.closed;
      },
      close: () => state.close(),
      [Symbol.asyncDispose]: () => state.close(),
    });
  }

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    this.#closeAttempt = this.#close();
    return this.#closeAttempt;
  }

  async #close(): Promise<void> {
    try {
      await this.#handle.close();
    } catch (error) {
      throw mapNativeError(error);
    } finally {
      this.#closed = true;
    }
  }
}

function nativeListen(listen: ServerListen): NativeWasixServerListen {
  if (listen.transport === 'tcp') {
    if (
      listen.port !== undefined &&
      (!Number.isSafeInteger(listen.port) || listen.port < 1 || listen.port > 65_535)
    ) {
      throw new TypeError('Oliphaunt WASIX TCP port must be an integer in 1..=65535');
    }
    return listen.port === undefined
      ? { transport: 'tcp' }
      : { transport: 'tcp', port: listen.port };
  }
  if (process.platform === 'win32') {
    throw new Error('Unix-domain server listeners are not supported on Windows');
  }
  if (
    typeof listen.directory !== 'string' ||
    listen.directory.trim().length === 0 ||
    listen.directory.includes('\0')
  ) {
    throw new TypeError('WASIX server Unix socket directory must be non-empty without NUL bytes');
  }
  const port = listen.port ?? 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Oliphaunt WASIX Unix socket port must be an integer in 1..=65535');
  }
  const directory = resolve(listen.directory);
  return { transport: 'unix', directory, port };
}

function validateServerHandle(handle: NativeWasixServerHandle): string {
  if (
    typeof handle !== 'object' ||
    handle === null ||
    typeof handle.closed !== 'boolean' ||
    typeof handle.connectionString !== 'string' ||
    handle.connectionString.length === 0 ||
    typeof handle.close !== 'function'
  ) {
    throw new Error('Oliphaunt WASIX native addon returned an invalid server handle');
  }
  return handle.connectionString;
}
