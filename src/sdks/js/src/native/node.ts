import {
  applyNativeIcuDataEnvironment,
  applyNativeModuleEnvironment,
  assertSupportedDirectBackupFormat,
  nativeBackupFormat,
} from './common.js';
import { loadNodeDirectAddon } from './node-addon.js';
import { prepareNodeExtensionInstall, resolveNodeNativeInstall } from './assets-node.js';
import type { BackupFormat } from '../types.js';
import type {
  NativeBinding,
  NativeBindingOptions,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from './types.js';

export async function createNodeNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  const install = await resolveNodeNativeInstall(options.libraryPath);
  applyNativeIcuDataEnvironment(install.icuDataDirectory);
  const addon = await loadNodeDirectAddon(options.nodeAddonPath);

  return {
    runtime: 'node',
    rawProtocolTransport: 'node-addon',
    protocolStream: true,
    defaultRuntimeDirectory: install.runtimeDirectory,
    version(): string {
      return addon.version(install.libraryPath);
    },
    capabilities(): bigint {
      return BigInt(addon.capabilities(install.libraryPath));
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
      return addon.open({
        ...config,
        libraryPath: extensionInstall.libraryPath,
        runtimeDirectory: extensionInstall.runtimeDirectory,
      });
    },
    execProtocolRaw(handle: NativeHandle, request: Uint8Array): Uint8Array {
      return toUint8Array(addon.execProtocolRaw(handle, request));
    },
    execSimpleQuery(handle: NativeHandle, sql: string): Uint8Array {
      return toUint8Array(addon.execSimpleQuery(handle, sql));
    },
    execProtocolStream(
      handle: NativeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): void {
      addon.execProtocolStream(handle, request, (chunk) => onChunk(toUint8Array(chunk)));
    },
    backup(handle: NativeHandle, format: BackupFormat): Uint8Array {
      assertSupportedDirectBackupFormat(format);
      return toUint8Array(addon.backup(handle, nativeBackupFormat(format)));
    },
    restore(options: NativeRestoreOptions): void {
      if (options.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${options.format}`,
        );
      }
      addon.restore({
        libraryPath: install.libraryPath,
        root: options.root,
        format: nativeBackupFormat(options.format),
        bytes: options.bytes,
        replaceExisting: options.replaceExisting,
      });
    },
    cancel(handle: NativeHandle): void {
      addon.cancel(handle);
    },
    detach(handle: NativeHandle): void {
      addon.detach(handle);
    },
  };
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
