import {
  applyNativeIcuDataEnvironment,
  applyNativeRuntimeLibraryEnvironment,
  replaceNativeIcuDataEnvironment,
} from './common.js';
import { loadNodeDirectAddon } from './node-addon.js';
import { prepareNodeExtensionInstall, resolveNodeNativeInstall } from './assets-node.js';
import {
  copyNativeClusterSeed,
  initializeNativePgdata,
  nativeInitdbArgs,
  nativePostgresChildEnvironment,
} from './initialize.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveExactNativeRuntimeProfile } from './runtime-profile.js';
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
  applyNativeRuntimeLibraryEnvironment(install.runtimeDirectory);
  const addon = await loadNodeDirectAddon(options.nodeAddonPath);

  return {
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      const explicitRuntimeDirectory =
        config.runtimeDirectory !== undefined || install.packageManaged === false;
      let extensionInstall = await prepareNodeExtensionInstall(
        {
          ...install,
          runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
          clusterSeedDirectory:
            config.runtimeDirectory === undefined ? install.clusterSeedDirectory : undefined,
        },
        config.extensions,
        {
          explicitRuntimeDirectory,
        },
      );
      if (explicitRuntimeDirectory && extensionInstall.runtimeDirectory !== undefined) {
        extensionInstall = {
          ...extensionInstall,
          ...(await resolveExactNativeRuntimeProfile(extensionInstall.runtimeDirectory)),
          clusterSeedDirectory: undefined,
        };
        replaceNativeIcuDataEnvironment(extensionInstall.icuDataDirectory);
      }
      applyNativeRuntimeLibraryEnvironment(extensionInstall.runtimeDirectory);
      await prepareNodePgdata(
        config.pgdata,
        config.username,
        extensionInstall.runtimeDirectory,
        extensionInstall.clusterSeedDirectory,
        extensionInstall.icuDataDirectory,
        extensionInstall.catalogProfile,
      );
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
    execProtocolStream(
      handle: NativeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): void {
      addon.execProtocolStream(handle, request, onChunk);
    },
    async execSimpleQuery(handle: NativeHandle, sql: string): Promise<Uint8Array> {
      return toUint8Array(await addon.execSimpleQuery(handle, sql));
    },
    async backup(handle: NativeHandle): Promise<Uint8Array> {
      return toUint8Array(await addon.backup(handle));
    },
    async restore(options: NativeRestoreOptions): Promise<void> {
      await addon.restore({
        libraryPath: install.libraryPath,
        destination: options.destination,
        bytes: options.bytes,
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

async function prepareNodePgdata(
  pgdata: string,
  username: string,
  runtimeDirectory?: string,
  clusterSeedDirectory?: string,
  icuDataDirectory?: string,
  catalogProfile: 'standard' | 'icu' = 'standard',
): Promise<void> {
  if (runtimeDirectory === undefined) {
    throw new Error('initializing a native database requires runtimeDirectory with initdb');
  }
  const executable = join(
    runtimeDirectory,
    'bin',
    process.platform === 'win32' ? 'initdb.exe' : 'initdb',
  );
  await initializeNativePgdata({
    root: dirname(pgdata),
    pgdata,
    username,
    populatePgdata: (staging) => {
      if (clusterSeedDirectory !== undefined) {
        return copyNativeClusterSeed(clusterSeedDirectory, staging);
      }
      return new Promise<void>((resolve, reject) => {
        const env = nativePostgresChildEnvironment(process.env, {
          icuDataDirectory,
          initdbCatalogProfile: catalogProfile,
        });
        const child = spawn(executable, nativeInitdbArgs(staging), {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const errors: Buffer[] = [];
        child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `initdb failed with exit code ${code ?? 'unknown'}: ${Buffer.concat(errors).toString('utf8').trim()}`,
                ),
              ),
        );
      });
    },
  });
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
