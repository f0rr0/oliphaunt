import type { BackupFormat, JavaScriptRuntime, RawProtocolTransport } from '../types.js';

export type NativeBindingOptions = {
  libraryPath?: string;
  nodeAddonPath?: string;
};

export type NativeOpenConfig = {
  pgdata: string;
  runtimeDirectory?: string;
  username: string;
  database: string;
  startupArgs: string[];
};

export type NativeRestoreOptions = {
  root: string;
  format: BackupFormat;
  bytes: Uint8Array;
  replaceExisting: boolean;
};

export type NativeHandle = unknown;
export type MaybePromise<T> = T | Promise<T>;

export type NativeBinding = {
  runtime: JavaScriptRuntime;
  rawProtocolTransport: RawProtocolTransport;
  protocolStream: boolean;
  defaultRuntimeDirectory?: string;
  version(): MaybePromise<string>;
  capabilities(): MaybePromise<bigint>;
  open(config: NativeOpenConfig): MaybePromise<NativeHandle>;
  execProtocolRaw(handle: NativeHandle, request: Uint8Array): MaybePromise<Uint8Array>;
  execSimpleQuery?(handle: NativeHandle, sql: string): MaybePromise<Uint8Array>;
  execProtocolStream?(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): MaybePromise<void>;
  backup(handle: NativeHandle, format: BackupFormat): MaybePromise<Uint8Array>;
  restore(options: NativeRestoreOptions): MaybePromise<void>;
  cancel(handle: NativeHandle): MaybePromise<void>;
  detach(handle: NativeHandle): MaybePromise<void>;
};
