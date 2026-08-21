import type { NormalizedOpenConfig } from '../config.js';
import type { MaybePromise } from '../native/types.js';

export type RuntimeHandle = unknown;

export type RuntimeBinding = {
  connectionString?(handle: RuntimeHandle): string;
  open(config: NormalizedOpenConfig): MaybePromise<RuntimeHandle>;
  execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): MaybePromise<Uint8Array>;
  execProtocolStream(
    handle: RuntimeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): MaybePromise<void>;
  execSimpleQuery?(handle: RuntimeHandle, sql: string): MaybePromise<Uint8Array>;
  backup?(handle: RuntimeHandle): MaybePromise<Uint8Array>;
  cancel(handle: RuntimeHandle): MaybePromise<void>;
  detach(handle: RuntimeHandle): MaybePromise<void>;
};
