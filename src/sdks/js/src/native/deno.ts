import {
  applyNativeIcuDataEnvironment,
  applyNativeModuleEnvironment,
  assertSupportedDirectBackupFormat,
  errorMessage,
  nativeBackupFormat,
} from './common.js';
import { resolveDenoNativeInstall, validatePreparedDenoRuntimeExtensions } from './assets-deno.js';
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

type DenoPointer = object | null;
type DenoSymbols = {
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

export async function createDenoNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  const deno = denoGlobal();
  const install = await resolveDenoNativeInstall(options.libraryPath);
  applyNativeIcuDataEnvironment(install.icuDataDirectory);
  const dylib = deno.dlopen(install.libraryPath, {
    oliphaunt_init: { parameters: ['buffer', 'buffer'], result: 'i32' },
    oliphaunt_exec_protocol: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer'],
      result: 'i32',
    },
    oliphaunt_exec_simple_query: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer'],
      result: 'i32',
    },
    oliphaunt_backup: { parameters: ['pointer', 'u32', 'buffer'], result: 'i32' },
    oliphaunt_restore: { parameters: ['buffer'], result: 'i32' },
    oliphaunt_cancel: { parameters: ['pointer'], result: 'i32' },
    oliphaunt_detach: { parameters: ['pointer'], result: 'i32' },
    oliphaunt_last_error: { parameters: ['pointer'], result: 'pointer' },
    oliphaunt_version: { parameters: [], result: 'pointer' },
    oliphaunt_capabilities: { parameters: [], result: 'u64' },
    oliphaunt_free_response: { parameters: ['buffer'], result: 'void' },
  });
  const symbols = dylib.symbols as DenoSymbols;

  return {
    runtime: 'deno',
    rawProtocolTransport: 'deno-ffi',
    protocolStream: false,
    defaultRuntimeDirectory: install.runtimeDirectory,
    version(): string {
      return cString(deno, symbols.oliphaunt_version() as DenoPointer) ?? 'unknown';
    },
    capabilities(): bigint {
      return BigInt(symbols.oliphaunt_capabilities() as bigint | number);
    },
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      let openConfig = {
        ...config,
        runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
      };
      if (
        openConfig.extensions.length > 0 &&
        (openConfig.runtimeDirectory === undefined ||
          (install.packageManaged && openConfig.runtimeDirectory === install.runtimeDirectory))
      ) {
        throw new Error(
          `Deno nativeDirect does not automatically materialize extension packages; pass runtimeDirectory with the selected extension assets or use Node/Bun nativeDirect. Selected extensions: ${openConfig.extensions.join(', ')}`,
        );
      }
      if (openConfig.extensions.length > 0) {
        const validated = await validatePreparedDenoRuntimeExtensions({
          deno,
          runtimeDirectory: openConfig.runtimeDirectory,
          extensions: openConfig.extensions,
          source: 'Deno nativeDirect explicit runtimeDirectory',
        });
        openConfig = { ...openConfig, runtimeDirectory: validated.runtimeDirectory };
        applyNativeModuleEnvironment(validated.moduleDirectory);
      }
      const packed = packConfigPointers(openConfig, (value) => pointerOf(deno, value));
      const out = new Uint8Array(8);
      const rc = symbols.oliphaunt_init(packed.config, out) as number;
      keepAlive(packed.keepAlive);
      if (rc !== 0) {
        throw errorMessage('native liboliphaunt init failed', rc, lastError(deno, symbols, null));
      }
      const handle = pointerFromAddress(deno, readPointer(out));
      if (handle === null) {
        throw new Error('native liboliphaunt init returned a null handle');
      }
      return handle;
    },
    execProtocolRaw(handle: NativeHandle, request: Uint8Array): Uint8Array {
      const response = responseBuffer();
      const rc = symbols.oliphaunt_exec_protocol(
        handle,
        request,
        BigInt(request.byteLength),
        response,
      ) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt protocol execution failed',
          rc,
          lastError(deno, symbols, handle),
        );
      }
      return copyResponse(deno, symbols, response);
    },
    execSimpleQuery(handle: NativeHandle, sql: string): Uint8Array {
      if (sql.includes('\0')) {
        throw new Error('simple query SQL must not contain NUL bytes');
      }
      const bytes = new TextEncoder().encode(sql);
      const response = responseBuffer();
      const rc = symbols.oliphaunt_exec_simple_query(
        handle,
        bytes,
        BigInt(bytes.byteLength),
        response,
      ) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt simple query failed',
          rc,
          lastError(deno, symbols, handle),
        );
      }
      return copyResponse(deno, symbols, response);
    },
    backup(handle: NativeHandle, format: BackupFormat): Uint8Array {
      assertSupportedDirectBackupFormat(format);
      const response = responseBuffer();
      const rc = symbols.oliphaunt_backup(handle, nativeBackupFormat(format), response) as number;
      if (rc !== 0) {
        symbols.oliphaunt_free_response(response);
        throw errorMessage(
          'native liboliphaunt backup failed',
          rc,
          lastError(deno, symbols, handle),
        );
      }
      return copyResponse(deno, symbols, response);
    },
    restore(options: NativeRestoreOptions): void {
      if (options.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${options.format}`,
        );
      }
      const packed = packRestoreOptionsPointers(options, (value) => pointerOf(deno, value));
      const rc = symbols.oliphaunt_restore(packed.options) as number;
      keepAlive(packed.keepAlive);
      if (rc !== 0) {
        throw errorMessage(
          'native liboliphaunt restore failed',
          rc,
          lastError(deno, symbols, null),
        );
      }
    },
    cancel(handle: NativeHandle): void {
      const rc = symbols.oliphaunt_cancel(handle) as number;
      if (rc !== 0) {
        throw errorMessage(
          'native liboliphaunt cancel failed',
          rc,
          lastError(deno, symbols, handle),
        );
      }
    },
    detach(handle: NativeHandle): void {
      const rc = symbols.oliphaunt_detach(handle) as number;
      if (rc !== 0) {
        throw errorMessage(
          'native liboliphaunt detach failed',
          rc,
          lastError(deno, symbols, handle),
        );
      }
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

function lastError(deno: any, symbols: DenoSymbols, handle: NativeHandle | null): string | null {
  return cString(deno, symbols.oliphaunt_last_error(handle) as DenoPointer);
}

function cString(deno: any, pointer: DenoPointer): string | null {
  if (pointer === null) {
    return null;
  }
  return new deno.UnsafePointerView(pointer).getCString();
}

function keepAlive(_values: ReadonlyArray<Uint8Array>): void {
  // Values are referenced until the native call returns; liboliphaunt copies config strings.
}
