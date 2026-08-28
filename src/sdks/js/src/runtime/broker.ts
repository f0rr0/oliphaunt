import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, platform } from 'node:os';
import { readFile, stat } from 'node:fs/promises';

import type { NormalizedOpenConfig } from '../config.js';
import type { DenoRuntime } from '../native/assets-deno.js';
import {
  ICU_DATA_ENV,
  envVar,
  LIBOLIPHAUNT_RUNTIME_DIR_ENV,
  nativeRuntimeLibraryEnvironment,
  OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV,
  OLIPHAUNT_ICU_DATA_DIR_ENV,
} from '../native/common.js';
import {
  readBrokerResponse,
  writeBrokerRequest,
  type BrokerResponseFrame,
} from './broker-frames.js';
import type { ByteStream } from './byte-stream.js';
import {
  connectEndpoint,
  cleanupFailedManagedLaunch,
  createTempDir,
  parseReadyEndpoint,
  randomHexToken,
  readReadyLine,
  removeTree,
  spawnManagedChild,
  unixSocketPathsFit,
  waitForManagedChild,
  type ManagedChild,
  type FailedManagedLaunch,
} from './node-adapter.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';
import { throwCollectedCloseFailures } from './close.js';
import { createForgottenRuntimeHandleCleanup } from './forgotten-handle.js';
import { resolveExactNativeRuntimeProfile } from '../native/runtime-profile.js';

const READY_PREFIX = 'OLIPHAUNT_BROKER_READY ';
const ERROR_PREFIX = 'OLIPHAUNT_BROKER_ERROR ';
const LIBOLIPHAUNT_PATH_ENV = 'LIBOLIPHAUNT_PATH';
const OLIPHAUNT_INSTALL_DIR_ENV = 'OLIPHAUNT_INSTALL_DIR';
const OLIPHAUNT_BROKER_ENV = 'OLIPHAUNT_BROKER';
const OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS_ENV = 'OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);

export type BrokerRuntimeBindingOptions = {
  executable?: string;
};

export function createBrokerRuntimeBinding(
  options: BrokerRuntimeBindingOptions = {},
): RuntimeBinding {
  const forgottenHandles = createForgottenRuntimeHandleCleanup<BrokerHandle>((handle) =>
    handle.detach(),
  );
  return {
    async open(config: NormalizedOpenConfig): Promise<BrokerHandle> {
      return openBrokerHandle(config.brokerExecutable ?? options.executable, config);
    },
    execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({
        kind: 'execProtocol',
        bytes: request,
      });
    },
    execProtocolStream(
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      return asBrokerHandle(handle).execProtocolStream(request, onChunk);
    },
    execSimpleQuery(handle: RuntimeHandle, sql: string): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({ kind: 'execSimpleQuery', sql });
    },
    backup(handle: RuntimeHandle): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({ kind: 'backup' });
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return asBrokerHandle(handle).cancel();
    },
    async close(handle: RuntimeHandle) {
      try {
        await asBrokerHandle(handle).detach();
        return { state: 'closed' };
      } catch (error) {
        // BrokerHandle.detach() crosses its destructive cutoff before any
        // fallible teardown. The public owner must be retired even when later
        // process or filesystem cleanup reports an error.
        return { state: 'terminal', error };
      }
    },
    registerForgottenHandleCleanup(
      owner: object,
      handle: RuntimeHandle,
      _releaseOwnership: () => void,
    ): void {
      forgottenHandles.register(owner, asBrokerHandle(handle));
    },
    unregisterForgottenHandleCleanup(owner: object): void {
      forgottenHandles.unregister(owner);
    },
  };
}

/** @internal Runtime-owned handle; exported only for package-internal contract tests. */
export class BrokerHandle {
  #child: ManagedChild | undefined;
  #stream: ByteStream | undefined;
  #cancelEndpoint: string | undefined;
  #ipcDir: string | undefined;
  #temporaryInstanceDirectory: string | undefined;
  #authToken: string | undefined;
  #failed = false;
  #failure: unknown;
  #closed = false;

  constructor(
    readonly config: NormalizedOpenConfig,
    launch: BrokerLaunch,
    authToken: string,
    private readonly shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  ) {
    this.#child = launch.child;
    this.#stream = launch.stream;
    this.#cancelEndpoint = launch.cancelEndpoint;
    this.#ipcDir = launch.ipcDir;
    this.#temporaryInstanceDirectory = config.temporaryDirectory
      ? config.instanceDirectory
      : undefined;
    this.#authToken = authToken;
  }

  async requestOk(frame: Parameters<typeof writeBrokerRequest>[1]): Promise<Uint8Array> {
    const response = await this.request(frame);
    switch (response.kind) {
      case 'ok':
        return response.bytes;
      case 'error':
        throw new Error(response.message);
      case 'chunk':
        throw new Error('native broker returned a stream chunk for a buffered request');
      case 'streamCallbackAborted':
        throw new Error(
          `native broker returned a stream callback-aborted frame for a buffered request: ${response.message}`,
        );
    }
  }

  async execProtocolStream(
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    const stream = await this.ensureStream();
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      await writeBrokerRequest(stream, {
        kind: 'execProtocolStream',
        bytes: request,
      });
    } catch (error) {
      await this.markFailed(error);
      throw error;
    }
    for (;;) {
      let response: BrokerResponseFrame;
      try {
        response = await readBrokerResponse(stream);
      } catch (error) {
        await this.markFailed(error);
        throw error;
      }
      switch (response.kind) {
        case 'chunk':
          if (!callbackFailed) {
            try {
              onChunk(response.bytes);
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
            }
          }
          break;
        case 'ok':
          resolveBrokerStreamCompletion(response, callbackFailed, callbackError);
          return;
        case 'error':
        case 'streamCallbackAborted':
          resolveBrokerStreamCompletion(response, callbackFailed, callbackError);
          return;
      }
    }
  }

  async cancel(): Promise<void> {
    const endpoint = this.#cancelEndpoint;
    if (endpoint === undefined) {
      throw new Error('native broker cancel endpoint is unavailable');
    }
    const authToken = this.#authToken;
    if (authToken === undefined) {
      throw new Error('native broker auth token is unavailable');
    }
    const stream = await connectEndpoint(parseReadyEndpoint(endpoint));
    await cancelBrokerStream(stream, authToken);
  }

  async detach(): Promise<void> {
    const firstAttempt = !this.#closed;
    this.#closed = true;
    this.#cancelEndpoint = undefined;
    this.#authToken = undefined;
    const failures: unknown[] = [];
    const stream = this.#stream;
    if (stream !== undefined) {
      if (firstAttempt && !this.#failed) {
        try {
          await writeBrokerRequest(stream, { kind: 'close' });
          const response = await readBrokerResponse(stream);
          if (response.kind === 'error') {
            throw new Error(`native broker close failed: ${response.message}`);
          }
          if (response.kind === 'chunk') {
            throw new Error('native broker close returned a stream chunk');
          }
          if (response.kind === 'streamCallbackAborted') {
            throw new Error(
              `native broker close returned a stream callback-aborted frame: ${response.message}`,
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await stream.close();
        if (this.#stream === stream) {
          this.#stream = undefined;
        }
      } catch (error) {
        // Retain the exact stream so a later internal cleanup attempt can
        // retry releasing it. Public close still memoizes this first terminal
        // result and never presents the handle as usable again.
        failures.push(error);
      }
    }
    const child = this.#child;
    if (child !== undefined) {
      try {
        let exited = await waitForManagedChild(child, this.shutdownTimeoutMs);
        if (!exited) {
          failures.push(new Error(`native broker did not stop within ${this.shutdownTimeoutMs}ms`));
          child.kill('SIGKILL');
          exited = await waitForManagedChild(child, this.shutdownTimeoutMs);
          if (!exited) {
            failures.push(
              new Error(
                `native broker was not reaped within ${this.shutdownTimeoutMs}ms after SIGKILL`,
              ),
            );
          }
        }
        if (exited && this.#child === child) {
          this.#child = undefined;
        }
      } catch (error) {
        // An unconfirmed reap remains owned by this terminal handle. Never
        // discard the only child handle merely because wait/kill failed.
        failures.push(error);
      }
    }
    // A process whose reap is unconfirmed may still have its IPC endpoint and
    // PGDATA open. Never remove either tree underneath it; retain the exact
    // paths until a later internal cleanup attempt confirms the reap.
    if (this.#child === undefined) {
      const ipcDir = this.#ipcDir;
      try {
        await removeTree(ipcDir);
        if (this.#ipcDir === ipcDir) {
          this.#ipcDir = undefined;
        }
      } catch (error) {
        // Retain the path so later best-effort cleanup can retry it.
        failures.push(error);
      }
      const temporaryInstanceDirectory = this.#temporaryInstanceDirectory;
      if (temporaryInstanceDirectory !== undefined) {
        try {
          await removeTree(temporaryInstanceDirectory);
          if (this.#temporaryInstanceDirectory === temporaryInstanceDirectory) {
            this.#temporaryInstanceDirectory = undefined;
          }
        } catch (error) {
          // Retain the managed-root cleanup identity after a failed removal.
          failures.push(error);
        }
      }
    }
    if (
      this.#stream !== undefined ||
      this.#child !== undefined ||
      this.#ipcDir !== undefined ||
      this.#temporaryInstanceDirectory !== undefined
    ) {
      // Public close is terminal after the first destructive attempt, so no
      // later facade call is available to own these uncertain resources. Keep
      // the exact private handle alive through process exit instead of letting
      // GC discard the only stream/child/path cleanup identity.
      retainedFailedBrokerHandles.add(this);
    } else {
      retainedFailedBrokerHandles.delete(this);
    }
    throwCollectedCloseFailures(failures, 'native broker teardown failed');
  }

  async request(frame: Parameters<typeof writeBrokerRequest>[1]): Promise<BrokerResponseFrame> {
    const stream = await this.ensureStream();
    try {
      await writeBrokerRequest(stream, frame);
      return await readBrokerResponse(stream);
    } catch (error) {
      await this.markFailed(error);
      throw error;
    }
  }

  async ensureStream(): Promise<ByteStream> {
    if (this.#closed) {
      throw new Error('native broker session is closed');
    }
    if (this.#failed) {
      throw new Error(
        'native broker helper failed; close and reopen the database before running more work',
        { cause: this.#failure },
      );
    }
    if (this.#stream === undefined) {
      throw new Error(
        'native broker stream is unavailable; close and reopen the database before running more work',
      );
    }
    return this.#stream;
  }

  async markFailed(error: unknown): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
    const stream = this.#stream;
    try {
      await stream?.close();
      if (this.#stream === stream) {
        this.#stream = undefined;
      }
    } catch {
      // Preserve the operation/transport failure that made session state
      // unknown. Keep cleanup ownership so explicit close can retry it.
    }
    const child = this.#child;
    if (child !== undefined) {
      try {
        child.kill('SIGKILL');
        const reaped = await waitForManagedChild(child, this.shutdownTimeoutMs);
        if (reaped && this.#child === child) {
          this.#child = undefined;
        }
      } catch {
        // Retain the child handle so explicit close can retry reaping it.
      }
    }
    if (this.#child === undefined) {
      const ipcDir = this.#ipcDir;
      try {
        await removeTree(ipcDir);
        if (this.#ipcDir === ipcDir) {
          this.#ipcDir = undefined;
        }
      } catch {
        // Retain the path so explicit close retries filesystem cleanup.
      }
    }
    this.#cancelEndpoint = undefined;
    this.#authToken = undefined;
  }
}

/** @internal Execute one out-of-band cancellation and always release its control stream. */
export async function cancelBrokerStream(stream: ByteStream, authToken: string): Promise<void> {
  try {
    await authenticateBroker(stream, authToken);
    await writeBrokerRequest(stream, { kind: 'cancel' });
    const response = await readBrokerResponse(stream);
    if (response.kind === 'error') {
      throw new Error(`native broker cancel failed: ${response.message}`);
    }
    if (response.kind === 'chunk') {
      throw new Error('native broker cancel endpoint returned a stream chunk');
    }
    if (response.kind === 'streamCallbackAborted') {
      throw new Error(
        `native broker cancel endpoint returned a stream callback-aborted frame: ${response.message}`,
      );
    }
  } catch (primaryFailure) {
    try {
      await stream.close();
    } catch (closeFailure) {
      throw new AggregateError(
        [primaryFailure, closeFailure],
        'native broker cancel and control-stream close both failed',
      );
    }
    throw primaryFailure;
  }
  await stream.close();
}

// Intentionally process-lifetime ownership for resources whose destructive
// cleanup did not complete. Entries are removed only if a package-internal
// best-effort retry later releases every exact resource.
const retainedFailedBrokerHandles = new Set<BrokerHandle>();

async function openBrokerHandle(
  executable: string | undefined,
  config: NormalizedOpenConfig,
): Promise<BrokerHandle> {
  const authToken = randomHexToken();
  const launch = await launchBroker(executable, config, authToken);
  return new BrokerHandle(config, launch, authToken);
}

type BrokerLaunch = {
  child: ManagedChild;
  stream: ByteStream;
  cancelEndpoint: string;
  ipcDir?: string;
};

async function launchBroker(
  executable: string | undefined,
  config: NormalizedOpenConfig,
  authToken: string,
): Promise<BrokerLaunch> {
  const failedLaunch: FailedManagedLaunch = {
    paths: [undefined, config.temporaryDirectory ? config.instanceDirectory : undefined],
  };
  try {
    const startupTimeoutMs = brokerStartupTimeoutMs();
    const resolvedExecutable = await resolveBrokerExecutable(executable);
    const endpoint = await allocateBrokerEndpoint(config);
    failedLaunch.paths[0] = endpoint.ipcDir;
    const nativeInstall = await resolveBrokerNativeInstall(config);
    const child = spawnManagedChild({
      executable: resolvedExecutable,
      args: brokerSpawnArgs(config, endpoint),
      env: brokerSpawnEnv(authToken, nativeInstall),
      replaceEnv: true,
    });
    failedLaunch.child = child;
    const readiness = new AbortController();
    const line = await Promise.race([
      readReadyLine(child.stdout, startupTimeoutMs, 'native broker', readiness.signal),
      child.exited().then((code) => {
        throw new Error(`native broker exited before readiness with code ${code ?? 'signal'}`);
      }),
    ]).finally(() => readiness.abort());
    const ready = parseBrokerReadyLine(line);
    const stream = await connectEndpoint(parseReadyEndpoint(ready.primary));
    failedLaunch.stream = stream;
    await authenticateBroker(stream, authToken);
    return {
      child,
      stream,
      cancelEndpoint: ready.cancel,
      ipcDir: endpoint.ipcDir,
    };
  } catch (error) {
    const cleanupFailures = await cleanupFailedManagedLaunch(
      failedLaunch,
      SHUTDOWN_TIMEOUT_MS,
      'native broker startup child',
    );
    throwCollectedCloseFailures(
      [error, ...cleanupFailures],
      'native broker startup and cleanup failed',
    );
    throw error;
  }
}

function brokerStartupTimeoutMs(): number {
  return positiveIntegerEnvMs(OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS_ENV, DEFAULT_STARTUP_TIMEOUT_MS);
}

function positiveIntegerEnvMs(name: string, fallback: number): number {
  const value = envVar(name);
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed.toString() !== value.trim()) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

type BrokerNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
  icuDataDirectory?: string;
  catalogProfile: 'standard' | 'icu';
  moduleDirectory?: string;
};

async function resolveBrokerNativeInstall(config: {
  libraryPath?: string;
  runtimeDirectory?: string;
  extensions?: readonly string[];
}): Promise<BrokerNativeInstall> {
  const extensions = config.extensions ?? [];
  if (runtimeName() === 'deno') {
    if (
      extensions.length > 0 &&
      config.runtimeDirectory === undefined &&
      envVar(LIBOLIPHAUNT_RUNTIME_DIR_ENV) === undefined
    ) {
      throw new Error(
        `Deno broker execution does not automatically materialize extension packages; pass runtimeDirectory with the selected extension assets or use Node/Bun broker execution. Selected extensions: ${extensions.join(', ')}`,
      );
    }
    const assets = await import('../native/assets-deno.js');
    const deno = (globalThis as { Deno?: unknown }).Deno;
    const install = await assets.resolveDenoNativeInstall(config.libraryPath);
    const runtimeDirectory = config.runtimeDirectory ?? install.runtimeDirectory;
    if (
      extensions.length > 0 &&
      (runtimeDirectory === undefined ||
        (install.packageManaged && config.runtimeDirectory === undefined))
    ) {
      throw new Error(
        `Deno broker execution does not automatically materialize extension packages; pass runtimeDirectory with the selected extension assets or use Node/Bun broker execution. Selected extensions: ${extensions.join(', ')}`,
      );
    }
    const validated =
      extensions.length === 0
        ? { runtimeDirectory, moduleDirectory: undefined }
        : await assets.validatePreparedDenoRuntimeExtensions({
            deno: deno as DenoRuntime,
            runtimeDirectory,
            extensions,
            source: 'Deno broker explicit runtimeDirectory',
          });
    const explicitRuntimeDirectory =
      config.runtimeDirectory !== undefined || install.packageManaged === false;
    const profile =
      explicitRuntimeDirectory && validated.runtimeDirectory !== undefined
        ? await resolveExactNativeRuntimeProfile(validated.runtimeDirectory)
        : {
            icuDataDirectory: install.icuDataDirectory,
            catalogProfile: install.catalogProfile ?? ('standard' as const),
          };
    return {
      libraryPath: install.libraryPath,
      runtimeDirectory: validated.runtimeDirectory,
      ...profile,
      moduleDirectory: validated.moduleDirectory,
    };
  }

  const assets = await import('../native/assets-node.js');
  const install = await assets.resolveNodeNativeInstall(config.libraryPath);
  const explicitRuntimeDirectory =
    config.runtimeDirectory !== undefined || install.packageManaged === false;
  const resolved = {
    libraryPath: install.libraryPath,
    runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
    icuDataDirectory: install.icuDataDirectory,
    catalogProfile: install.catalogProfile ?? ('standard' as const),
  };
  const prepared = await assets.prepareNodeExtensionInstall(resolved, extensions, {
    explicitRuntimeDirectory,
  });
  if (!explicitRuntimeDirectory || prepared.runtimeDirectory === undefined) {
    return {
      ...prepared,
      catalogProfile: prepared.catalogProfile ?? 'standard',
    };
  }
  return {
    ...prepared,
    ...(await resolveExactNativeRuntimeProfile(prepared.runtimeDirectory)),
  };
}

function brokerSpawnEnv(
  authToken: string,
  nativeInstall: BrokerNativeInstall,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env[OLIPHAUNT_ICU_DATA_DIR_ENV];
  delete env[ICU_DATA_ENV];
  return {
    ...env,
    OLIPHAUNT_BROKER_AUTH_TOKEN: authToken,
    ...brokerNativeInstallEnv(nativeInstall),
  };
}

function brokerNativeInstallEnv(nativeInstall: BrokerNativeInstall): Record<string, string> {
  const env: Record<string, string> = {
    [LIBOLIPHAUNT_PATH_ENV]: nativeInstall.libraryPath,
  };
  if (nativeInstall.runtimeDirectory !== undefined) {
    env[OLIPHAUNT_INSTALL_DIR_ENV] = nativeInstall.runtimeDirectory;
    env[LIBOLIPHAUNT_RUNTIME_DIR_ENV] = nativeInstall.runtimeDirectory;
    Object.assign(env, nativeRuntimeLibraryEnvironment(nativeInstall.runtimeDirectory, platform()));
  }
  if (nativeInstall.icuDataDirectory !== undefined) {
    env[OLIPHAUNT_ICU_DATA_DIR_ENV] = nativeInstall.icuDataDirectory;
    env[ICU_DATA_ENV] = nativeInstall.icuDataDirectory;
  }
  if (nativeInstall.moduleDirectory !== undefined) {
    env[OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV] = nativeInstall.moduleDirectory;
  }
  return env;
}

async function authenticateBroker(stream: ByteStream, authToken: string): Promise<void> {
  await writeBrokerRequest(stream, { kind: 'authenticate', token: authToken });
  const response = await readBrokerResponse(stream);
  if (response.kind === 'error') {
    throw new Error(`native broker authentication failed: ${response.message}`);
  }
  if (response.kind === 'chunk') {
    throw new Error('native broker authentication returned a stream chunk');
  }
  if (response.kind === 'streamCallbackAborted') {
    throw new Error(
      `native broker authentication returned a stream callback-aborted frame: ${response.message}`,
    );
  }
}

type BrokerStreamCompletionFrame = Exclude<BrokerResponseFrame, { kind: 'chunk' }>;

/** @internal */
export function resolveBrokerStreamCompletion(
  response: BrokerStreamCompletionFrame,
  callbackFailed: boolean,
  callbackError: unknown,
): void {
  switch (response.kind) {
    case 'ok':
      if (callbackFailed) throw callbackError;
      return;
    case 'error':
      // A generic error means the broker did not confirm recovery to
      // ReadyForQuery. That native failure is authoritative even when the
      // client callback also failed earlier in the stream.
      throw new Error(response.message);
    case 'streamCallbackAborted':
      if (callbackFailed) throw callbackError;
      throw new Error(
        `native broker reported a recovered stream callback abort without a stored client callback error: ${response.message}`,
      );
  }
}

type BrokerEndpointPlan =
  | { kind: 'unix'; socket: string; cancelSocket: string; ipcDir: string }
  | { kind: 'tcp'; listen: string; cancelListen: string; ipcDir?: undefined };

async function allocateBrokerEndpoint(config: NormalizedOpenConfig): Promise<BrokerEndpointPlan> {
  const canUseUnix = process.platform !== 'win32';
  if (canUseUnix) {
    const ipcDir = await createTempDir('lpgo-');
    const endpoint = {
      kind: 'unix',
      socket: join(ipcDir, 's'),
      cancelSocket: join(ipcDir, 'c'),
      ipcDir,
    } as const;
    if (unixSocketPathsFit(endpoint.socket, endpoint.cancelSocket)) return endpoint;
    await removeTree(ipcDir);
  }
  return { kind: 'tcp', listen: '127.0.0.1:0', cancelListen: '127.0.0.1:0' };
}

function brokerSpawnArgs(config: NormalizedOpenConfig, endpoint: BrokerEndpointPlan): string[] {
  const args = [
    '--root',
    config.instanceDirectory,
    '--username',
    config.username,
    '--database',
    config.database,
  ];
  if (endpoint.kind === 'unix') {
    args.push('--socket', endpoint.socket, '--cancel-socket', endpoint.cancelSocket);
  } else {
    args.push('--listen', endpoint.listen, '--cancel-listen', endpoint.cancelListen);
  }
  for (const extension of config.extensions) {
    args.push('--extension', extension);
  }
  for (const assignment of startupAssignments(config.startupArgs)) {
    args.push('--startup-guc', assignment);
  }
  return args;
}

function parseBrokerReadyLine(line: string): {
  primary: string;
  cancel: string;
} {
  if (line.startsWith(ERROR_PREFIX)) {
    throw new Error(`native broker failed to start: ${line.slice(ERROR_PREFIX.length)}`);
  }
  if (!line.startsWith(READY_PREFIX)) {
    throw new Error(`native broker did not print a ready line: ${line}`);
  }
  const parts = line.slice(READY_PREFIX.length).trim().split(/\s+/);
  const primary = parts[0];
  const cancel = parts[1]?.startsWith('cancel=') ? parts[1].slice('cancel='.length) : undefined;
  if (primary === undefined || cancel === undefined) {
    throw new Error('native broker ready line did not include primary and cancel endpoints');
  }
  return { primary, cancel };
}

async function resolveBrokerExecutable(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return requireExecutableFile(explicit, 'brokerExecutable');
  }

  const configured = envVar(OLIPHAUNT_BROKER_ENV);
  if (configured !== undefined && configured.trim().length > 0) {
    if (configured.includes('\0')) {
      throw new Error(`${OLIPHAUNT_BROKER_ENV} must not contain NUL bytes`);
    }
    return requireExecutableFile(configured, OLIPHAUNT_BROKER_ENV);
  }

  for (const candidate of packageAdjacentExecutables('oliphaunt-broker')) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  const version = await packageBrokerVersion();
  const target = brokerPackageTarget(platform(), arch());
  const installed = await packageBrokerExecutable(target, version);
  if (installed !== undefined) {
    return installed;
  }
  throw new Error(
    `${target.packageName} ${version} is not installed; reinstall @oliphaunt/ts with optional dependencies enabled`,
  );
}

async function requireExecutableFile(path: string, source: string): Promise<string> {
  if (!(await isFile(path))) {
    throw new Error(`${source} does not point to an existing file: ${path}`);
  }
  return path;
}

function packageAdjacentExecutables(base: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, base),
    join(here, `${base}.exe`),
    join(here, '..', base),
    join(here, '..', `${base}.exe`),
    resolve(process.cwd(), base),
    resolve(process.cwd(), `${base}.exe`),
  ];
}

type BrokerPackageTarget = {
  id: string;
  packageName: string;
  executableRelativePath: string;
};

async function packageBrokerVersion(): Promise<string> {
  type PackageMetadata = {
    name?: string;
    version?: string;
    oliphaunt?: { brokerVersion?: string };
  };
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata;
  const version = packageJson.oliphaunt?.brokerVersion;
  if (packageJson.name !== '@oliphaunt/ts' || version === undefined || version.length === 0) {
    throw new Error('@oliphaunt/ts package metadata does not pin brokerVersion');
  }
  return version;
}

function brokerPackageTarget(currentPlatform: string, currentArch: string): BrokerPackageTarget {
  const normalizedPlatform = normalizeBrokerPlatform(currentPlatform);
  const normalizedArch = normalizeBrokerArchitecture(currentArch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      packageName: '@oliphaunt/broker-darwin-arm64',
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      packageName: '@oliphaunt/broker-linux-x64-gnu',
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      packageName: '@oliphaunt/broker-linux-arm64-gnu',
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      packageName: '@oliphaunt/broker-win32-x64-msvc',
      executableRelativePath: 'bin/oliphaunt-broker.exe',
    };
  }
  throw new Error(
    `no oliphaunt-broker package is defined for ${currentPlatform}/${currentArch}; pass brokerExecutable explicitly for this platform`,
  );
}

async function packageBrokerExecutable(
  target: BrokerPackageTarget,
  expectedVersion: string,
): Promise<string | undefined> {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    return undefined;
  }
  type BrokerPackageMetadata = {
    name?: string;
    version?: string;
    oliphaunt?: {
      brokerHelper?: string;
      target?: string;
      executableRelativePath?: string;
    };
  };
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as BrokerPackageMetadata;
  if (packageJson.name !== target.packageName) {
    throw new Error(
      `${target.packageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${target.packageName} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts brokerVersion ${expectedVersion}`,
    );
  }
  if (packageJson.oliphaunt?.brokerHelper !== 'oliphaunt-broker') {
    throw new Error(`${target.packageName} package metadata does not declare oliphaunt-broker`);
  }
  if (packageJson.oliphaunt?.target !== target.id) {
    throw new Error(`${target.packageName} package metadata does not target ${target.id}`);
  }
  const executable = join(
    dirname(packageJsonPath),
    packageJson.oliphaunt.executableRelativePath ?? target.executableRelativePath,
  );
  return requireExecutableFile(executable, `${target.packageName} broker helper`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function startupAssignments(startupArgs: string[]): string[] {
  const assignments: string[] = [];
  for (let i = 0; i < startupArgs.length; i += 2) {
    const assignment = startupArgs[i + 1];
    if (startupArgs[i] === '-c' && assignment !== undefined) {
      assignments.push(assignment);
    }
  }
  return assignments;
}

function asBrokerHandle(handle: RuntimeHandle): BrokerHandle {
  if (handle instanceof BrokerHandle) {
    return handle;
  }
  throw new Error('invalid native broker handle');
}

function runtimeName(): 'node' | 'bun' | 'deno' {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') {
    return 'deno';
  }
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return 'bun';
  }
  return 'node';
}

function normalizeBrokerPlatform(value: string): string {
  switch (value) {
    case 'darwin':
    case 'macos':
      return 'darwin';
    case 'win32':
    case 'windows':
      return 'windows';
    default:
      return value;
  }
}

function normalizeBrokerArchitecture(value: string): string {
  switch (value) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x64':
    case 'x86_64':
      return 'x64';
    default:
      return value;
  }
}
