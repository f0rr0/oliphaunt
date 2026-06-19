import {
  assertSha256Matches,
  checksumForReleaseAsset,
  envVar,
  LIBOLIPHAUNT_CACHE_DIR_ENV,
  LIBOLIPHAUNT_RELEASE_ASSET_DIR_ENV,
  liboliphauntChecksumAssetName,
  liboliphauntReleaseAssetUrl,
  liboliphauntReleaseTarget,
  parseReleaseChecksumManifest,
  resolveExplicitLibraryPath,
  resolveExplicitRuntimeDirectory,
} from './common.js';
import { extractTarArchive } from './tar.js';
import { extractZipArchive } from './zip.js';

export type ResolvedDenoNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
};

type DenoRuntime = {
  build: { os: string; arch: string };
  env: { get(name: string): string | undefined };
  cwd(): string;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
  writeTextFile(path: string, text: string, options?: { createNew?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<unknown>;
};

type PackageMetadata = {
  name: string;
  oliphaunt?: {
    liboliphauntVersion?: string;
  };
};

type InstallMarker = {
  version: string;
  asset: string;
  checksum: string;
};

export async function resolveDenoNativeInstall(
  libraryPath?: string,
): Promise<ResolvedDenoNativeInstall> {
  const explicit = resolveExplicitLibraryPath(libraryPath);
  if (explicit !== undefined) {
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
    };
  }

  const deno = denoRuntime();
  const version = await packageLiboliphauntVersion(deno);
  const target = liboliphauntReleaseTarget(version, deno.build.os, deno.build.arch);
  const installRoot = joinPath(cacheRoot(deno), 'liboliphaunt', version, target.id);
  const install = {
    libraryPath: joinPath(installRoot, target.libraryRelativePath),
    runtimeDirectory: joinPath(installRoot, target.runtimeRelativePath),
  };
  const release = await acquireInstallLock(deno, `${installRoot}.lock`);
  try {
    const current = await validateExistingInstall(deno, install, version, target.assetName);
    if (current !== undefined) {
      return current;
    }
    const checksumBytes = await readReleaseAssetBytes(
      deno,
      version,
      liboliphauntChecksumAssetName(version),
    );
    const checksums = parseReleaseChecksumManifest(new TextDecoder().decode(checksumBytes));
    const expectedChecksum = checksumForReleaseAsset(checksums, target.assetName);
    const archive = await readReleaseAssetBytes(deno, version, target.assetName);
    assertSha256Matches(target.assetName, expectedChecksum, await sha256Hex(archive));
    await installArchive(deno, target.assetName, archive, installRoot, {
      version,
      asset: target.assetName,
      checksum: expectedChecksum,
    });
    return install;
  } finally {
    await release();
  }
}

async function packageLiboliphauntVersion(deno: DenoRuntime): Promise<string> {
  const packageUrl = new URL('../../package.json', import.meta.url);
  const packageJson = JSON.parse(await deno.readTextFile(packageUrl.pathname)) as PackageMetadata;
  const version = packageJson.oliphaunt?.liboliphauntVersion;
  if (packageJson.name !== '@oliphaunt/ts' || version === undefined || version.length === 0) {
    throw new Error('@oliphaunt/ts package metadata does not pin liboliphauntVersion');
  }
  return version;
}

async function validateExistingInstall(
  deno: DenoRuntime,
  install: ResolvedDenoNativeInstall,
  version: string,
  asset: string,
): Promise<ResolvedDenoNativeInstall | undefined> {
  const markerPath = joinPath(
    dirnamePath(dirnamePath(install.libraryPath)),
    '.oliphaunt-native-install.json',
  );
  try {
    const marker = JSON.parse(await deno.readTextFile(markerPath)) as InstallMarker;
    await deno.stat(install.libraryPath);
    if (install.runtimeDirectory !== undefined) {
      await deno.stat(install.runtimeDirectory);
    }
    if (marker.version === version && marker.asset === asset && marker.checksum.length === 64) {
      return install;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readReleaseAssetBytes(
  deno: DenoRuntime,
  version: string,
  asset: string,
): Promise<Uint8Array> {
  const localAssetDir = envVar(LIBOLIPHAUNT_RELEASE_ASSET_DIR_ENV);
  if (localAssetDir !== undefined && localAssetDir.trim().length > 0) {
    return deno.readFile(joinPath(localAssetDir, asset));
  }
  const url = liboliphauntReleaseAssetUrl(version, asset);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download ${url} failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function installArchive(
  deno: DenoRuntime,
  assetName: string,
  archive: Uint8Array,
  installRoot: string,
  marker: InstallMarker,
): Promise<void> {
  const parent = dirnamePath(installRoot);
  const scratch = joinPath(parent, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await removeIfExists(deno, scratch);
  await deno.mkdir(scratch, { recursive: true });
  try {
    const host = {
      join: joinPath,
      dirname: dirnamePath,
      mkdir(path: string) {
        return deno.mkdir(path, { recursive: true });
      },
      async writeFile(file: { path: string; bytes: Uint8Array; mode: number }) {
        await deno.writeFile(file.path, file.bytes, { mode: file.mode });
        await deno.chmod(file.path, file.mode);
      },
    };
    if (assetName.endsWith('.zip')) {
      await extractZipArchive(archive, scratch, host, inflateRaw);
    } else {
      await extractTarArchive(await gunzip(archive), scratch, host);
    }
    await deno.writeTextFile(
      joinPath(scratch, '.oliphaunt-native-install.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    await removeIfExists(deno, installRoot);
    await deno.rename(scratch, installRoot);
  } catch (error) {
    await removeIfExists(deno, scratch);
    throw error;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(
    bytes,
    'gzip',
    'Deno runtime does not expose DecompressionStream for gzip assets',
  );
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(
    bytes,
    'deflate-raw',
    'Deno runtime does not expose DecompressionStream for deflated ZIP assets',
  );
}

async function decompress(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
  message: string,
): Promise<Uint8Array> {
  type DecompressionStreamConstructor = new (
    format: 'gzip' | 'deflate-raw',
  ) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  const DecompressionStreamCtor = (
    globalThis as {
      DecompressionStream?: DecompressionStreamConstructor;
    }
  ).DecompressionStream;
  if (DecompressionStreamCtor === undefined) {
    throw new Error(message);
  }
  const decompression = new DecompressionStreamCtor(format);
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(decompression);
  return new Uint8Array(await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer());
}

function cacheRoot(deno: DenoRuntime): string {
  const override = envVar(LIBOLIPHAUNT_CACHE_DIR_ENV);
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  const home = deno.env.get('HOME');
  if (deno.build.os === 'darwin' && home !== undefined && home.length > 0) {
    return joinPath(home, 'Library', 'Caches', 'oliphaunt');
  }
  const xdgCache = deno.env.get('XDG_CACHE_HOME');
  if (xdgCache !== undefined && xdgCache.length > 0) {
    return joinPath(xdgCache, 'oliphaunt');
  }
  if (home !== undefined && home.length > 0) {
    return joinPath(home, '.cache', 'oliphaunt');
  }
  return joinPath(deno.cwd(), '.oliphaunt-cache');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function acquireInstallLock(deno: DenoRuntime, path: string): Promise<() => Promise<void>> {
  await deno.mkdir(dirnamePath(path), { recursive: true });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await deno.writeTextFile(path, `${Date.now()}\n`, { createNew: true });
      return async () => {
        await removeIfExists(deno, path);
      };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`timed out waiting for liboliphaunt install lock ${path}`);
}

async function removeIfExists(deno: DenoRuntime, path: string): Promise<void> {
  try {
    await deno.remove(path, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function denoRuntime(): DenoRuntime {
  const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
  if (deno === undefined) {
    throw new Error('Deno native binding can only be used inside Deno');
  }
  return deno;
}

function joinPath(...parts: string[]): string {
  const absolute = parts[0]?.startsWith('/') ?? false;
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  return absolute ? `/${joined}` : joined;
}

function dirnamePath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return index === 0 ? '/' : '.';
  }
  return normalized.slice(0, index);
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AlreadyExists';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFound';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
