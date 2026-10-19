import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { NativeResourceDirectory } from '../types.js';

export type NativeCatalogProfile = 'standard' | 'icu';

/** Hash the actual selected immutable files, including unexpected or missing files. */
async function resourceTreeSha256(root: string): Promise<string> {
  const paths: string[] = [];
  let totalBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(`resource must be a real directory: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`resource must not contain symlinks: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`resource contains a special file: ${path}`);
      if (paths.length > 8192) throw new Error('resource has too many files');
    }
  };
  await walk(root);
  paths.sort((left, right) =>
    Buffer.compare(
      Buffer.from(relative(root, left).replaceAll('\\', '/')),
      Buffer.from(relative(root, right).replaceAll('\\', '/')),
    ),
  );
  const hash = createHash('sha256');
  for (const path of paths) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`resource file changed during validation: ${path}`);
    totalBytes += metadata.size;
    if (totalBytes > 1024 * 1024 * 1024) throw new Error('resource exceeds the 1 GiB limit');
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update(Buffer.of(0));
    hash.update(String(metadata.size));
    hash.update(Buffer.of(0));
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function validateSelectedIcuData(resource: NativeResourceDirectory): Promise<string> {
  const expected = validateNativeIcuDataReceipt(
    await readFile(resource.manifestPath, 'utf8'),
    resource.manifestPath,
  );
  const actual = await resourceTreeSha256(resource.directory);
  if (actual !== expected) throw new Error('selected ICU data does not match its manifest');
  return actual;
}

export async function validateSelectedNativeSeed(
  resource: NativeResourceDirectory,
  target: string,
  runtimeVersion: string,
  icuDataTreeSha256?: string,
): Promise<{ catalogProfile: NativeCatalogProfile; emptyDirectories: string[] }> {
  const manifest = JSON.parse(await readFile(resource.manifestPath, 'utf8'));
  const profile = manifest.catalogProfile;
  if (
    manifest.schema !== 'oliphaunt-cluster-seed-v1' ||
    !['standard', 'icu'].includes(profile) ||
    manifest.artifactRole !== `cluster-seed-${profile}`
  )
    throw new Error('selected native seed has an invalid resource manifest');
  const runtime = manifest.runtime;
  if (
    runtime?.product !== 'liboliphaunt-native' ||
    runtime.engineFamily !== 'native' ||
    runtime.version !== runtimeVersion ||
    runtime.target !== target ||
    runtime.postgresMajor !== 18 ||
    runtime.physicalFormat !== 'native-pg18-v1' ||
    runtime.compatibilityKey !== `native-pg18-${target}-v1`
  )
    throw new Error(
      `selected seed is incompatible with native runtime ${runtimeVersion} for ${target}`,
    );
  if (profile === 'icu') {
    if (
      !icuDataTreeSha256 ||
      manifest.icu?.dataVersion !== '76.1' ||
      manifest.icu?.dataForm !== 'files-le' ||
      manifest.icu?.dataTreeSha256 !== icuDataTreeSha256
    )
      throw new Error('selected ICU seed requires its matching explicit ICU data');
  } else if (manifest.icu !== null || icuDataTreeSha256 !== undefined)
    throw new Error('standard seed cannot initialize an ICU catalog');
  const payload = manifest.directory;
  if (
    typeof payload?.path !== 'string' ||
    !SHA256.test(payload.treeSha256 ?? '') ||
    resolve(dirname(resource.manifestPath), payload.path) !== resolve(resource.directory)
  )
    throw new Error('selected seed directory does not match its manifest');
  if ((await resourceTreeSha256(resource.directory)) !== payload.treeSha256)
    throw new Error('selected native seed directory is corrupted');
  if ((await readFile(join(resource.directory, 'PG_VERSION'), 'utf8')).trim() !== '18')
    throw new Error('selected native seed has the wrong PostgreSQL major version');
  const control = await lstat(join(resource.directory, 'global/pg_control'));
  if (!control.isFile() || control.isSymbolicLink() || control.size === 0)
    throw new Error('selected native seed is missing pg_control');
  const emptyDirectories = payload.emptyDirectories;
  if (
    !Array.isArray(emptyDirectories) ||
    emptyDirectories.length > 8192 ||
    new Set(emptyDirectories).size !== emptyDirectories.length
  )
    throw new Error('selected seed has an invalid empty-directory inventory');
  for (const path of emptyDirectories) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\\') ||
      path
        .split('/')
        .some(
          (part) =>
            !part || part === '.' || part === '..' || part.includes(':') || part.includes('\0'),
        )
    )
      throw new Error('selected seed has an unsafe empty-directory path');
    let parent = resource.directory;
    for (const part of path.split('/')) {
      parent = join(parent, part);
      const metadata = await lstat(parent).catch((error) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
        throw new Error('seed empty-directory path overlaps a file or link');
    }
  }
  return { catalogProfile: profile, emptyDirectories };
}

const SHA256 = /^[0-9a-f]{64}$/u;
const ICU_DATA_FIELDS = [
  'schema',
  'artifactRole',
  'icuDataVersion',
  'icuDataForm',
  'icuDataTreeSha256',
] as const;
function parseProperties(manifest: string, source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of manifest.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`${source} manifest contains a malformed property`);
    }
    const key = line.slice(0, separator);
    if (fields.has(key)) {
      throw new Error(`${source} manifest repeats property ${key}`);
    }
    fields.set(key, line.slice(separator + 1));
  }
  return fields;
}

function requireExactFields(
  fields: ReadonlyMap<string, string>,
  expected: ReadonlyArray<string>,
  source: string,
): void {
  if (fields.size !== expected.length || expected.some((key) => !fields.has(key))) {
    throw new Error(`${source} manifest fields must be exactly ${expected.join(',')}`);
  }
}

export function requireIcuDataTreeSha256(value: string | undefined, source: string): string {
  if (value === undefined || !SHA256.test(value)) {
    throw new Error(`${source} does not declare canonical ICU data identity`);
  }
  return value;
}

export function validateNativeIcuDataReceipt(manifest: string, source: string): string {
  const fields = parseProperties(manifest, source);
  requireExactFields(fields, ICU_DATA_FIELDS, source);
  if (
    fields.get('schema') !== 'oliphaunt-icu-data-v1' ||
    fields.get('artifactRole') !== 'icu-data' ||
    fields.get('icuDataVersion') !== '76.1' ||
    fields.get('icuDataForm') !== 'files-le'
  ) {
    throw new Error(`${source} manifest does not declare canonical ICU data`);
  }
  return requireIcuDataTreeSha256(fields.get('icuDataTreeSha256'), source);
}
