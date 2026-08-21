import { applyNativeIcuDataEnvironment, applyNativeRuntimeLibraryEnvironment } from './common.js';
import { loadNodeDirectAddon } from './node-addon.js';
import { prepareNodeExtensionInstall, resolveNodeNativeInstall } from './assets-node.js';
import { initializeNativePgdata } from './initialize.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
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
      await prepareNodePgdata(config.pgdata, config.username, extensionInstall.runtimeDirectory);
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
    backup(handle: NativeHandle): Uint8Array {
      return toUint8Array(addon.backup(handle));
    },
    restore(options: NativeRestoreOptions): void {
      addon.restore({
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
    runInitdb: (staging) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          executable,
          [
            '-D',
            staging,
            '-U',
            username,
            '--auth=trust',
            '--locale-provider=libc',
            '--locale=C',
            '--encoding=UTF8',
          ],
          { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
        );
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
      }),
  });
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
