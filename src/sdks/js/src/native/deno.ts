import {
  applyNativeIcuDataEnvironment,
  applyNativeRuntimeLibraryEnvironment,
  errorMessage,
} from './common.js';
import { resolveDenoNativeInstall, validatePreparedDenoRuntimeExtensions } from './assets-deno.js';
import { dirname, join } from 'node:path';
import { publishNativeDescriptor, validateManagedRoot } from '../root-descriptor.js';
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
  oliphaunt_init: (config: Uint8Array, out: Uint8Array) => number;
  oliphaunt_exec_protocol: (...args: unknown[]) => Promise<number>;
  oliphaunt_exec_simple_query: (...args: unknown[]) => Promise<number>;
  oliphaunt_backup: (...args: unknown[]) => unknown;
  oliphaunt_restore: (...args: unknown[]) => unknown;
  oliphaunt_cancel: (...args: unknown[]) => unknown;
  oliphaunt_detach: (...args: unknown[]) => unknown;
  oliphaunt_last_error: (...args: unknown[]) => unknown;
  oliphaunt_free_response: (...args: unknown[]) => unknown;
};

export async function createDenoNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  const deno = denoGlobal();
  const install = await resolveDenoNativeInstall(options.libraryPath);
  applyNativeIcuDataEnvironment(install.icuDataDirectory);
  applyNativeRuntimeLibraryEnvironment(install.runtimeDirectory);
  const dylib = deno.dlopen(install.libraryPath, {
    oliphaunt_init: { parameters: ['buffer', 'buffer'], result: 'i32' },
    oliphaunt_exec_protocol: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_exec_simple_query: {
      parameters: ['pointer', 'buffer', 'usize', 'buffer'],
      result: 'i32',
      nonblocking: true,
    },
    oliphaunt_backup: { parameters: ['pointer', 'buffer'], result: 'i32' },
    oliphaunt_restore: { parameters: ['buffer'], result: 'i32' },
    oliphaunt_cancel: { parameters: ['pointer'], result: 'i32' },
    oliphaunt_detach: { parameters: ['pointer'], result: 'i32' },
    oliphaunt_last_error: { parameters: ['pointer'], result: 'pointer' },
    oliphaunt_free_response: { parameters: ['buffer'], result: 'void' },
  });
  const symbols = dylib.symbols as DenoSymbols;

  return {
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      let openConfig = {
        ...config,
        runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
      };
      let moduleDirectory: string | undefined;
      if (
        openConfig.extensions.length > 0 &&
        (openConfig.runtimeDirectory === undefined ||
          (install.packageManaged && openConfig.runtimeDirectory === install.runtimeDirectory))
      ) {
        throw new Error(
          `Deno direct execution does not automatically materialize extension packages; pass runtimeDirectory with the selected extension assets or use Node/Bun direct execution. Selected extensions: ${openConfig.extensions.join(', ')}`,
        );
      }
      if (openConfig.extensions.length > 0) {
        const validated = await validatePreparedDenoRuntimeExtensions({
          deno,
          runtimeDirectory: openConfig.runtimeDirectory,
          extensions: openConfig.extensions,
          source: 'Deno direct explicit runtimeDirectory',
        });
        openConfig = { ...openConfig, runtimeDirectory: validated.runtimeDirectory };
        // Keep canonical lib/postgresql subprocess-owned during initdb. The
        // separate lib/modules $libdir is carried in the ABI 7 config.
        moduleDirectory = validated.moduleDirectory;
        applyNativeRuntimeLibraryEnvironment(validated.runtimeDirectory);
      }
      await prepareDenoPgdata(
        deno,
        openConfig.pgdata,
        openConfig.username,
        openConfig.runtimeDirectory,
      );
      const packed = packConfigPointers({ ...openConfig, moduleDirectory }, (value) =>
        pointerOf(deno, value),
      );
      const out = new Uint8Array(8);
      const rc = symbols.oliphaunt_init(packed.config, out);
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
    async execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
      const response = responseBuffer();
      const rc = await symbols.oliphaunt_exec_protocol(
        handle,
        request,
        BigInt(request.byteLength),
        response,
      );
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
    async execSimpleQuery(handle: NativeHandle, sql: string): Promise<Uint8Array> {
      if (sql.includes('\0')) {
        throw new Error('simple query SQL must not contain NUL bytes');
      }
      const bytes = new TextEncoder().encode(sql);
      const response = responseBuffer();
      const rc = await symbols.oliphaunt_exec_simple_query(
        handle,
        bytes,
        BigInt(bytes.byteLength),
        response,
      );
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
    backup(handle: NativeHandle): Uint8Array {
      const response = responseBuffer();
      const rc = symbols.oliphaunt_backup(handle, response) as number;
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

async function prepareDenoPgdata(
  deno: any,
  pgdata: string,
  username: string,
  runtimeDirectory?: string,
): Promise<void> {
  const root = dirname(pgdata);
  if (await validateManagedRoot(root)) return;
  if (runtimeDirectory === undefined || typeof deno.Command !== 'function') {
    throw new Error(
      'initializing a Deno native database requires runtimeDirectory and Deno.Command',
    );
  }
  await deno.mkdir(pgdata);
  try {
    const executable = join(
      runtimeDirectory,
      'bin',
      deno.build?.os === 'windows' ? 'initdb.exe' : 'initdb',
    );
    const output = await new deno.Command(executable, {
      args: [
        '-D',
        pgdata,
        '-U',
        username,
        '--auth=trust',
        '--no-sync',
        '--locale-provider=libc',
        '--locale=C',
        '--encoding=UTF8',
      ],
      stdout: 'null',
      stderr: 'piped',
    }).output();
    if (!output.success) {
      throw new Error(`initdb failed: ${new TextDecoder().decode(output.stderr).trim()}`);
    }
    await publishNativeDescriptor(root);
  } catch (error) {
    await deno.remove(pgdata, { recursive: true }).catch(() => {});
    throw error;
  }
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
