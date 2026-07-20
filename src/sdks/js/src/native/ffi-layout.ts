import {
  ABI_VERSION,
  INIT_OPTIONS_ABI_VERSION,
  RESTORE_REPLACE_EXISTING,
  nativeBackupFormat,
} from './common.js';
import type { NativeOpenConfig, NativeRestoreOptions } from './types.js';

export const POINTER_SIZE = 8;
export const OLIPHAUNT_CONFIG_SIZE = 64;
export const OLIPHAUNT_INIT_OPTIONS_SIZE = 24;
export const OLIPHAUNT_RESPONSE_SIZE = 16;
export const OLIPHAUNT_RESTORE_OPTIONS_SIZE = 48;

const textEncoder = new TextEncoder();

export type PointerReader = (value: Uint8Array) => bigint;

export function cString(value: string): Uint8Array {
  if (value.includes('\0')) {
    throw new Error('native C string must not contain NUL bytes');
  }
  const bytes = textEncoder.encode(value);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

export function packPointerArray(pointers: ReadonlyArray<bigint>): Uint8Array {
  const out = new Uint8Array(Math.max(1, pointers.length) * POINTER_SIZE);
  const view = new DataView(out.buffer);
  for (const [index, pointer] of pointers.entries()) {
    writePointer(view, index * POINTER_SIZE, pointer);
  }
  return out;
}

export function packConfigPointers(
  config: NativeOpenConfig,
  pointerOf: PointerReader,
): { config: Uint8Array; keepAlive: Uint8Array[] } {
  const pgdata = cString(config.pgdata);
  const runtimeDirectory = config.runtimeDirectory ? cString(config.runtimeDirectory) : undefined;
  const username = cString(config.username);
  const database = cString(config.database);
  const startupStrings = config.startupArgs.map(cString);
  const startupPointerArray = packPointerArray(startupStrings.map(pointerOf));
  const out = new Uint8Array(OLIPHAUNT_CONFIG_SIZE);
  const view = new DataView(out.buffer);

  view.setUint32(0, ABI_VERSION, true);
  writePointer(view, 8, pointerOf(pgdata));
  writePointer(view, 16, runtimeDirectory ? pointerOf(runtimeDirectory) : 0n);
  writePointer(view, 24, pointerOf(username));
  writePointer(view, 32, pointerOf(database));
  view.setBigUint64(40, 0n, true);
  writePointer(view, 48, config.startupArgs.length > 0 ? pointerOf(startupPointerArray) : 0n);
  writeSize(view, 56, config.startupArgs.length);

  return {
    config: out,
    keepAlive: [
      pgdata,
      ...(runtimeDirectory ? [runtimeDirectory] : []),
      username,
      database,
      ...startupStrings,
      startupPointerArray,
    ],
  };
}

export function packInitOptionsPointers(
  moduleDirectory: string,
  pointerOf: PointerReader,
): { options: Uint8Array; keepAlive: Uint8Array[] } {
  if (moduleDirectory.length === 0) {
    throw new Error('native module directory must not be empty');
  }
  const moduleDirectoryBytes = cString(moduleDirectory);
  const out = new Uint8Array(OLIPHAUNT_INIT_OPTIONS_SIZE);
  const view = new DataView(out.buffer);

  view.setUint32(0, INIT_OPTIONS_ABI_VERSION, true);
  writePointer(view, 8, pointerOf(moduleDirectoryBytes));
  view.setBigUint64(16, 0n, true);

  return { options: out, keepAlive: [moduleDirectoryBytes] };
}

export function packRestoreOptionsPointers(
  options: NativeRestoreOptions,
  pointerOf: PointerReader,
): { options: Uint8Array; keepAlive: Uint8Array[] } {
  const root = cString(options.root);
  const out = new Uint8Array(OLIPHAUNT_RESTORE_OPTIONS_SIZE);
  const view = new DataView(out.buffer);

  view.setUint32(0, ABI_VERSION, true);
  writePointer(view, 8, pointerOf(root));
  view.setUint32(16, nativeBackupFormat(options.format), true);
  writePointer(view, 24, options.bytes.byteLength > 0 ? pointerOf(options.bytes) : 0n);
  writeSize(view, 32, options.bytes.byteLength);
  view.setBigUint64(40, options.replaceExisting ? RESTORE_REPLACE_EXISTING : 0n, true);

  return { options: out, keepAlive: [root, options.bytes] };
}

export function responseBuffer(): Uint8Array {
  return new Uint8Array(OLIPHAUNT_RESPONSE_SIZE);
}

export function readResponsePointer(response: Uint8Array): bigint {
  return readPointer(new DataView(response.buffer, response.byteOffset, response.byteLength), 0);
}

export function readResponseLength(response: Uint8Array): number {
  return readSize(new DataView(response.buffer, response.byteOffset, response.byteLength), 8);
}

export function readPointer(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

export function writePointer(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

export function readSize(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`native size_t value ${value} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function writeSize(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid native size_t value ${value}`);
  }
  view.setBigUint64(offset, BigInt(value), true);
}
