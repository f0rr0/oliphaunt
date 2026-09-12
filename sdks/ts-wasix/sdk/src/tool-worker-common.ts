import {
  closeWasixByteChannel,
  failWasixByteChannel,
  markWasixByteChannelProtocolComplete,
  markWasixByteChannelProtocolStarted,
  readWasixByteChannelSync,
  type WasixByteChannel,
  wasixByteChannelProtocolOutcomeUnknown,
  writeWasixByteChannelSync,
} from './byte-channel.js';
import type {
  Directory,
  OliphauntPreparedTool,
  OliphauntToolOutput,
  RunWasixOptions,
} from './host/index.mjs';
import {
  materializeWasixToolMounts,
  prepareWasixToolAsset,
  releaseWasixToolMounts,
  type PreparedWasixToolAsset,
  type WasixToolDescriptor,
  wasixToolAssetIdentity,
  wasixToolRunOptions,
} from './tool-runtime.js';

export type WasixToolWorkerRequest = WasixToolPrepareRequest | WasixToolRunRequest;

export type WasixToolPrepareRequest = Readonly<{
  id: number;
  kind: 'prepare';
  tool: WasixToolDescriptor & Readonly<{ name: 'psql' }>;
}>;

export type WasixToolRunRequest = Readonly<{
  id: number;
  kind: 'run';
  tool: 'psql';
  args: string[];
  stdin?: Uint8Array;
  frontend: WasixByteChannel;
  backend: WasixByteChannel;
}>;

export type WasixToolWorkerResponse =
  | Readonly<{ id: number; ok: true; kind: 'prepared' }>
  | Readonly<{
      id: number;
      ok: true;
      kind: 'completed';
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }>
  | Readonly<{ id: number; ok: false; message: string }>;

export type WasixToolHost = Readonly<{
  Directory: typeof Directory;
  init(): Promise<unknown>;
  prepareOliphauntTool(module: WebAssembly.Module, moduleBytes: Uint8Array): OliphauntPreparedTool;
  runOliphauntToolDirect(
    prepared: OliphauntPreparedTool,
    options: RunWasixOptions,
    protocolRead: (maximumBytes: number) => Uint8Array,
    /** Borrowed bytes: synchronously copy; never mutate or retain this view. */
    protocolWrite: (chunk: Uint8Array) => void,
  ): Promise<OliphauntToolOutput>;
}>;

type CachedTool = Readonly<{
  identity: string;
  asset: PreparedWasixToolAsset;
  prepared: OliphauntPreparedTool;
}>;

/** @internal Stateful dispatcher owned by one persistent outer tool worker. */
export function createWasixToolWorkerDispatcher(
  host: WasixToolHost,
): (request: WasixToolWorkerRequest) => Promise<WasixToolWorkerResponse> {
  let hostInitialization: Promise<unknown> | undefined;
  let tool: CachedTool | undefined;

  const dispatch = async (request: WasixToolWorkerRequest): Promise<WasixToolWorkerResponse> => {
    try {
      hostInitialization ??= host.init();
      await hostInitialization;
      if (request.kind === 'prepare') {
        const toolIdentity = wasixToolAssetIdentity(request.tool);
        if (tool === undefined) {
          const asset = await prepareWasixToolAsset(request.tool);
          tool = {
            identity: toolIdentity,
            asset,
            prepared: host.prepareOliphauntTool(asset.module, asset.bytes),
          };
        } else if (tool.identity !== toolIdentity) {
          throw new Error('Oliphaunt WASIX tool worker cannot replace psql');
        }
        return { id: request.id, ok: true, kind: 'prepared' };
      }

      if (tool === undefined) throw new Error(`WASIX ${request.tool} module is not prepared`);
      return await runPreparedTool(request, host, tool);
    } catch (error) {
      if (request.kind === 'run') {
        finishFailedToolChannels(request);
      }
      return { id: request.id, ok: false, message: describeWorkerError(error) };
    }
  };
  return dispatch;
}

/** @internal Transfer owned tool outputs without another table-sized structured clone. */
export function toolWorkerResponseTransfers(response: WasixToolWorkerResponse): ArrayBuffer[] {
  if (!response.ok || response.kind !== 'completed') return [];
  const buffers = new Set<ArrayBuffer>();
  for (const bytes of [response.stdout, response.stderr]) {
    if (bytes.buffer instanceof ArrayBuffer) buffers.add(bytes.buffer);
  }
  return [...buffers];
}

async function runPreparedTool(
  request: WasixToolRunRequest,
  host: WasixToolHost,
  tool: CachedTool,
): Promise<WasixToolWorkerResponse> {
  const mounts = await materializeWasixToolMounts(host.Directory, tool.asset);
  let response: WasixToolWorkerResponse | undefined;
  let failure: Readonly<{ primary: unknown }> | undefined;
  try {
    const output = await host.runOliphauntToolDirect(
      tool.prepared,
      wasixToolRunOptions(tool.asset, request.args, mounts, request.stdin),
      (maximumBytes) => {
        markWasixByteChannelProtocolStarted(request.frontend);
        return readWasixByteChannelSync(request.backend, maximumBytes);
      },
      (chunk) => {
        markWasixByteChannelProtocolStarted(request.frontend);
        writeWasixByteChannelSync(request.frontend, chunk);
      },
    );
    markWasixByteChannelProtocolComplete(request.frontend);
    closeWasixByteChannel(request.frontend);
    response = {
      id: request.id,
      ok: true,
      kind: 'completed',
      exitCode: output.code,
      stdout: output.stdoutBytes,
      stderr: output.stderrBytes,
    };
  } catch (error) {
    failure = { primary: error };
  }
  if (failure !== undefined) releaseWasixToolMounts(mounts, failure);
  releaseWasixToolMounts(mounts);
  if (response === undefined) throw new Error('WASIX psql completed without a response');
  return response;
}

function finishFailedToolChannels(request: WasixToolRunRequest): void {
  if (wasixByteChannelProtocolOutcomeUnknown(request.frontend)) {
    // Mark uncertainty before EOF so the database cannot observe a clean
    // connection close and reset while a later public tool failure escapes.
    failWasixByteChannel(request.frontend);
    failWasixByteChannel(request.backend);
  }
  closeWasixByteChannel(request.frontend);
}

function describeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = 'cause' in error ? error.cause : undefined;
  return cause === undefined ? error.message : `${error.message}: ${describeWorkerError(cause)}`;
}
