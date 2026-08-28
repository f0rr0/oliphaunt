import type { NormalizedOpenConfig } from '../config.js';
import {
  NativeDetachOutcomeUnknownError,
  type NativeBinding,
  type NativeHandle,
} from '../native/types.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';

export function directRuntimeBinding(binding: NativeBinding): RuntimeBinding {
  const runtimeBinding: RuntimeBinding = {
    open(config: NormalizedOpenConfig): Promise<NativeHandle> {
      return binding.open({
        pgdata: config.pgdata,
        // Undefined is provenance: Node and Bun may materialize package-managed
        // extension assets, while a caller-supplied directory must be validated as-is.
        runtimeDirectory: config.runtimeDirectory,
        username: config.username,
        database: config.database,
        extensions: config.extensions,
        startupArgs: config.startupArgs,
      });
    },
    execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array> {
      return binding.execProtocolRaw(handle, request);
    },
    execProtocolStream(
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      return binding.execProtocolStream(handle, request, onChunk);
    },
    backup(handle: RuntimeHandle): Promise<Uint8Array> {
      return binding.backup(handle);
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return binding.cancel(handle);
    },
    async close(handle: RuntimeHandle) {
      try {
        await binding.detach(handle);
        return { state: 'closed' };
      } catch (error) {
        if (error instanceof NativeDetachOutcomeUnknownError) {
          return { state: 'terminal', error };
        }
        // Every other NativeBinding.detach() rejection is required to precede
        // logical deactivation. Keeping this owner live is therefore safe and
        // lets a caller retry an interrupted DISCARD ALL / ROLLBACK boundary.
        return { state: 'retryable', error };
      }
    },
  };
  if (binding.registerForgottenHandleCleanup !== undefined) {
    runtimeBinding.registerForgottenHandleCleanup = (
      owner: object,
      handle: RuntimeHandle,
      releaseOwnership: () => void,
    ) => binding.registerForgottenHandleCleanup?.(owner, handle, releaseOwnership);
  }
  if (binding.unregisterForgottenHandleCleanup !== undefined) {
    runtimeBinding.unregisterForgottenHandleCleanup = (owner: object) =>
      binding.unregisterForgottenHandleCleanup?.(owner);
  }
  if (binding.execSimpleQuery !== undefined) {
    runtimeBinding.execSimpleQuery = (handle: RuntimeHandle, sql: string) =>
      binding.execSimpleQuery?.(handle, sql).then(assertDefined) ??
      Promise.reject(new Error('direct simple query operation is unavailable'));
  }
  return runtimeBinding;
}

function assertDefined<T>(value: T): T {
  return value;
}
