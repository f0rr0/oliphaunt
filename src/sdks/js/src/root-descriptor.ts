import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { syncDirectory } from './native/filesystem-durability.js';

export const NATIVE_DESCRIPTOR_NAME = '.oliphaunt.json';
const nativeDescriptor = {
  schema: 'oliphaunt-database-root-v1',
  engineFamily: 'native',
  pgdata: 'pgdata',
  postgresMajor: 18,
  physicalFormat: 'native-pg18-v1',
} as const;
const fields = Object.keys(nativeDescriptor);

export async function validateManagedRoot(root: string): Promise<boolean> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`database root ${root} must be a real directory`);
  }
  const entries = await readdir(root);
  if (entries.length === 0) return false;
  if (!entries.includes(NATIVE_DESCRIPTOR_NAME)) {
    throw new Error(`database root ${root} is nonempty but has no ${NATIVE_DESCRIPTOR_NAME}`);
  }
  if (entries.some((entry) => entry !== NATIVE_DESCRIPTOR_NAME && entry !== 'pgdata')) {
    throw new Error(
      `database root ${root} contains files outside ${NATIVE_DESCRIPTOR_NAME} and pgdata`,
    );
  }
  const descriptorPath = join(root, NATIVE_DESCRIPTOR_NAME);
  const descriptorMetadata = await lstat(descriptorPath);
  if (!descriptorMetadata.isFile() || descriptorMetadata.isSymbolicLink()) {
    throw new Error(`database root descriptor ${descriptorPath} is not a regular file`);
  }
  validateDescriptor(await readFile(descriptorPath, 'utf8'), descriptorPath);
  const pgdata = join(root, 'pgdata');
  const pgdataMetadata = await lstat(pgdata);
  if (!pgdataMetadata.isDirectory() || pgdataMetadata.isSymbolicLink()) {
    throw new Error(`database root ${root} has no pgdata directory`);
  }
  await validateCompletePgdata(pgdata);
  return true;
}

export async function publishNativeDescriptor(root: string): Promise<void> {
  await validateCompletePgdata(join(root, 'pgdata'));
  const staging = join(
    root,
    `${NATIVE_DESCRIPTOR_NAME}.tmp-${globalThis.process?.pid ?? 0}-${Date.now()}`,
  );
  try {
    const file = await open(staging, 'wx');
    try {
      await file.writeFile(`${JSON.stringify(nativeDescriptor)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(staging, join(root, NATIVE_DESCRIPTOR_NAME));
    await syncDirectory(root);
  } catch (error) {
    try {
      await rm(staging, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'native root descriptor publication and cleanup failed',
      );
    }
    throw error;
  }
}

export async function validateCompletePgdata(pgdata: string): Promise<void> {
  const versionPath = join(pgdata, 'PG_VERSION');
  const versionMetadata = await lstat(versionPath);
  if (!versionMetadata.isFile() || versionMetadata.isSymbolicLink()) {
    throw new Error(`PG_VERSION ${versionPath} must be a regular file`);
  }
  const version = (await readFile(versionPath, 'utf8')).trim();
  if (version !== '18') throw new Error(`database root contains PostgreSQL ${version} PGDATA`);
  const control = join(pgdata, 'global', 'pg_control');
  const globalDirectory = join(pgdata, 'global');
  const globalMetadata = await lstat(globalDirectory);
  if (!globalMetadata.isDirectory() || globalMetadata.isSymbolicLink()) {
    throw new Error(`global ${globalDirectory} must be a real directory`);
  }
  const controlMetadata = await lstat(control);
  if (!controlMetadata.isFile() || controlMetadata.isSymbolicLink() || controlMetadata.size === 0) {
    throw new Error(`pg_control ${control} must be a nonempty regular file`);
  }
  const wal = join(pgdata, 'pg_wal');
  const walMetadata = await lstat(wal);
  if (!walMetadata.isDirectory() || walMetadata.isSymbolicLink()) {
    throw new Error(`pg_wal ${wal} must be a real directory`);
  }
}

export function validateDescriptor(text: string, source = NATIVE_DESCRIPTOR_NAME): void {
  let record: Record<string, unknown>;
  try {
    record = parseFlatJsonObject(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${String(error)}`);
  }
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${source} must contain exactly the five database-root fields`);
  }
  const family = record.engineFamily;
  const format =
    family === 'native' ? 'native-pg18-v1' : family === 'wasix' ? 'wasix-pg18-v1' : undefined;
  if (
    record.schema !== 'oliphaunt-database-root-v1' ||
    record.pgdata !== 'pgdata' ||
    record.postgresMajor !== 18 ||
    record.physicalFormat !== format
  ) {
    throw new Error(`${source} is not a supported database-root descriptor`);
  }
}

function parseFlatJsonObject(text: string): Record<string, unknown> {
  let offset = skipWhitespace(text, 0);
  if (text[offset++] !== '{') throw new Error('expected an object');
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  offset = skipWhitespace(text, offset);
  if (text[offset] === '}') {
    offset += 1;
  } else {
    for (;;) {
      const keyToken = readJsonString(text, offset);
      const key = JSON.parse(keyToken.token) as string;
      if (seen.has(key)) throw new Error(`duplicate object key ${JSON.stringify(key)}`);
      seen.add(key);
      offset = skipWhitespace(text, keyToken.end);
      if (text[offset++] !== ':') throw new Error('expected a colon after an object key');
      offset = skipWhitespace(text, offset);
      const valueToken =
        text[offset] === '"' ? readJsonString(text, offset) : readJsonPrimitive(text, offset);
      result[key] = JSON.parse(valueToken.token) as unknown;
      offset = skipWhitespace(text, valueToken.end);
      if (text[offset] === '}') {
        offset += 1;
        break;
      }
      if (text[offset++] !== ',') throw new Error('expected a comma or closing brace');
      offset = skipWhitespace(text, offset);
    }
  }
  if (skipWhitespace(text, offset) !== text.length) throw new Error('trailing JSON data');
  return result;
}

function readJsonString(text: string, start: number): { token: string; end: number } {
  if (text[start] !== '"') throw new Error('expected a JSON string');
  let escaped = false;
  for (let offset = start + 1; offset < text.length; offset += 1) {
    const character = text[offset];
    if (!escaped && character === '"') {
      const token = text.slice(start, offset + 1);
      JSON.parse(token);
      return { token, end: offset + 1 };
    }
    if (!escaped && character === '\\') {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  throw new Error('unterminated JSON string');
}

function readJsonPrimitive(text: string, start: number): { token: string; end: number } {
  if (text[start] === '{' || text[start] === '[') {
    throw new Error('nested JSON values are not allowed');
  }
  let end = start;
  while (end < text.length && text[end] !== ',' && text[end] !== '}') end += 1;
  const token = text.slice(start, end).trim();
  if (token.length === 0) throw new Error('missing JSON value');
  JSON.parse(token);
  return { token, end };
}

function skipWhitespace(text: string, start: number): number {
  let offset = start;
  while (
    offset < text.length &&
    (text[offset] === ' ' ||
      text[offset] === '\t' ||
      text[offset] === '\n' ||
      text[offset] === '\r')
  ) {
    offset += 1;
  }
  return offset;
}
