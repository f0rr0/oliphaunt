import type { NormalizedOpenConfig } from '../config.js';
import type {
  BackupFormat,
  EngineCapabilities,
  JavaScriptRuntime,
  RawProtocolTransport,
} from '../types.js';
import type { MaybePromise } from '../native/types.js';

export type RuntimeHandle = unknown;

export type RuntimeBinding = {
  runtime: JavaScriptRuntime;
  rawProtocolTransport: RawProtocolTransport;
  protocolStream: boolean;
  capabilities(handle: RuntimeHandle): MaybePromise<EngineCapabilities>;
  open(config: NormalizedOpenConfig): MaybePromise<RuntimeHandle>;
  execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): MaybePromise<Uint8Array>;
  execSimpleQuery?(handle: RuntimeHandle, sql: string): MaybePromise<Uint8Array>;
  execProtocolStream?(
    handle: RuntimeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): MaybePromise<void>;
  backup(handle: RuntimeHandle, format: BackupFormat): MaybePromise<Uint8Array>;
  cancel(handle: RuntimeHandle): MaybePromise<void>;
  detach(handle: RuntimeHandle): MaybePromise<void>;
};
