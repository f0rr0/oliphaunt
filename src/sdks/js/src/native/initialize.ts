import { randomUUID } from 'node:crypto';
import { cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  publishNativeDescriptor,
  validateCompletePgdata,
  validateManagedRoot,
} from '../root-descriptor.js';

export async function initializeNativePgdata(options: {
  root: string;
  pgdata: string;
  populatePgdata(pgdata: string): Promise<void>;
}): Promise<void> {
  if (await validateManagedRoot(options.root)) return;

  const staging = join(dirname(options.root), `.${basename(options.root)}.pgdata-${randomUUID()}`);
  try {
    await options.populatePgdata(staging);
    await validateCompletePgdata(staging);
    await rename(staging, options.pgdata);
    await publishNativeDescriptor(options.root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function copyNativeClusterSeed(
  clusterSeedDirectory: string,
  stagingPgdata: string,
): Promise<void> {
  await cp(join(clusterSeedDirectory, 'files'), stagingPgdata, {
    errorOnExist: true,
    recursive: true,
  });
  await normalizeNativeClusterSeedForHost(stagingPgdata);
}

async function normalizeNativeClusterSeedForHost(pgdata: string): Promise<void> {
  const file = join(pgdata, 'postgresql.conf');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const value = platform() === 'win32' ? 'windows' : 'mmap';
  let normalized = text;
  for (const key of ['shared_memory_type', 'dynamic_shared_memory_type']) {
    const line = `${key} = ${value}`;
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'mu');
    normalized = pattern.test(normalized)
      ? normalized.replace(pattern, line)
      : `${normalized}${normalized.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  if (normalized !== text) await writeFile(file, normalized, 'utf8');
}
