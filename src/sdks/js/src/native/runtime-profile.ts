import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type NativeRuntimeProfile = {
  readonly icuDataDirectory?: string;
  readonly catalogProfile: 'standard' | 'icu';
};

/** Resolve the catalog profile from the exact caller-supplied runtime tree. */
export async function resolveExactNativeRuntimeProfile(
  runtimeDirectory: string,
): Promise<NativeRuntimeProfile> {
  const icuDataDirectory = join(runtimeDirectory, 'share/icu');
  let metadata;
  try {
    metadata = await stat(icuDataDirectory);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { catalogProfile: 'standard' };
    throw new Error(`inspect explicit native runtime ICU data ${icuDataDirectory}`, {
      cause: error,
    });
  }
  if (!metadata.isDirectory()) {
    throw new Error(`explicit native runtime ICU data must be a directory: ${icuDataDirectory}`);
  }
  if (!(await containsUsableIcuPayload(icuDataDirectory))) {
    throw new Error(
      `explicit native runtime ICU data does not contain a usable icudt payload: ${icuDataDirectory}`,
    );
  }
  return { icuDataDirectory, catalogProfile: 'icu' };
}

async function containsUsableIcuPayload(root: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('icudt')) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.dat') && (await stat(path)).size > 0) {
      return true;
    }
    if (entry.isDirectory() && (await directoryContainsRegularFile(path))) {
      return true;
    }
  }
  return false;
}

async function directoryContainsRegularFile(root: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && (await stat(path)).size > 0) return true;
    if (entry.isDirectory() && (await directoryContainsRegularFile(path))) return true;
  }
  return false;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
