import type { NormalizedOpenConfig } from '../config.js';
import type { NativeBinding, NativeHandle } from '../native/types.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';

export function directRuntimeBinding(binding: NativeBinding): RuntimeBinding {
  const runtimeBinding: RuntimeBinding = {
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
    execProtocolStream(
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      return Promise.resolve(binding.execProtocolStream(handle, request, onChunk));
    },
    backup(handle: RuntimeHandle): Promise<Uint8Array> {
      return Promise.resolve(binding.backup(handle));
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
  return runtimeBinding;
}

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('direct operation returned no result');
  }
  return value;
}
