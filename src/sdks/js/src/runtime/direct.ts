import type { NormalizedOpenConfig } from '../config.js';
import {
  CAP_BACKUP_RESTORE,
  CAP_EXTENSIONS,
  CAP_LOGICAL_REOPEN,
  CAP_MULTI_INSTANCE,
  CAP_PROTOCOL_RAW,
  CAP_PROTOCOL_STREAM,
  CAP_QUERY_CANCEL,
  CAP_SIMPLE_QUERY,
} from '../native/common.js';
import type { NativeBinding, NativeHandle } from '../native/types.js';
import type { BackupFormat, EngineCapabilities } from '../types.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';

export function directRuntimeBinding(binding: NativeBinding): RuntimeBinding {
  const runtimeBinding: RuntimeBinding = {
    runtime: binding.runtime,
    rawProtocolTransport: binding.rawProtocolTransport,
    protocolStream: binding.protocolStream,
    capabilities(): Promise<EngineCapabilities> {
      return Promise.resolve(binding.capabilities()).then((flags) =>
        nativeDirectCapabilities(flags, binding),
      );
    },
    open(config: NormalizedOpenConfig): Promise<NativeHandle> {
      return Promise.resolve(
        binding.open({
          pgdata: config.pgdata,
          // Undefined is provenance: Node and Bun may materialize package-managed
          // extension assets, while a caller-supplied directory must be validated as-is.
          runtimeDirectory: config.runtimeDirectory,
          username: config.username,
          database: config.database,
          extensions: config.extensions,
          startupArgs: config.startupArgs,
        }),
      );
    },
    execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array> {
      return Promise.resolve(binding.execProtocolRaw(handle, request));
    },
    backup(handle: RuntimeHandle, format: BackupFormat): Promise<Uint8Array> {
      return Promise.resolve(binding.backup(handle, format));
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return Promise.resolve(binding.cancel(handle));
    },
    detach(handle: RuntimeHandle): Promise<void> {
      return Promise.resolve(binding.detach(handle));
    },
  };
  if (binding.execSimpleQuery !== undefined) {
    runtimeBinding.execSimpleQuery = (handle: RuntimeHandle, sql: string) =>
      Promise.resolve(binding.execSimpleQuery?.(handle, sql)).then(assertDefined);
  }
  if (binding.protocolStream && binding.execProtocolStream !== undefined) {
    runtimeBinding.execProtocolStream = (
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ) => Promise.resolve(binding.execProtocolStream?.(handle, request, onChunk)).then(() => {});
  }
  return runtimeBinding;
}

export function nativeDirectCapabilities(
  rawFlags: bigint | number,
  binding: Pick<NativeBinding, 'rawProtocolTransport' | 'protocolStream' | 'execProtocolStream'>,
): EngineCapabilities {
  const flags = BigInt(rawFlags);
  const backupRestore = hasFlag(flags, CAP_BACKUP_RESTORE);
  return {
    engine: 'nativeDirect',
    processIsolated: false,
    multiRoot: hasFlag(flags, CAP_MULTI_INSTANCE),
    reopenable: hasFlag(flags, CAP_LOGICAL_REOPEN),
    sameRootLogicalReopen: hasFlag(flags, CAP_LOGICAL_REOPEN),
    rootSwitchable: false,
    crashRestartable: false,
    independentSessions: false,
    maxClientSessions: 1,
    protocolRaw: hasFlag(flags, CAP_PROTOCOL_RAW),
    protocolStream:
      hasFlag(flags, CAP_PROTOCOL_STREAM) &&
      binding.protocolStream &&
      binding.execProtocolStream !== undefined,
    queryCancel: hasFlag(flags, CAP_QUERY_CANCEL),
    backupRestore,
    backupFormats: backupRestore ? ['physicalArchive'] : [],
    restoreFormats: backupRestore ? ['physicalArchive'] : [],
    simpleQuery: hasFlag(flags, CAP_SIMPLE_QUERY),
    extensions: hasFlag(flags, CAP_EXTENSIONS),
    rawProtocolTransport: binding.rawProtocolTransport,
  };
}

function hasFlag(flags: bigint, flag: bigint): boolean {
  return (flags & flag) !== 0n;
}

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('nativeDirect operation returned no result');
  }
  return value;
}
