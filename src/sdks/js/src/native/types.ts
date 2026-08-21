export type NativeBindingOptions = {
  libraryPath?: string;
  nodeAddonPath?: string;
};

export type NativeOpenConfig = {
  pgdata: string;
  runtimeDirectory?: string;
  username: string;
  database: string;
  extensions: string[];
  startupArgs: string[];
};

export type NativeRestoreOptions = {
  destination: string;
  bytes: Uint8Array;
};

export type NativeHandle = unknown;
export type MaybePromise<T> = T | Promise<T>;

export type NativeBinding = {
  open(config: NativeOpenConfig): MaybePromise<NativeHandle>;
  execProtocolRaw(handle: NativeHandle, request: Uint8Array): MaybePromise<Uint8Array>;
  execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): MaybePromise<void>;
  execSimpleQuery?(handle: NativeHandle, sql: string): MaybePromise<Uint8Array>;
  backup(handle: NativeHandle): MaybePromise<Uint8Array>;
  restore(options: NativeRestoreOptions): MaybePromise<void>;
  cancel(handle: NativeHandle): MaybePromise<void>;
  detach(handle: NativeHandle): MaybePromise<void>;
};
