import {
  applyNativeIcuDataEnvironment,
  applyNativeModuleEnvironment,
  assertSupportedDirectBackupFormat,
  errorMessage,
  nativeBackupFormat,
} from './common.js';
import { prepareNodeExtensionInstall, resolveNodeNativeInstall } from './assets-node.js';
import type { BackupFormat } from '../types.js';
import {
  packConfigPointers,
  packRestoreOptionsPointers,
  readResponseLength,
  readResponsePointer,
  responseBuffer,
} from './ffi-layout.js';
import type {
  NativeBinding,
  NativeBindingOptions,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from './types.js';

type BunSymbols = {
  oliphaunt_init: (...args: unknown[]) => unknown;
  oliphaunt_exec_protocol: (...args: unknown[]) => unknown;
  oliphaunt_exec_simple_query: (...args: unknown[]) => unknown;
  oliphaunt_backup: (...args: unknown[]) => unknown;
  oliphaunt_restore: (...args: unknown[]) => unknown;
  oliphaunt_cancel: (...args: unknown[]) => unknown;
  oliphaunt_detach: (...args: unknown[]) => unknown;
  oliphaunt_last_error: (...args: unknown[]) => unknown;
  oliphaunt_version: (...args: unknown[]) => unknown;
  oliphaunt_capabilities: (...args: unknown[]) => unknown;
  oliphaunt_free_response: (...args: unknown[]) => unknown;
};

export async function createBunNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  const install = await resolveNodeNativeInstall(options.libraryPath);
  applyNativeIcuDataEnvironment(install.icuDataDirectory);
  const ffi = await import('bun:ffi');
  const symbols = loadSymbols(ffi, install.libraryPath);

  return {
    runtime: 'bun',
    rawProtocolTransport: 'bun-ffi',
    protocolStream: false,
    defaultRuntimeDirectory: install.runtimeDirectory,
    version(): string {
      return String(symbols.oliphaunt_version());
    },
    capabilities(): bigint {
      return BigInt(symbols.oliphaunt_capabilities() as number | bigint);
    },
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      const extensionInstall = await prepareNodeExtensionInstall(
        {
          ...install,
          runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
        },
        config.extensions,
        {
          explicitRuntimeDirectory:
            config.runtimeDirectory !== undefined || install.packageManaged === false,
        },
      );
      applyNativeModuleEnvironment(extensionInstall.moduleDirectory);
      const packed = packConfigPointers(
        {
          ...config,
          runtimeDirectory: extensionInstall.runtimeDirectory,
        },
        (value) => pointerOf(ffi, value),
      );
      const out = new Uint8Array(8);
      const rc = symbols.oliphaunt_init(packed.config, out) as number;
      keepAlive(packed.keepAlive);
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt init failed', rc, lastError(symbols, null));
      }
      const handle = readPointer(out);
      if (handle === 0n) {
        throw new Error('native liboliphaunt init returned a null handle');
      }
      return handle;
    },
    execProtocolRaw(handle: NativeHandle, request: Uint8Array): Uint8Array {
      const response = responseBuffer();
      const rc = symbols.oliphaunt_exec_protocol(
        pointerArgument(handle),
        request,
        request.byteLength,
        response,
      ) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt protocol execution failed',
          rc,
          lastError(symbols, handle),
        );
      }
      return copyResponse(ffi, symbols, response);
    },
    execSimpleQuery(handle: NativeHandle, sql: string): Uint8Array {
      if (sql.includes('\0')) {
        throw new Error('simple query SQL must not contain NUL bytes');
      }
      const bytes = new TextEncoder().encode(sql);
      const response = responseBuffer();
      const rc = symbols.oliphaunt_exec_simple_query(
        pointerArgument(handle),
        bytes,
        bytes.byteLength,
        response,
      ) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt simple query failed',
          rc,
          lastError(symbols, handle),
        );
      }
      return copyResponse(ffi, symbols, response);
    },
    backup(handle: NativeHandle, format: BackupFormat): Uint8Array {
      assertSupportedDirectBackupFormat(format);
      const response = responseBuffer();
      const rc = symbols.oliphaunt_backup(
        pointerArgument(handle),
        nativeBackupFormat(format),
        response,
      ) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage('native liboliphaunt backup failed', rc, lastError(symbols, handle));
      }
      return copyResponse(ffi, symbols, response);
    },
    restore(options: NativeRestoreOptions): void {
      if (options.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${options.format}`,
        );
      }
      const packed = packRestoreOptionsPointers(options, (value) => pointerOf(ffi, value));
      const rc = symbols.oliphaunt_restore(packed.options) as number;
      keepAlive(packed.keepAlive);
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt restore failed', rc, lastError(symbols, null));
      }
    },
    cancel(handle: NativeHandle): void {
      const rc = symbols.oliphaunt_cancel(pointerArgument(handle)) as number;
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt cancel failed', rc, lastError(symbols, handle));
      }
    },
    detach(handle: NativeHandle): void {
      const rc = symbols.oliphaunt_detach(pointerArgument(handle)) as number;
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt detach failed', rc, lastError(symbols, handle));
      }
    },
  };
}

function loadSymbols(ffi: typeof import('bun:ffi'), libraryPath: string): BunSymbols {
  const { dlopen, FFIType } = ffi;
  const { i32, u32, u64, ptr, buffer, cstring, void: voidType } = FFIType;
  return dlopen(libraryPath, {
    oliphaunt_init: { args: [buffer, buffer], returns: i32 },
    oliphaunt_exec_protocol: { args: [ptr, buffer, u64, buffer], returns: i32 },
    oliphaunt_exec_simple_query: { args: [ptr, buffer, u64, buffer], returns: i32 },
    oliphaunt_backup: { args: [ptr, u32, buffer], returns: i32 },
    oliphaunt_restore: { args: [buffer], returns: i32 },
    oliphaunt_cancel: { args: [ptr], returns: i32 },
    oliphaunt_detach: { args: [ptr], returns: i32 },
    oliphaunt_last_error: { args: [ptr], returns: cstring },
    oliphaunt_version: { args: [], returns: cstring },
    oliphaunt_capabilities: { args: [], returns: u64 },
    oliphaunt_free_response: { args: [buffer], returns: voidType },
  }).symbols as BunSymbols;
}

function pointerOf(ffi: typeof import('bun:ffi'), value: Uint8Array): bigint {
  return BigInt(ffi.ptr(value) as number | bigint);
}

function pointerArgument(value: NativeHandle): number {
  return Number(value as bigint);
}

function readPointer(value: Uint8Array): bigint {
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, true);
}

function copyResponse(
  ffi: typeof import('bun:ffi'),
  symbols: BunSymbols,
  response: Uint8Array,
): Uint8Array {
  try {
    const data = readResponsePointer(response);
    const length = readResponseLength(response);
    if (data === 0n || length === 0) {
      return new Uint8Array();
    }
    return new Uint8Array(ffi.toArrayBuffer(Number(data), 0, length)).slice();
  } finally {
    symbols.oliphaunt_free_response(response);
  }
}

function lastError(symbols: BunSymbols, handle: NativeHandle | null): string | null {
  const value = symbols.oliphaunt_last_error(handle === null ? null : pointerArgument(handle));
  return value == null ? null : String(value);
}

function keepAlive(_values: ReadonlyArray<Uint8Array>): void {
  // Values are referenced until the native call returns; liboliphaunt copies config strings.
}
