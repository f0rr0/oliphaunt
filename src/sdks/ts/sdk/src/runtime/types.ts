import type { NormalizedOpenConfig } from '../config.js';

export type RuntimeHandle = unknown;

/**
 * Private lifecycle result returned by a runtime owner. Runtime adapters must
 * classify an error from facts they own, never from an error message.
 */
export type RuntimeCloseOutcome =
  | { readonly state: 'closed' }
  | { readonly state: 'retryable'; readonly error: unknown }
  | { readonly state: 'terminal'; readonly error: unknown };

export type RuntimeBinding = {
  connectionString?(handle: RuntimeHandle): string;
  open(config: NormalizedOpenConfig): Promise<RuntimeHandle>;
  execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array>;
  execProtocolStream(
    handle: RuntimeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void>;
  execSimpleQuery?(handle: RuntimeHandle, sql: string): Promise<Uint8Array>;
  backup?(handle: RuntimeHandle): Promise<Uint8Array>;
  cancel(handle: RuntimeHandle): Promise<void>;
  /**
   * Release this logical owner. This operation resolves with an explicit
   * lifecycle outcome; it must not reject.
   */
  close(handle: RuntimeHandle): Promise<RuntimeCloseOutcome>;
  /**
   * Install an ownership-safe leak guard. Its held value must not retain
   * `owner`; process-owning adapters must defer teardown and guard it with the
   * exact handle/generation so stale callbacks are no-ops.
   */
  registerForgottenHandleCleanup?(
    owner: object,
    handle: RuntimeHandle,
    releaseOwnership: () => void,
  ): void;
  unregisterForgottenHandleCleanup?(owner: object): void;
};
