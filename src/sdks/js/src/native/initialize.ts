import { randomUUID } from 'node:crypto';
import { cp, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { DEFAULT_USERNAME } from '../config.js';
import { INTERNAL_NATIVE_POSTGRES_ENVIRONMENT } from './common.js';
import { syncDirectory, syncDirectoryTree } from './filesystem-durability.js';
import {
  NATIVE_DESCRIPTOR_NAME,
  publishNativeDescriptor,
  validateCompletePgdata,
  validateManagedRoot,
} from '../root-descriptor.js';

export async function initializeNativePgdata(
  options: {
    root: string;
    pgdata: string;
    username: string;
    populatePgdata(pgdata: string): Promise<void>;
  },
  publishDescriptor: (root: string) => Promise<void> = publishNativeDescriptor,
): Promise<void> {
  if (await validateManagedRoot(options.root)) return;
  if (options.username !== DEFAULT_USERNAME) {
    throw new Error(
      `new native database storage is bootstrapped as ${DEFAULT_USERNAME}; create role ${JSON.stringify(options.username)} before selecting it as username`,
    );
  }

  const staging = join(dirname(options.root), `.${basename(options.root)}.pgdata-${randomUUID()}`);
  let pgdataPublished = false;
  try {
    await options.populatePgdata(staging);
    await validateCompletePgdata(staging);
    await syncDirectoryTree(staging);
    await rename(staging, options.pgdata);
    pgdataPublished = true;
    await syncDirectory(options.root);
    await publishDescriptor(options.root);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await rm(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (pgdataPublished) {
      let descriptorDefinitelyAbsent = false;
      try {
        await lstat(join(options.root, NATIVE_DESCRIPTOR_NAME));
      } catch (inspectionError) {
        if (
          typeof inspectionError === 'object' &&
          inspectionError !== null &&
          'code' in inspectionError &&
          inspectionError.code === 'ENOENT'
        ) {
          descriptorDefinitelyAbsent = true;
        } else {
          failures.push(inspectionError);
        }
      }
      if (descriptorDefinitelyAbsent) {
        try {
          await rm(options.pgdata, { recursive: true, force: true });
          await syncDirectory(options.root);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'native PGDATA initialization and cleanup failed');
    }
    throw error;
  }
}

export function nativeInitdbArgs(pgdata: string): string[] {
  return [
    '-D',
    pgdata,
    '-U',
    DEFAULT_USERNAME,
    '--auth=trust',
    '--locale-provider=libc',
    '--locale=C',
    '--encoding=UTF8',
  ];
}

export function nativePostgresChildEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  options: {
    readonly icuDataDirectory?: string;
    readonly initdbCatalogProfile?: 'standard' | 'icu';
  } = {},
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const name of INTERNAL_NATIVE_POSTGRES_ENVIRONMENT) delete env[name];
  delete env.ICU_DATA;
  if (options.icuDataDirectory !== undefined) env.ICU_DATA = options.icuDataDirectory;
  if (options.initdbCatalogProfile === 'standard') {
    delete env.ICU_DATA;
    env.OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY = '1';
  } else if (options.initdbCatalogProfile === 'icu') {
    if (options.icuDataDirectory === undefined) {
      throw new Error('ICU catalog initialization requires verified ICU data');
    }
    env.OLIPHAUNT_INTERNAL_ICU_READY = '1';
  }
  return env;
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
