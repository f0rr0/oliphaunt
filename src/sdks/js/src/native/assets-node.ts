import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import {
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
  assertSha256Matches,
} from './common.js';
import { extractTarArchive } from './tar.js';
import { extractZipArchive } from './zip.js';

export type ResolvedNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
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

const require = createRequire(import.meta.url);

export async function resolveNodeNativeInstall(
  libraryPath?: string,
): Promise<ResolvedNativeInstall> {
  const explicit = resolveExplicitLibraryPath(libraryPath);
  if (explicit !== undefined) {
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
    };
  }

  const version = await packageLiboliphauntVersion();
  const target = liboliphauntReleaseTarget(version, platform(), arch());
  const installRoot = join(cacheRoot(), 'liboliphaunt', version, target.id);
  const install = {
    libraryPath: join(installRoot, target.libraryRelativePath),
    runtimeDirectory: join(installRoot, target.runtimeRelativePath),
  };
  const lockPath = `${installRoot}.lock`;
  const release = await acquireInstallLock(lockPath);
  try {
    const current = await validateExistingInstall(install, version, target.assetName);
    if (current !== undefined) {
      return current;
    }
    const checksums = parseReleaseChecksumManifest(
      new TextDecoder().decode(
        await readReleaseAssetBytes(version, liboliphauntChecksumAssetName(version)),
      ),
    );
    const expectedChecksum = checksumForReleaseAsset(checksums, target.assetName);
    const archive = await readReleaseAssetBytes(version, target.assetName);
    assertSha256Matches(target.assetName, expectedChecksum, sha256Hex(archive));
    await installArchive(target.assetName, archive, installRoot, {
      version,
      asset: target.assetName,
      checksum: expectedChecksum,
    });
    return install;
  } finally {
    await release();
  }
}

async function packageLiboliphauntVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(require.resolve('@oliphaunt/ts/package.json'), 'utf8'),
  ) as PackageMetadata;
  const version = packageJson.oliphaunt?.liboliphauntVersion;
  if (packageJson.name !== '@oliphaunt/ts' || version === undefined || version.length === 0) {
    throw new Error('@oliphaunt/ts package metadata does not pin liboliphauntVersion');
  }
  return version;
}

async function validateExistingInstall(
  install: ResolvedNativeInstall,
  version: string,
  asset: string,
): Promise<ResolvedNativeInstall | undefined> {
  const markerPath = join(dirname(dirname(install.libraryPath)), '.oliphaunt-native-install.json');
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstallMarker;
    await stat(install.libraryPath);
    if (install.runtimeDirectory !== undefined) {
      await stat(install.runtimeDirectory);
    }
    if (marker.version === version && marker.asset === asset && marker.checksum.length === 64) {
      return install;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readReleaseAssetBytes(version: string, asset: string): Promise<Uint8Array> {
  const localAssetDir = envVar(LIBOLIPHAUNT_RELEASE_ASSET_DIR_ENV);
  if (localAssetDir !== undefined && localAssetDir.trim().length > 0) {
    return Uint8Array.from(await readFile(join(localAssetDir, asset)));
  }
  const url = liboliphauntReleaseAssetUrl(version, asset);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download ${url} failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function installArchive(
  assetName: string,
  archive: Uint8Array,
  installRoot: string,
  marker: InstallMarker,
): Promise<void> {
  const parent = dirname(installRoot);
  const scratch = join(
    parent,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      join(scratch, '.oliphaunt-native-install.json'),
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

async function acquireInstallLock(path: string): Promise<() => Promise<void>> {
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
  throw new Error(`timed out waiting for liboliphaunt install lock ${path}`);
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
