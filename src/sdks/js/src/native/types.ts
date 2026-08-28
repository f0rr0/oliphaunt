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

/** @internal The adapter cannot prove whether a logical detach took effect. */
export class NativeDetachOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeDetachOutcomeUnknownError';
  }
}

export type NativeBinding = {
  open(config: NativeOpenConfig): Promise<NativeHandle>;
  execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array>;
  execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void>;
  execSimpleQuery?(handle: NativeHandle, sql: string): Promise<Uint8Array>;
  backup(handle: NativeHandle): Promise<Uint8Array>;
  restore(options: NativeRestoreOptions): Promise<void>;
  cancel(handle: NativeHandle): Promise<void>;
  /**
   * Deactivate the logical handle. An ordinary rejection guarantees that
   * deactivation did not occur and the same handle remains valid for a later
   * retry. NativeDetachOutcomeUnknownError is terminal. A handle that is
   * already terminally unavailable is a successful detach.
   */
  detach(handle: NativeHandle): Promise<void>;
  /**
   * Register a public owner for best-effort cleanup when that owner becomes
   * unreachable. Native adapters omit this unless they can make stale cleanup
   * ownership-safe and keep native teardown off the JavaScript thread.
   */
  registerForgottenHandleCleanup?(
    owner: object,
    handle: NativeHandle,
    releaseOwnership: () => void,
  ): void;
  unregisterForgottenHandleCleanup?(owner: object): void;
};
