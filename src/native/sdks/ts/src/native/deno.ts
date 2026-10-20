import { dirname, join } from 'node:path';
import { prepareExtensionInstall, resolveNativeInstall, selectNativeResources } from './assets.js';
import { applyNativeRuntimeLibraryEnvironment, errorMessage } from './common.js';
import {
  errorCaptureBuffer,
  packConfigPointers,
  packRestoreOptionsPointers,
  readErrorCapture,
  readResponseLength,
  readResponsePointer,
  responseBuffer,
} from './ffi-layout.js';
import {
  copyNativeClusterSeed,
  initializeNativePgdata,
  nativeInitdbArgs,
  nativePostgresChildEnvironment,
} from './initialize.js';
import { resolveExactNativeRuntimeProfile } from './runtime-profile.js';
import {
  type NativeBinding,
  type NativeBindingOptions,
  NativeDetachOutcomeUnknownError,
  type NativeHandle,
  type NativeOpenConfig,
  type NativeRestoreOptions,
} from './types.js';

type DenoPointer = object | null;
const OLIPHAUNT_STREAM_CALLBACK_ABORTED = 1;
type DenoSymbols = {
  oliphaunt_init_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_exec_protocol_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_exec_protocol_raw_stream_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_exec_simple_query_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_backup_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_backup_stream_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_restore_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_cancel: (...args: unknown[]) => unknown;
  oliphaunt_detach_with_error: (...args: unknown[]) => Promise<number>;
  oliphaunt_logical_generation: (...args: unknown[]) => bigint;
  oliphaunt_close_if_generation: (...args: unknown[]) => Promise<number>;
  oliphaunt_copy_last_error: (...args: unknown[]) => unknown;
  oliphaunt_free_response: (...args: unknown[]) => unknown;
};

type DenoForgottenHandle = {
  readonly generation: bigint;
  readonly releaseOwnership: () => void;
};

let denoDirectAdmissionClosed = false;
let denoDirectAdmissionFailure: unknown;

export async function createDenoNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  const deno = denoGlobal();
  const install = await resolveNativeInstall(options.libraryPath);
  applyNativeRuntimeLibraryEnvironment(install.runtimeDirectory);
  const dylib = deno.dlopen(install.libraryPath, {
    oliphaunt_init_with_error: {
      parameters: ['buffer', 'buffer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_exec_protocol_with_error: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_exec_protocol_raw_stream_with_error: {
      parameters: ['pointer', 'buffer', 'usize', 'function', 'pointer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_exec_simple_query_with_error: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_backup_stream_with_error: {
      parameters: ['pointer', 'function', 'pointer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_backup_with_error: {
      parameters: ['pointer', 'buffer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_restore_with_error: {
      parameters: ['buffer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_cancel: { parameters: ['pointer'], result: 'i32' },
    oliphaunt_detach_with_error: {
      parameters: ['pointer', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_logical_generation: {
      parameters: ['pointer'],
      result: 'u64',
    },
    oliphaunt_close_if_generation: {
      parameters: ['u64'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_copy_last_error: {
      parameters: ['pointer', 'buffer', 'usize'],
      result: 'usize',
    },
    oliphaunt_free_response: { parameters: ['buffer'], result: 'void' },
  });
  const symbols = dylib.symbols as DenoSymbols;
  const generations = new WeakMap<object, bigint>();
  const uncertainDetaches = new WeakMap<object, NativeDetachOutcomeUnknownError>();
  const forgottenHandles = new FinalizationRegistry<DenoForgottenHandle>(
    ({ generation, releaseOwnership }) => {
      // A finalizer may only enqueue nonblocking FFI. Generation-guarded close
      // atomically becomes a no-op when this cleanup record no longer owns the
      // resident logical lease, so it can never dereference a stale pointer or
      // terminate a newer Deno handle.
      void closeDenoGeneration(symbols, generation).then(
        () => {
          try {
            releaseOwnership();
          } catch {
            // Finalization is unobservable best effort. Never turn an owner
            // bookkeeping failure into an unhandled rejection.
          }
        },
        () => {
          // The native process may still own this generation. Keep direct
          // admission closed rather than publishing an unsafe second owner.
        },
      );
    },
  );

  return {
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      const selectedInstall = await selectNativeResources(install, config, dirname(config.pgdata));
      assertDenoDirectAdmissionOpen();
      const explicitRuntimeDirectory =
        config.runtimeDirectory !== undefined || selectedInstall.packageManaged === false;
      let openConfig = {
        ...config,
        runtimeDirectory: config.runtimeDirectory ?? selectedInstall.runtimeDirectory,
      };
      const prepared = await prepareExtensionInstall(
        { ...selectedInstall, runtimeDirectory: openConfig.runtimeDirectory },
        openConfig.extensions,
        { explicitRuntimeDirectory, descriptors: config.extensionDescriptors },
      );
      openConfig = { ...openConfig, runtimeDirectory: prepared.runtimeDirectory };
      const moduleDirectory = prepared.moduleDirectory;
      applyNativeRuntimeLibraryEnvironment(prepared.runtimeDirectory);
      const runtimeProfile =
        explicitRuntimeDirectory &&
        config.icuData === undefined &&
        openConfig.runtimeDirectory !== undefined
          ? await resolveExactNativeRuntimeProfile(openConfig.runtimeDirectory)
          : {
              icuDataDirectory: selectedInstall.icuDataDirectory,
              catalogProfile: selectedInstall.catalogProfile ?? ('standard' as const),
            };
      if (explicitRuntimeDirectory) {
        applyNativeRuntimeLibraryEnvironment(openConfig.runtimeDirectory);
      }
      await prepareDenoPgdata(
        deno,
        openConfig.pgdata,
        openConfig.username,
        openConfig.runtimeDirectory,
        selectedInstall.clusterSeedDirectory,
        runtimeProfile.icuDataDirectory,
        runtimeProfile.catalogProfile,
        selectedInstall.clusterSeedEmptyDirectories,
      );
      const packed = packConfigPointers(
        { ...openConfig, moduleDirectory, icuDataDirectory: runtimeProfile.icuDataDirectory },
        (value) => pointerOf(deno, value),
      );
      const out = new Uint8Array(8);
      const captured = errorCaptureBuffer();
      let rc: number;
      try {
        rc = await symbols.oliphaunt_init_with_error(packed.config, out, captured);
      } catch (failure) {
        closeDenoDirectAdmission(failure);
        throw failure;
      } finally {
        keepAlive(packed.keepAlive);
      }
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt init failed', rc, readErrorCapture(captured));
      }
      const handle = pointerFromAddress(deno, readPointer(out));
      if (handle === null) {
        const failure = new Error('native liboliphaunt init returned a null handle');
        closeDenoDirectAdmission(failure);
        throw failure;
      }
      const generation = symbols.oliphaunt_logical_generation(handle);
      if (generation === 0n) {
        // Zero means the native registry has already rejected this pointer as
        // stale or non-current. It must not be dereferenced for cleanup.
        const failure = new Error(
          'native liboliphaunt init returned an invalid logical generation',
        );
        closeDenoDirectAdmission(failure);
        throw failure;
      }
      generations.set(handle, generation);
      return handle;
    },
    async execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
      const response = responseBuffer();
      const captured = errorCaptureBuffer();
      const rc = await symbols.oliphaunt_exec_protocol_with_error(
        handle,
        request,
        BigInt(request.byteLength),
        response,
        captured,
      );
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt protocol execution failed',
          rc,
          readErrorCapture(captured),
        );
      }
      return copyResponse(deno, symbols, response);
    },
    async execProtocolStream(
      handle: NativeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      const stream = createDenoStreamCallback(deno, onChunk);
      const callback = stream.callback;
      let rc: number;
      const captured = errorCaptureBuffer();
      try {
        rc = await symbols.oliphaunt_exec_protocol_raw_stream_with_error(
          handle,
          request,
          BigInt(request.byteLength),
          callback.pointer,
          null,
          captured,
        );
      } finally {
        callback.close();
      }
      if (rc === OLIPHAUNT_STREAM_CALLBACK_ABORTED) {
        if (stream.failure !== undefined) throw stream.failure.error;
        throw new Error(
          'native liboliphaunt protocol streaming reported a recovered callback abort without a callback failure',
        );
      }
      if (rc === 0) {
        if (stream.failure === undefined) return;
        throw new Error(
          'native liboliphaunt protocol streaming reported success after the callback failed',
        );
      }
      throw errorMessage(
        'native liboliphaunt protocol streaming failed',
        rc,
        readErrorCapture(captured),
      );
    },
    async execSimpleQuery(handle: NativeHandle, sql: string): Promise<Uint8Array> {
      if (sql.includes('\0')) {
        throw new Error('simple query SQL must not contain NUL bytes');
      }
      const bytes = new TextEncoder().encode(sql);
      const response = responseBuffer();
      const captured = errorCaptureBuffer();
      const rc = await symbols.oliphaunt_exec_simple_query_with_error(
        handle,
        bytes,
        BigInt(bytes.byteLength),
        response,
        captured,
      );
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt simple query failed',
          rc,
          readErrorCapture(captured),
        );
      }
      return copyResponse(deno, symbols, response);
    },
    async backup(handle: NativeHandle): Promise<Uint8Array> {
      const response = responseBuffer();
      const captured = errorCaptureBuffer();
      const rc = await symbols.oliphaunt_backup_with_error(handle, response, captured);
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage('native liboliphaunt backup failed', rc, readErrorCapture(captured));
      }
      return copyResponse(deno, symbols, response);
    },
    async backupStream(handle: NativeHandle, onChunk: (chunk: Uint8Array) => void): Promise<void> {
      const stream = createDenoStreamCallback(deno, onChunk);
      const captured = errorCaptureBuffer();
      let rc: number;
      try {
        rc = await symbols.oliphaunt_backup_stream_with_error(
          handle,
          stream.callback.pointer,
          null,
          captured,
        );
      } finally {
        stream.callback.close();
      }
      if (rc !== 0) {
        const error = errorMessage(
          'native liboliphaunt backup failed',
          rc,
          readErrorCapture(captured),
        );
        if (stream.failure !== undefined) error.cause = stream.failure.error;
        throw error;
      }
      if (stream.failure !== undefined) throw stream.failure.error;
    },
    async restore(options: NativeRestoreOptions): Promise<void> {
      const packed = packRestoreOptionsPointers(options, (value) => pointerOf(deno, value));
      const captured = errorCaptureBuffer();
      const rc = await symbols.oliphaunt_restore_with_error(packed.options, captured);
      keepAlive(packed.keepAlive);
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt restore failed', rc, readErrorCapture(captured));
      }
    },
    async cancel(handle: NativeHandle): Promise<void> {
      const rc = symbols.oliphaunt_cancel(handle) as number;
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt cancel failed', rc, lastError(symbols, handle));
      }
    },
    async detach(handle: NativeHandle): Promise<void> {
      if (typeof handle === 'object' && handle !== null) {
        const priorFailure = uncertainDetaches.get(handle);
        if (priorFailure !== undefined) throw priorFailure;
      }
      const captured = errorCaptureBuffer();
      let rc: number;
      try {
        rc = await symbols.oliphaunt_detach_with_error(handle, captured);
      } catch (failure) {
        const terminalFailure = new NativeDetachOutcomeUnknownError(
          'Deno native detach delivery failed after its outcome became unknown; restart the process before opening another direct database',
          { cause: failure },
        );
        closeDenoDirectAdmission(terminalFailure);
        if (typeof handle === 'object' && handle !== null) {
          generations.delete(handle);
          uncertainDetaches.set(handle, terminalFailure);
        }
        throw terminalFailure;
      }
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt detach failed', rc, readErrorCapture(captured));
      }
      if (typeof handle === 'object' && handle !== null) {
        generations.delete(handle);
      }
    },
    registerForgottenHandleCleanup(
      owner: object,
      handle: NativeHandle,
      releaseOwnership: () => void,
    ): void {
      if (typeof handle !== 'object' || handle === null) {
        throw new Error('Deno native cleanup received an invalid handle');
      }
      const generation = generations.get(handle);
      if (generation === undefined || generation === 0n) {
        throw new Error('Deno native cleanup received a stale logical handle');
      }
      forgottenHandles.register(owner, Object.freeze({ generation, releaseOwnership }), owner);
    },
    unregisterForgottenHandleCleanup(owner: object): void {
      forgottenHandles.unregister(owner);
    },
  };
}

async function closeDenoGeneration(symbols: DenoSymbols, generation: bigint): Promise<void> {
  const rc = await symbols.oliphaunt_close_if_generation(generation);
  if (rc !== 0 && rc !== 1) {
    throw new Error(`native liboliphaunt generation cleanup failed with status ${rc}`);
  }
}

function assertDenoDirectAdmissionOpen(): void {
  if (!denoDirectAdmissionClosed) return;
  throw new Error(
    'Deno native direct admission is closed because a prior native lifecycle outcome left ownership unknown; restart the process before opening another direct database',
    { cause: denoDirectAdmissionFailure },
  );
}

function closeDenoDirectAdmission(failure: unknown): void {
  if (denoDirectAdmissionClosed) return;
  denoDirectAdmissionClosed = true;
  denoDirectAdmissionFailure = failure;
}

async function prepareDenoPgdata(
  deno: any,
  pgdata: string,
  username: string,
  runtimeDirectory?: string,
  clusterSeedDirectory?: string,
  icuDataDirectory?: string,
  catalogProfile: 'standard' | 'icu' = 'standard',
  emptyDirectories: readonly string[] = [],
): Promise<void> {
  await initializeNativePgdata({
    root: dirname(pgdata),
    pgdata,
    username,
    populatePgdata: async (staging) => {
      if (clusterSeedDirectory !== undefined) {
        await copyNativeClusterSeed(clusterSeedDirectory, staging, emptyDirectories);
        return;
      }
      if (runtimeDirectory === undefined || typeof deno.Command !== 'function') {
        throw new Error(
          'initializing a Deno native database requires runtimeDirectory and Deno.Command',
        );
      }
      const executable = join(
        runtimeDirectory,
        'bin',
        deno.build?.os === 'windows' ? 'initdb.exe' : 'initdb',
      );
      const ambient = typeof deno.env?.toObject === 'function' ? deno.env.toObject() : {};
      const env = nativePostgresChildEnvironment(ambient, {
        icuDataDirectory,
        initdbCatalogProfile: catalogProfile,
      });
      const output = await new deno.Command(executable, {
        args: nativeInitdbArgs(staging),
        stdout: 'null',
        stderr: 'piped',
        env,
        clearEnv: true,
      }).output();
      if (!output.success) {
        throw new Error(`initdb failed: ${new TextDecoder().decode(output.stderr).trim()}`);
      }
    },
  });
}

function createDenoStreamCallback(deno: any, onChunk: (chunk: Uint8Array) => void) {
  let failure: { error: unknown } | undefined;
  const callback = deno.UnsafeCallback.threadSafe(
    { parameters: ['pointer', 'pointer', 'usize'], result: 'i32' },
    (_data: DenoPointer, bytes: DenoPointer, length: bigint) => {
      if (failure !== undefined) return 1;
      try {
        if (bytes === null && length !== 0n) {
          throw new Error('native liboliphaunt stream returned null bytes');
        }
        const size = Number(length);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error('native liboliphaunt stream returned an invalid length');
        }
        const view =
          size === 0
            ? new Uint8Array()
            : new Uint8Array(new deno.UnsafePointerView(bytes).getArrayBuffer(size)).slice();
        const result: unknown = onChunk(view);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          throw new TypeError('native stream callback must complete synchronously');
        }
        return 0;
      } catch (error) {
        failure = { error };
        return 1;
      }
    },
  );
  return {
    callback,
    get failure() {
      return failure;
    },
  };
}

function denoGlobal(): any {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  if (deno === undefined) {
    throw new Error('Deno native binding can only be used inside Deno');
  }
  return deno;
}

function pointerOf(deno: any, value: Uint8Array): bigint {
  const pointer = deno.UnsafePointer.of(value);
  return pointer === null ? 0n : BigInt(deno.UnsafePointer.value(pointer));
}

function pointerFromAddress(deno: any, address: bigint): DenoPointer {
  return address === 0n ? null : deno.UnsafePointer.create(address);
}

function readPointer(value: Uint8Array): bigint {
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, true);
}

function copyResponse(deno: any, symbols: DenoSymbols, response: Uint8Array): Uint8Array {
  try {
    const data = readResponsePointer(response);
    const length = readResponseLength(response);
    if (data === 0n || length === 0) {
      return new Uint8Array();
    }
    const pointer = pointerFromAddress(deno, data);
    if (pointer === null) {
      return new Uint8Array();
    }
    const view = new deno.UnsafePointerView(pointer);
    return new Uint8Array(view.getArrayBuffer(length)).slice();
  } finally {
    symbols.oliphaunt_free_response(response);
  }
}

function lastError(symbols: DenoSymbols, handle: NativeHandle | null): string | null {
  let output = new Uint8Array(1024);
  const reported = Number(
    symbols.oliphaunt_copy_last_error(handle, output, BigInt(output.byteLength)),
  );
  if (!Number.isSafeInteger(reported) || reported < 0) {
    return 'native liboliphaunt returned an invalid error length';
  }
  if (reported >= output.byteLength) {
    output = new Uint8Array(reported + 1);
    symbols.oliphaunt_copy_last_error(handle, output, BigInt(output.byteLength));
  }
  if (reported === 0) {
    return null;
  }
  return new TextDecoder().decode(output.subarray(0, reported));
}

function keepAlive(_values: ReadonlyArray<Uint8Array>): void {
  // Values are referenced until the native call returns; liboliphaunt copies config strings.
}
