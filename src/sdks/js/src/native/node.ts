import {
  applyNativeIcuDataEnvironment,
  applyNativeRuntimeLibraryEnvironment,
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
  runtime: 'node' | 'bun' = 'node',
): Promise<NativeBinding> {
  const install = await resolveNodeNativeInstall(options.libraryPath);
  applyNativeIcuDataEnvironment(install.icuDataDirectory);
  applyNativeRuntimeLibraryEnvironment(install.runtimeDirectory);
  const addon = await loadNodeDirectAddon(options.nodeAddonPath);

  return {
    runtime,
    rawProtocolTransport: 'node-addon',
    // Raw and simple queries run as Node-API async work so the event loop can
    // deliver cancel(). The legacy callback stream entry point is synchronous;
    // keep it out of the public capability until it has the same property.
    protocolStream: false,
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
      applyNativeRuntimeLibraryEnvironment(extensionInstall.runtimeDirectory);
      return addon.open({
        ...config,
        libraryPath: extensionInstall.libraryPath,
        runtimeDirectory: extensionInstall.runtimeDirectory,
        moduleDirectory: extensionInstall.moduleDirectory,
      });
    },
    async execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
      return toUint8Array(await addon.execProtocolRaw(handle, request));
    },
    async execSimpleQuery(handle: NativeHandle, sql: string): Promise<Uint8Array> {
      return toUint8Array(await addon.execSimpleQuery(handle, sql));
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
        destination: options.destination,
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
