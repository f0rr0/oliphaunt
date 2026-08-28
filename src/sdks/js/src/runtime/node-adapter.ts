import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket, createConnection } from 'node:net';
import type { Readable } from 'node:stream';

import type { ByteStream } from './byte-stream.js';

export type LocalEndpoint =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number };

export type ManagedChild = {
  stdout: Readable;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<number | null>;
  exited(): Promise<number | null>;
};

/** Exact unpublished runtime resources retained after startup cleanup fails. */
export type FailedManagedLaunch = {
  child?: ManagedChild;
  stream?: ByteStream;
  paths: Array<string | undefined>;
};

const retainedFailedManagedLaunches = new Set<FailedManagedLaunch>();

/**
 * Best-effort cleanup for a runtime launch which failed before it could publish
 * a handle. Paths are never deleted while the child reap is unconfirmed, and
 * every unresolved exact resource remains process-lifetime owned.
 */
export async function cleanupFailedManagedLaunch(
  launch: FailedManagedLaunch,
  timeoutMs: number,
  label: string,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  const stream = launch.stream;
  if (stream !== undefined) {
    try {
      await stream.close();
      if (launch.stream === stream) launch.stream = undefined;
    } catch (error) {
      failures.push(error);
    }
  }

  const child = launch.child;
  if (child !== undefined) {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      failures.push(error);
    }
    try {
      const reaped = await waitForManagedChild(child, timeoutMs);
      if (reaped) {
        if (launch.child === child) launch.child = undefined;
      } else {
        failures.push(new Error(`${label} did not stop within ${timeoutMs}ms`));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (launch.child === undefined) {
    for (let index = 0; index < launch.paths.length; index += 1) {
      const path = launch.paths[index];
      if (path === undefined) continue;
      try {
        await removeTree(path);
        launch.paths[index] = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (
    launch.child !== undefined ||
    launch.stream !== undefined ||
    launch.paths.some((path) => path !== undefined)
  ) {
    retainedFailedManagedLaunches.add(launch);
  } else {
    retainedFailedManagedLaunches.delete(launch);
  }
  return failures;
}

export async function waitForManagedChild(
  child: ManagedChild,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(false), timeoutMs);
    if (typeof timeoutHandle === 'object' && timeoutHandle !== null && 'unref' in timeoutHandle) {
      timeoutHandle.unref();
    }
  });
  try {
    return await Promise.race([child.wait().then(() => true), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function randomHexToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

export function unixSocketPathsFit(...paths: string[]): boolean {
  return paths.every((value) => Buffer.byteLength(value, 'utf8') < 100);
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTree(path: string | undefined): Promise<void> {
  if (path !== undefined) {
    await rm(path, { force: true, recursive: true });
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export function spawnManagedChild(options: {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  replaceEnv?: boolean;
}): ManagedChild {
  const child: ChildProcessByStdio<null, Readable, null> = spawn(options.executable, options.args, {
    env: options.replaceEnv ? options.env : { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return {
    stdout: child.stdout,
    kill(signal?: NodeJS.Signals): void {
      child.kill(signal);
    },
    wait(): Promise<number | null> {
      return exited;
    },
    exited(): Promise<number | null> {
      return exited;
    },
  };
}

export async function readReadyLine(
  stream: Readable,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not print a ready line within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();

    function cleanup(): void {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
    }

    function onData(chunk: Buffer): void {
      const next = Buffer.alloc(buffer.byteLength + chunk.byteLength);
      next.set(buffer, 0);
      next.set(chunk, buffer.byteLength);
      buffer = next;
      const index = buffer.indexOf(0x0a);
      if (index < 0) {
        if (buffer.length > 8192) {
          cleanup();
          reject(new Error(`${label} ready line exceeded 8192 bytes`));
        }
        return;
      }
      cleanup();
      resolve(buffer.subarray(0, index).toString('utf8').replace(/\r$/, ''));
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onEnd(): void {
      cleanup();
      reject(new Error(`${label} exited before printing a ready line`));
    }

    function onAbort(): void {
      cleanup();
      reject(new Error(`${label} readiness wait was cancelled`));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function connectEndpoint(endpoint: LocalEndpoint): Promise<ByteStream> {
  const socket =
    endpoint.kind === 'unix'
      ? createConnection(endpoint.path)
      : createConnection({ host: endpoint.host, port: endpoint.port });
  if (endpoint.kind === 'tcp') {
    socket.setNoDelay(true);
  }
  await new Promise<void>((resolve, reject) => {
    function onConnect(): void {
      socket.off('error', onError);
      resolve();
    }

    function onError(error: Error): void {
      socket.off('connect', onConnect);
      socket.destroy();
      reject(error);
    }

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
  return new NodeSocketByteStream(socket);
}

export function parseReadyEndpoint(value: string): LocalEndpoint {
  if (value.startsWith('unix:')) {
    return { kind: 'unix', path: value.slice('unix:'.length) };
  }
  const address = value.startsWith('tcp:') ? value.slice('tcp:'.length) : value;
  const lastColon = address.lastIndexOf(':');
  if (lastColon <= 0) {
    throw new Error(`invalid TCP endpoint '${value}'`);
  }
  const port = Number(address.slice(lastColon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) {
    throw new Error(`invalid TCP endpoint port '${value}'`);
  }
  return { kind: 'tcp', host: address.slice(0, lastColon), port };
}

class NodeSocketByteStream implements ByteStream {
  readonly #socket: Socket;
  readonly #chunks: Uint8Array[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  readonly #closed: Promise<void>;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#closed = new Promise((resolveClosed) => {
      socket.once('close', () => {
        this.#ended = true;
        this.#wake?.();
        this.#wake = undefined;
        resolveClosed();
      });
    });
    socket.on('data', (chunk: Buffer) => {
      this.#chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
      this.#wake?.();
      this.#wake = undefined;
    });
    socket.once('end', () => {
      this.#ended = true;
      this.#wake?.();
      this.#wake = undefined;
    });
    socket.once('error', (error) => {
      this.#error = error;
      this.#wake?.();
      this.#wake = undefined;
    });
  }

  async readExactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.#error !== undefined) {
        throw this.#error;
      }
      const chunk = this.#chunks[0];
      if (chunk === undefined) {
        if (this.#ended) {
          throw new Error(`socket ended before ${length} byte(s) were available`);
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        continue;
      }
      const take = Math.min(chunk.length, length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = chunk.subarray(take);
      }
    }
    return out;
  }

  async writeAll(bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null) => (error ? reject(error) : resolve());
      this.#socket.write(bytes, done);
    });
  }

  async close(): Promise<void> {
    if (!this.#socket.destroyed) this.#socket.destroy();
    await this.#closed;
  }
}
