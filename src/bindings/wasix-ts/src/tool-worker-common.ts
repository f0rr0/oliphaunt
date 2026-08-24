import {
  closeWasixByteChannel,
  failWasixByteChannel,
  readWasixByteChannel,
  type WasixByteChannel,
  writeWasixByteChannel,
} from './byte-channel.js';
import type { Directory, WasixOutput } from './host/index.mjs';
import type { SerializedRuntimeDescriptor } from './rpc.js';
import {
  prepareWasixToolMounts,
  type WasixToolAsset,
  verifyWasixToolAsset,
} from './tool-runtime.js';

export type WasixToolWorkerRequest = Readonly<{
  id: number;
  runtime: SerializedRuntimeDescriptor;
  tool: WasixToolAsset;
  args: string[];
  stdin?: Uint8Array;
  frontend: WasixByteChannel;
  backend: WasixByteChannel;
}>;

export type WasixToolWorkerResponse =
  | Readonly<{
      id: number;
      ok: true;
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }>
  | Readonly<{ id: number; ok: false; message: string }>;

export type WasixToolHost = Readonly<{
  Directory: typeof Directory;
  init(): Promise<unknown>;
  runOliphauntTool(
    module: Uint8Array | WebAssembly.Module,
    options: {
      program?: string;
      moduleBytes?: Uint8Array;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      mount?: Record<string, Directory>;
      stdin?: Uint8Array;
    },
  ): Promise<{
    protocolInput: WritableStream<Uint8Array>;
    protocolOutput: ReadableStream<Uint8Array>;
    wait(): Promise<WasixOutput>;
  }>;
}>;

export async function runWasixToolWorker(
  request: WasixToolWorkerRequest,
  host: WasixToolHost,
): Promise<WasixToolWorkerResponse> {
  try {
    await host.init();
    await verifyWasixToolAsset(request.tool);
    const mounts = await prepareWasixToolMounts(host.Directory, request.runtime);
    const bin = mounts['/bin'];
    if (bin === undefined) throw new Error('WASIX tool runtime has no /bin mount');
    // PostgreSQL frontend startup validates argv[0] to derive its installation
    // paths. Keep that standard lookup honest while the module itself is
    // instantiated directly by the host.
    await bin.writeFile(request.tool.name, request.tool.module);
    const instance = await host.runOliphauntTool(request.tool.module, {
      program: `/bin/${request.tool.name}`,
      moduleBytes: request.tool.module,
      args: request.args,
      cwd: '/',
      env: {
        PGUSER: 'postgres',
        PGPASSWORD: 'password',
        PGSSLMODE: 'disable',
        PGCLIENTENCODING: 'UTF8',
        ICU_DATA: '/share/icu',
        HOME: '/home/postgres',
        PATH: '/bin',
        LC_CTYPE: 'C.UTF-8',
        TZ: 'UTC',
        // Rust omits this internal path and uses the same module through
        // Wasmer's virtual network, so the portable artifact stays host-neutral.
        OLIPHAUNT_DIRECT_PGWIRE: '/dev/oliphaunt-pgwire',
      },
      mount: mounts,
      stdin: request.stdin,
    });
    const protocolInput = instance.protocolInput.getWriter();
    const protocolOutput = instance.protocolOutput.getReader();
    const frontendPump = pumpToolFrontend(protocolOutput, request.frontend);
    const backendPump = pumpToolBackend(request.backend, protocolInput);
    const [output] = await Promise.all([instance.wait(), frontendPump, backendPump]);
    return {
      id: request.id,
      ok: true,
      exitCode: output.code,
      stdout: output.stdoutBytes,
      stderr: output.stderrBytes,
    };
  } catch (error) {
    failWasixByteChannel(request.frontend);
    failWasixByteChannel(request.backend);
    return {
      id: request.id,
      ok: false,
      message: describeWorkerError(error),
    };
  }
}

/** @internal Transfer owned tool outputs without another table-sized structured clone. */
export function toolWorkerResponseTransfers(response: WasixToolWorkerResponse): ArrayBuffer[] {
  if (!response.ok) return [];
  const buffers = new Set<ArrayBuffer>();
  for (const bytes of [response.stdout, response.stderr]) {
    if (bytes.buffer instanceof ArrayBuffer) buffers.add(bytes.buffer);
  }
  return [...buffers];
}

function describeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = 'cause' in error ? error.cause : undefined;
  return cause === undefined ? error.message : `${error.message}: ${describeWorkerError(cause)}`;
}

async function pumpToolFrontend(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  frontend: WasixByteChannel,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      await writeWasixByteChannel(frontend, value);
    }
  } finally {
    closeWasixByteChannel(frontend);
    reader.releaseLock();
  }
}

async function pumpToolBackend(
  backend: WasixByteChannel,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  try {
    for (;;) {
      const chunk = await readWasixByteChannel(backend);
      if (chunk.length === 0) break;
      await writer.write(chunk);
    }
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
