import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { prepareExtensionInstall, resolveNativeInstall, selectNativeResources } from './assets.js';
import { applyNativeRuntimeLibraryEnvironment } from './common.js';
import {
  copyNativeClusterSeed,
  initializeNativePgdata,
  nativeInitdbArgs,
  nativePostgresChildEnvironment,
} from './initialize.js';
import { loadNodeDirectAddon } from './node-addon.js';
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
  const install = await resolveNativeInstall(options.libraryPath);
  applyNativeRuntimeLibraryEnvironment(install.runtimeDirectory);
  const addon = await loadNodeDirectAddon(options.nodeAddonPath);
  const forgottenHandles = new FinalizationRegistry<{
    readonly recoveryToken: unknown;
    readonly releaseOwnership: () => void;
  }>(({ recoveryToken, releaseOwnership }) => {
    try {
      // The addon only marks this exact logical generation for recovery. The
      // actual PostgreSQL detach remains on the next open's async worker.
      if (addon.queueForgottenHandleRecovery(recoveryToken)) {
        releaseOwnership();
      }
    } catch {
      // Finalizer failures are unobservable. Keep the JavaScript admission
      // lease closed if native recovery could not be queued safely.
    }
  });

  return {
    async open(config: NativeOpenConfig): Promise<NativeHandle> {
      const selectedInstall = await selectNativeResources(install, config, dirname(config.pgdata));
      const explicitRuntimeDirectory =
        config.runtimeDirectory !== undefined || selectedInstall.packageManaged === false;
      let extensionInstall = await prepareExtensionInstall(
        {
          ...selectedInstall,
          runtimeDirectory: config.runtimeDirectory ?? selectedInstall.runtimeDirectory,
          clusterSeedDirectory: selectedInstall.clusterSeedDirectory,
        },
        config.extensions,
        {
          explicitRuntimeDirectory,
        },
      );
      if (
        explicitRuntimeDirectory &&
        config.icuData === undefined &&
        extensionInstall.runtimeDirectory !== undefined
      ) {
        extensionInstall = {
          ...extensionInstall,
          ...(await resolveExactNativeRuntimeProfile(extensionInstall.runtimeDirectory)),
        };
      }
      applyNativeRuntimeLibraryEnvironment(extensionInstall.runtimeDirectory);
      await prepareNodePgdata(
        config.pgdata,
        config.username,
        extensionInstall.runtimeDirectory,
        extensionInstall.clusterSeedDirectory,
        extensionInstall.icuDataDirectory,
        extensionInstall.catalogProfile,
        extensionInstall.clusterSeedEmptyDirectories,
      );
      return await addon.open({
        ...config,
        libraryPath: extensionInstall.libraryPath,
        runtimeDirectory: extensionInstall.runtimeDirectory,
        moduleDirectory: extensionInstall.moduleDirectory,
        icuDataDirectory: extensionInstall.icuDataDirectory,
      });
    },
    async execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
      return toUint8Array(await addon.execProtocolRaw(handle, request));
    },
    async execProtocolStream(
      handle: NativeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      await addon.execProtocolRawStream(handle, request, onChunk);
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
    async cancel(handle: NativeHandle): Promise<void> {
      addon.cancel(handle);
    },
    async detach(handle: NativeHandle): Promise<void> {
      await addon.detach(handle);
    },
    registerForgottenHandleCleanup(
      owner: object,
      handle: NativeHandle,
      releaseOwnership: () => void,
    ): void {
      forgottenHandles.register(
        owner,
        Object.freeze({
          recoveryToken: addon.createForgottenHandleRecoveryToken(handle),
          releaseOwnership,
        }),
        owner,
      );
    },
    unregisterForgottenHandleCleanup(owner: object): void {
      forgottenHandles.unregister(owner);
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
  emptyDirectories: readonly string[] = [],
): Promise<void> {
  await initializeNativePgdata({
    root: dirname(pgdata),
    pgdata,
    username,
    populatePgdata: (staging) => {
      if (clusterSeedDirectory !== undefined) {
        return copyNativeClusterSeed(clusterSeedDirectory, staging, emptyDirectories);
      }
      if (runtimeDirectory === undefined) {
        throw new Error('initializing a native database requires runtimeDirectory with initdb');
      }
      const executable = join(
        runtimeDirectory,
        'bin',
        process.platform === 'win32' ? 'initdb.exe' : 'initdb',
      );
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
