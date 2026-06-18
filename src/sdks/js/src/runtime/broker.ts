import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import type { NormalizedOpenConfig } from '../config.js';
import type { BackupFormat, EngineCapabilities, EngineModeSupport } from '../types.js';
import {
  assertSha256Matches,
  envVar,
  LIBOLIPHAUNT_CACHE_DIR_ENV,
  LIBOLIPHAUNT_RUNTIME_DIR_ENV,
  parseReleaseChecksumManifest,
  checksumForReleaseAsset,
} from '../native/common.js';
import { extractTarArchive } from '../native/tar.js';
import { extractZipArchive } from '../native/zip.js';
import {
  readBrokerResponse,
  writeBrokerRequest,
  type BrokerResponseFrame,
} from './broker-frames.js';
import type { ByteStream } from './byte-stream.js';
import {
  canonicalPath,
  connectEndpoint,
  createTempDir,
  parseReadyEndpoint,
  randomHexToken,
  readReadyLine,
  removeTree,
  spawnManagedChild,
  type ManagedChild,
} from './node-adapter.js';
import type { RuntimeBinding, RuntimeHandle } from './types.js';

const READY_PREFIX = 'OLIPHAUNT_BROKER_READY ';
const ERROR_PREFIX = 'OLIPHAUNT_BROKER_ERROR ';
const LIBOLIPHAUNT_PATH_ENV = 'LIBOLIPHAUNT_PATH';
const OLIPHAUNT_INSTALL_DIR_ENV = 'OLIPHAUNT_INSTALL_DIR';
const OLIPHAUNT_BROKER_ENV = 'OLIPHAUNT_BROKER';
const OLIPHAUNT_BROKER_RELEASE_ASSET_DIR_ENV = 'OLIPHAUNT_BROKER_ASSET_DIR';
const OLIPHAUNT_BROKER_RELEASE_BASE_URL_ENV = 'OLIPHAUNT_BROKER_RELEASE_BASE_URL';
const OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS_ENV = 'OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS';
const OLIPHAUNT_BROKER_RELEASE_TAG_PREFIX = 'oliphaunt-broker-v';
const OLIPHAUNT_RELEASE_REPOSITORY = 'f0rr0/oliphaunt';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_MS = 120_000;

export type BrokerRuntimeBindingOptions = {
  executable?: string;
  maxRoots?: number;
};

export type BrokerRestoreOptions = {
  root: string;
  bytes: Uint8Array;
  replaceExisting?: boolean;
  brokerExecutable?: string;
};

export function createBrokerRuntimeBinding(
  options: BrokerRuntimeBindingOptions = {},
): RuntimeBinding {
  const supervisor = new BrokerRootSupervisor(options.maxRoots ?? 1);
  return {
    runtime: runtimeName(),
    rawProtocolTransport: 'broker-ipc',
    protocolStream: true,
    capabilities(handle: RuntimeHandle): EngineCapabilities {
      return brokerCapabilities(asBrokerHandle(handle).maxRoots);
    },
    async open(config: NormalizedOpenConfig): Promise<BrokerHandle> {
      const executable = await resolveBrokerExecutable(
        config.brokerExecutable ?? options.executable,
      );
      const rootLease = await supervisor.acquire(config.root);
      let handle: BrokerHandle | undefined;
      try {
        handle = new BrokerHandle(executable, config, rootLease, supervisor.maxRoots);
        await handle.start();
        return handle;
      } catch (error) {
        await handle?.detach();
        rootLease.release();
        throw error;
      }
    },
    execProtocolRaw(handle: RuntimeHandle, request: Uint8Array): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({ kind: 'execProtocol', bytes: request });
    },
    execSimpleQuery(handle: RuntimeHandle, sql: string): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({ kind: 'execSimpleQuery', sql });
    },
    execProtocolStream(
      handle: RuntimeHandle,
      request: Uint8Array,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> {
      return asBrokerHandle(handle).requestStream(request, onChunk);
    },
    backup(handle: RuntimeHandle, format: BackupFormat): Promise<Uint8Array> {
      return asBrokerHandle(handle).requestOk({ kind: 'backup', format });
    },
    cancel(handle: RuntimeHandle): Promise<void> {
      return asBrokerHandle(handle).cancel();
    },
    detach(handle: RuntimeHandle): Promise<void> {
      return asBrokerHandle(handle).detach();
    },
  };
}

export async function brokerModeSupport(options: {
  libraryPath?: string;
  runtimeDirectory?: string;
  brokerExecutable?: string;
  brokerMaxRoots?: number;
}): Promise<EngineModeSupport> {
  const capabilities = brokerCapabilities(options.brokerMaxRoots ?? 1);
  try {
    await resolveBrokerExecutable(options.brokerExecutable);
    await resolveBrokerNativeInstall({
      libraryPath: options.libraryPath,
      runtimeDirectory: options.runtimeDirectory,
    });
    return { engine: 'nativeBroker', available: true, capabilities };
  } catch (error) {
    return {
      engine: 'nativeBroker',
      available: false,
      capabilities,
      unavailableReason: `native broker helper is unavailable: ${errorString(error)}`,
    };
  }
}

export async function restorePhysicalArchiveWithBroker(
  options: BrokerRestoreOptions,
): Promise<string> {
  const executable = await resolveBrokerExecutable(options.brokerExecutable);
  const tempDir = await createTempDir('lpgr-');
  const artifactPath = join(tempDir, 'physical-archive.tar');
  try {
    await writeFile(artifactPath, options.bytes);
    const args = ['restore', '--root', options.root, '--artifact', artifactPath];
    if (options.replaceExisting === true) {
      args.push('--replace-existing');
    }
    await runBrokerTool(executable, args, RESTORE_TIMEOUT_MS, 'native broker restore');
    return options.root;
  } finally {
    await removeTree(tempDir);
  }
}

export function brokerCapabilities(maxRoots: number): EngineCapabilities {
  return {
    engine: 'nativeBroker',
    processIsolated: true,
    multiRoot: maxRoots > 1,
    reopenable: true,
    sameRootLogicalReopen: false,
    rootSwitchable: true,
    crashRestartable: true,
    independentSessions: false,
    maxClientSessions: 1,
    protocolRaw: true,
    protocolStream: true,
    queryCancel: true,
    backupRestore: true,
    backupFormats: ['physicalArchive'],
    restoreFormats: ['physicalArchive'],
    simpleQuery: true,
    extensions: true,
    rawProtocolTransport: 'broker-ipc',
  };
}

class BrokerHandle {
  #child: ManagedChild | undefined;
  #stream: ByteStream | undefined;
  #cancelEndpoint: string | undefined;
  #ipcDir: string | undefined;
  #authToken: string | undefined;
  #closed = false;

  constructor(
    readonly executable: string,
    readonly config: NormalizedOpenConfig,
    readonly rootLease: BrokerRootLease,
    readonly maxRoots: number,
  ) {}

  async start(): Promise<void> {
    if (this.#closed) {
      throw new Error('native broker session is closed');
    }
    const authToken = randomHexToken();
    const launch = await launchBroker(this.executable, this.config, authToken);
    this.#child = launch.child;
    this.#stream = launch.stream;
    this.#cancelEndpoint = launch.cancelEndpoint;
    this.#ipcDir = launch.ipcDir;
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
        throw new Error('broker returned a stream chunk for raw request execution');
    }
  }

  async requestStream(request: Uint8Array, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    const stream = await this.ensureStream();
    try {
      await writeBrokerRequest(stream, { kind: 'execProtocolStream', bytes: request });
      for (;;) {
        const response = await readBrokerResponse(stream);
        switch (response.kind) {
          case 'chunk':
            onChunk(response.bytes);
            break;
          case 'ok':
            return;
          case 'error':
            throw new Error(response.message);
        }
      }
    } catch (error) {
      await this.markFailed();
      throw error;
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
    try {
      await authenticateBroker(stream, authToken);
      await writeBrokerRequest(stream, { kind: 'cancel' });
      const response = await readBrokerResponse(stream);
      if (response.kind === 'error') {
        throw new Error(`native broker cancel failed: ${response.message}`);
      }
      if (response.kind === 'chunk') {
        throw new Error('broker returned a stream chunk for cancellation');
      }
    } finally {
      await stream.close();
    }
  }

  async detach(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const stream = this.#stream;
    if (stream !== undefined) {
      try {
        await writeBrokerRequest(stream, { kind: 'close' });
        await readBrokerResponse(stream);
      } catch {}
      await stream.close();
    }
    this.#stream = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) {
      const exited = await waitForChild(child, SHUTDOWN_TIMEOUT_MS);
      if (!exited) {
        child.kill('SIGKILL');
        await child.wait();
      }
    }
    await removeTree(this.#ipcDir);
    this.#ipcDir = undefined;
    if (this.config.temporary) {
      await removeTree(this.config.root);
    }
    this.rootLease.release();
  }

  async request(frame: Parameters<typeof writeBrokerRequest>[1]): Promise<BrokerResponseFrame> {
    const stream = await this.ensureStream();
    try {
      await writeBrokerRequest(stream, frame);
      return await readBrokerResponse(stream);
    } catch (error) {
      await this.markFailed();
      throw error;
    }
  }

  async ensureStream(): Promise<ByteStream> {
    if (this.#closed) {
      throw new Error('native broker session is closed');
    }
    if (this.#stream === undefined) {
      await this.start();
    }
    if (this.#stream === undefined) {
      throw new Error('native broker stream is unavailable');
    }
    return this.#stream;
  }

  async markFailed(): Promise<void> {
    await this.#stream?.close();
    this.#stream = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) {
      child.kill('SIGKILL');
      await child.wait();
    }
    await removeTree(this.#ipcDir);
    this.#ipcDir = undefined;
  }
}

async function launchBroker(
  executable: string,
  config: NormalizedOpenConfig,
  authToken: string,
): Promise<{
  child: ManagedChild;
  stream: ByteStream;
  cancelEndpoint: string;
  ipcDir?: string;
}> {
  const startupTimeoutMs = brokerStartupTimeoutMs();
  const endpoint = await allocateBrokerEndpoint(config);
  const nativeInstall = await resolveBrokerNativeInstall(config);
  const child = spawnManagedChild({
    executable,
    args: brokerSpawnArgs(config, endpoint),
    env: brokerSpawnEnv(authToken, nativeInstall),
  });
  try {
    const line = await Promise.race([
      readReadyLine(child.stdout, startupTimeoutMs, 'native broker'),
      child.exited().then((code) => {
        throw new Error(`native broker exited before readiness with code ${code ?? 'signal'}`);
      }),
    ]);
    const ready = parseBrokerReadyLine(line);
    const stream = await connectEndpoint(parseReadyEndpoint(ready.primary));
    await authenticateBroker(stream, authToken);
    return { child, stream, cancelEndpoint: ready.cancel, ipcDir: endpoint.ipcDir };
  } catch (error) {
    child.kill('SIGKILL');
    await child.wait();
    await removeTree(endpoint.ipcDir);
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
};

async function resolveBrokerNativeInstall(config: {
  libraryPath?: string;
  runtimeDirectory?: string;
}): Promise<BrokerNativeInstall> {
  const install =
    runtimeName() === 'deno'
      ? await import('../native/assets-deno.js').then((module) =>
          module.resolveDenoNativeInstall(config.libraryPath),
        )
      : await import('../native/assets-node.js').then((module) =>
          module.resolveNodeNativeInstall(config.libraryPath),
        );
  return {
    libraryPath: install.libraryPath,
    runtimeDirectory: config.runtimeDirectory ?? install.runtimeDirectory,
  };
}

function brokerSpawnEnv(
  authToken: string,
  nativeInstall: BrokerNativeInstall,
): Record<string, string> {
  const env: Record<string, string> = {
    OLIPHAUNT_BROKER_AUTH_TOKEN: authToken,
    [LIBOLIPHAUNT_PATH_ENV]: nativeInstall.libraryPath,
  };
  if (nativeInstall.runtimeDirectory !== undefined) {
    env[OLIPHAUNT_INSTALL_DIR_ENV] = nativeInstall.runtimeDirectory;
    env[LIBOLIPHAUNT_RUNTIME_DIR_ENV] = nativeInstall.runtimeDirectory;
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
    throw new Error('broker returned a stream chunk during authentication');
  }
}

type BrokerEndpointPlan =
  | { kind: 'unix'; socket: string; cancelSocket: string; ipcDir: string }
  | { kind: 'tcp'; listen: string; cancelListen: string; ipcDir?: undefined };

async function allocateBrokerEndpoint(config: NormalizedOpenConfig): Promise<BrokerEndpointPlan> {
  const canUseUnix = process.platform !== 'win32';
  if (config.brokerTransport === 'unix' && !canUseUnix) {
    throw new Error('native broker Unix sockets are not supported on this platform');
  }
  if (config.brokerTransport !== 'tcp' && canUseUnix) {
    const ipcDir = await createTempDir('lpgo-');
    return {
      kind: 'unix',
      socket: join(ipcDir, 's'),
      cancelSocket: join(ipcDir, 'c'),
      ipcDir,
    };
  }
  return { kind: 'tcp', listen: '127.0.0.1:0', cancelListen: '127.0.0.1:0' };
}

function brokerSpawnArgs(config: NormalizedOpenConfig, endpoint: BrokerEndpointPlan): string[] {
  const args = [
    '--root',
    config.root,
    '--bootstrap',
    'packaged-template',
    '--durability',
    durabilityArg(config.durability),
    '--runtime-footprint',
    runtimeFootprintArg(config.runtimeFootprint),
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

function parseBrokerReadyLine(line: string): { primary: string; cancel: string } {
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
  return resolveBrokerHelperInstall();
}

async function runBrokerTool(
  executable: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${label} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(error?: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => pushBounded(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => pushBounded(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const output = [boundedText(stderr), boundedText(stdout)]
        .filter((value) => value.length > 0)
        .join('\n');
      finish(
        new Error(
          `${label} failed with ${signal ?? `exit code ${code ?? 'unknown'}`}${
            output.length > 0 ? `: ${output}` : ''
          }`,
        ),
      );
    });
  });
}

function pushBounded(chunks: Buffer[], chunk: Buffer): void {
  const maxBytes = 64 * 1024;
  const total = chunks.reduce((sum, current) => sum + current.byteLength, 0);
  if (total >= maxBytes) {
    return;
  }
  const remaining = maxBytes - total;
  chunks.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
}

function boundedText(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8').trim();
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

type BrokerReleaseTarget = {
  id: string;
  assetName: string;
  executableRelativePath: string;
};

type BrokerInstallMarker = {
  version: string;
  asset: string;
  checksum: string;
};

async function resolveBrokerHelperInstall(): Promise<string> {
  const version = await packageBrokerVersion();
  const target = brokerReleaseTarget(version, platform(), arch());
  const installRoot = join(cacheRoot(), 'oliphaunt-broker', version, target.id);
  const executable = join(installRoot, target.executableRelativePath);
  const lockPath = `${installRoot}.lock`;
  const release = await acquireInstallLock(lockPath, 'oliphaunt-broker');
  try {
    if (await validateExistingBrokerInstall(executable, version, target.assetName)) {
      return executable;
    }
    const checksums = parseReleaseChecksumManifest(
      new TextDecoder().decode(
        await readBrokerReleaseAssetBytes(version, brokerChecksumAssetName(version)),
      ),
    );
    const expectedChecksum = checksumForReleaseAsset(checksums, target.assetName);
    const archive = await readBrokerReleaseAssetBytes(version, target.assetName);
    assertSha256Matches(target.assetName, expectedChecksum, sha256Hex(archive));
    await installBrokerArchive(target.assetName, archive, installRoot, {
      version,
      asset: target.assetName,
      checksum: expectedChecksum,
    });
    return executable;
  } finally {
    await release();
  }
}

async function packageBrokerVersion(): Promise<string> {
  type PackageMetadata = {
    name?: string;
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

export function brokerReleaseTarget(
  version: string,
  currentPlatform: string,
  currentArch: string,
): BrokerReleaseTarget {
  validateBrokerReleaseVersion(version);
  const normalizedPlatform = normalizeBrokerPlatform(currentPlatform);
  const normalizedArch = normalizeBrokerArchitecture(currentArch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      assetName: `oliphaunt-broker-${version}-macos-arm64.tar.gz`,
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      assetName: `oliphaunt-broker-${version}-linux-x64-gnu.tar.gz`,
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      assetName: `oliphaunt-broker-${version}-linux-arm64-gnu.tar.gz`,
      executableRelativePath: 'bin/oliphaunt-broker',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      assetName: `oliphaunt-broker-${version}-windows-x64-msvc.zip`,
      executableRelativePath: 'bin/oliphaunt-broker.exe',
    };
  }
  throw new Error(
    `no oliphaunt-broker ${version} release asset is defined for ${currentPlatform}/${currentArch}; pass brokerExecutable explicitly for this platform`,
  );
}

export function oliphauntBrokerReleaseAssetUrl(version: string, assetName: string): string {
  validateBrokerReleaseVersion(version);
  validateBrokerAssetName(assetName);
  const override = envVar(OLIPHAUNT_BROKER_RELEASE_BASE_URL_ENV);
  const base =
    override !== undefined && override.trim().length > 0
      ? override.replace(/\/+$/, '')
      : `https://github.com/${OLIPHAUNT_RELEASE_REPOSITORY}/releases/download/${OLIPHAUNT_BROKER_RELEASE_TAG_PREFIX}${version}`;
  return `${base}/${assetName}`;
}

function brokerChecksumAssetName(version: string): string {
  validateBrokerReleaseVersion(version);
  return `oliphaunt-broker-${version}-release-assets.sha256`;
}

async function validateExistingBrokerInstall(
  executable: string,
  version: string,
  assetName: string,
): Promise<boolean> {
  const markerPath = join(dirname(dirname(executable)), '.oliphaunt-broker-install.json');
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as BrokerInstallMarker;
    const executableStat = await stat(executable);
    return (
      marker.version === version &&
      marker.asset === assetName &&
      marker.checksum.length === 64 &&
      executableStat.isFile()
    );
  } catch {
    return false;
  }
}

async function readBrokerReleaseAssetBytes(
  version: string,
  assetName: string,
): Promise<Uint8Array> {
  const localAssetDir = envVar(OLIPHAUNT_BROKER_RELEASE_ASSET_DIR_ENV);
  if (localAssetDir !== undefined && localAssetDir.trim().length > 0) {
    return Uint8Array.from(await readFile(join(localAssetDir, assetName)));
  }
  const url = oliphauntBrokerReleaseAssetUrl(version, assetName);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download ${url} failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function installBrokerArchive(
  assetName: string,
  archive: Uint8Array,
  installRoot: string,
  marker: BrokerInstallMarker,
): Promise<void> {
  const parent = dirname(installRoot);
  const scratch = join(
    parent,
    `.tmp-broker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    const host = {
      join,
      dirname,
      async mkdir(path: string) {
        await mkdir(path, { recursive: true });
      },
      async writeFile(file: { path: string; bytes: Uint8Array; mode: number }) {
        await writeFile(file.path, file.bytes, { mode: file.mode });
        await chmod(file.path, file.mode);
      },
    };
    if (assetName.endsWith('.zip')) {
      await extractZipArchive(archive, scratch, host, (compressed) =>
        Uint8Array.from(inflateRawSync(compressed)),
      );
    } else {
      await extractTarArchive(Uint8Array.from(gunzipSync(archive)), scratch, host);
    }
    await writeFile(
      join(scratch, '.oliphaunt-broker-install.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
      'utf8',
    );
    await rm(installRoot, { recursive: true, force: true });
    await rename(scratch, installRoot);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
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

function durabilityArg(value: NormalizedOpenConfig['durability']): string {
  return value === 'fastDev' ? 'fast-dev' : value;
}

function runtimeFootprintArg(value: NormalizedOpenConfig['runtimeFootprint']): string {
  switch (value) {
    case 'throughput':
      return 'throughput';
    case 'balancedMobile':
      return 'balanced-mobile';
    case 'smallMobile':
      return 'small-mobile';
  }
}

async function waitForChild(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<false>((resolveTimeout) => {
    setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  const result = await Promise.race([child.wait().then(() => true), timeout]);
  return result;
}

class BrokerRootSupervisor {
  readonly #roots = new Set<string>();

  constructor(readonly maxRoots: number) {}

  async acquire(root: string): Promise<BrokerRootLease> {
    if (this.maxRoots <= 0) {
      throw new Error('native broker max_roots must be greater than zero');
    }
    await mkdir(root, { recursive: true });
    const key = await canonicalPath(root);
    if (this.#roots.has(key)) {
      throw new Error(`native broker root ${key} is already open in this broker runtime`);
    }
    if (this.#roots.size >= this.maxRoots) {
      throw new Error(
        `native broker runtime already owns ${this.#roots.size} root(s), at configured capacity ${this.maxRoots}`,
      );
    }
    this.#roots.add(key);
    return new BrokerRootLease(this, key);
  }

  release(key: string): void {
    this.#roots.delete(key);
  }
}

class BrokerRootLease {
  #released = false;

  constructor(
    readonly supervisor: BrokerRootSupervisor,
    readonly key: string,
  ) {}

  release(): void {
    if (!this.#released) {
      this.#released = true;
      this.supervisor.release(this.key);
    }
  }
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

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cacheRoot(): string {
  const override = envVar(LIBOLIPHAUNT_CACHE_DIR_ENV);
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'oliphaunt');
  }
  const xdgCache = envVar('XDG_CACHE_HOME');
  if (xdgCache !== undefined && xdgCache.trim().length > 0) {
    return join(xdgCache, 'oliphaunt');
  }
  return join(homedir() || tmpdir(), '.cache', 'oliphaunt');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function acquireInstallLock(path: string, description: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx' });
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if (isFileExistsError(error)) {
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`timed out waiting for ${description} install lock ${path}`);
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function validateBrokerReleaseVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`invalid oliphaunt-broker release version '${version}'`);
  }
}

function validateBrokerAssetName(assetName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(assetName) || assetName.includes('..')) {
    throw new Error(`invalid oliphaunt-broker release asset name '${assetName}'`);
  }
}
