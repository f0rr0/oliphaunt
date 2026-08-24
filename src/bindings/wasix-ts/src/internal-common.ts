import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
} from './byte-channel.js';
import { assertWasixProtocolConnectionTarget, runWasixProtocolConnection } from './database.js';
import { loadAsset } from './archive.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import type { OliphauntDatabase } from './types.js';
import type { SerializedAssetSource } from './rpc.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';

export type WasixToolDescriptor = Readonly<{
  name: 'pg_dump' | 'psql';
  sha256: string;
  size: number;
  source: SerializedAssetSource;
}>;

export type WasixToolProcessOptions = Readonly<{
  runtimeVersion: string;
  tool: WasixToolDescriptor;
  args: readonly string[];
  stdin?: Uint8Array;
}>;

export type WasixToolProcessResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type WasixToolWorkerPort = Readonly<{
  postMessage(request: WasixToolWorkerRequest, transfer: ArrayBuffer[]): void;
  response(): Promise<WasixToolWorkerResponse>;
  terminate(): void | Promise<void>;
}>;

/** @internal Shared browser/server tool orchestration; public API lives in the optional package. */
export async function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
  createWorker: () => WasixToolWorkerPort,
): Promise<WasixToolProcessResult> {
  assertWasixProtocolConnectionTarget(database);
  if (options.runtimeVersion !== defaultWasixRuntime.version) {
    throw new Error(
      `WASIX tools runtime ${options.runtimeVersion} is incompatible with database runtime ${defaultWasixRuntime.version}`,
    );
  }
  validateToolDescriptor(options.tool);
  const module = (
    await loadAsset(options.tool.source, `WASIX ${options.tool.name} module`)
  ).slice();
  const frontend = createWasixByteChannel();
  const backend = createWasixByteChannel();
  const worker = createWorker();
  const stdin = options.stdin?.slice();
  const serving = runWasixProtocolConnection(database, { frontend, backend }, 'tool').then(
    () => ({ ok: true as const }),
    (error: unknown) => {
      failWasixByteChannel(frontend);
      failWasixByteChannel(backend);
      return { ok: false as const, error };
    },
  );
  try {
    worker.postMessage(
      {
        id: 1,
        runtime: serializeWasixRuntimeDescriptor(defaultWasixRuntime),
        tool: {
          name: options.tool.name,
          module,
          sha256: options.tool.sha256,
          size: options.tool.size,
        },
        args: [...options.args],
        stdin,
        frontend,
        backend,
      },
      stdin === undefined ? [module.buffer] : [module.buffer, stdin.buffer],
    );
    const response = await worker.response();
    if (!response.ok) throw new Error(response.message);
    closeWasixByteChannel(frontend);
    const served = await serving;
    if (!served.ok) throw served.error;
    return {
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
    };
  } finally {
    failWasixByteChannel(frontend);
    failWasixByteChannel(backend);
    await Promise.resolve(worker.terminate()).catch(() => undefined);
    await serving;
  }
}

function validateToolDescriptor(tool: WasixToolDescriptor): void {
  if (tool.name !== 'pg_dump' && tool.name !== 'psql') {
    throw new TypeError('unsupported Oliphaunt WASIX tool');
  }
  if (!/^[0-9a-f]{64}$/u.test(tool.sha256)) {
    throw new TypeError(`WASIX ${tool.name} SHA-256 is invalid`);
  }
  if (!Number.isSafeInteger(tool.size) || tool.size <= 0) {
    throw new TypeError(`WASIX ${tool.name} size is invalid`);
  }
}
