import {
  PHYSICAL_FORMAT as CARRIER_PHYSICAL_FORMAT,
  POSTGRES_MAJOR as CARRIER_POSTGRES_MAJOR,
} from '@oliphaunt/liboliphaunt-wasix';

export const DATABASE_ROOT_DESCRIPTOR = '.oliphaunt.json';
export const DATABASE_ROOT_SCHEMA = 'oliphaunt-database-root-v1';
export const DATABASE_ROOT_PGDATA = 'pgdata';
export const DATABASE_ROOT_POSTGRES_MAJOR = CARRIER_POSTGRES_MAJOR;
export const WASIX_PHYSICAL_FORMAT = CARRIER_PHYSICAL_FORMAT;
export const NATIVE_PHYSICAL_FORMAT = 'native-pg18-v1';

export type DatabaseRootDescriptor = Readonly<{
  schema: typeof DATABASE_ROOT_SCHEMA;
  engineFamily: 'native' | 'wasix';
  pgdata: typeof DATABASE_ROOT_PGDATA;
  postgresMajor: number;
  physicalFormat: string;
}>;

export function wasixDatabaseRootDescriptor(): DatabaseRootDescriptor {
  return {
    schema: DATABASE_ROOT_SCHEMA,
    engineFamily: 'wasix',
    pgdata: DATABASE_ROOT_PGDATA,
    postgresMajor: DATABASE_ROOT_POSTGRES_MAJOR,
    physicalFormat: WASIX_PHYSICAL_FORMAT,
  };
}

export function parseDatabaseRootDescriptor(value: unknown): DatabaseRootDescriptor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'engineFamily' ||
    keys[1] !== 'pgdata' ||
    keys[2] !== 'physicalFormat' ||
    keys[3] !== 'postgresMajor' ||
    keys[4] !== 'schema'
  ) {
    return undefined;
  }
  if (
    descriptor.schema !== DATABASE_ROOT_SCHEMA ||
    (descriptor.engineFamily !== 'native' && descriptor.engineFamily !== 'wasix') ||
    descriptor.pgdata !== DATABASE_ROOT_PGDATA ||
    descriptor.postgresMajor !== DATABASE_ROOT_POSTGRES_MAJOR ||
    (descriptor.engineFamily === 'native'
      ? descriptor.physicalFormat !== NATIVE_PHYSICAL_FORMAT
      : descriptor.physicalFormat !== WASIX_PHYSICAL_FORMAT)
  ) {
    return undefined;
  }
  return descriptor as DatabaseRootDescriptor;
}

/** Parse the root descriptor while rejecting duplicate JSON keys. */
export function parseDatabaseRootDescriptorText(text: string): DatabaseRootDescriptor | undefined {
  return parseDatabaseRootDescriptor(parseJsonWithUniqueObjectKeys(text));
}

/** Parse JSON while retaining the duplicate-key rejection lost by JSON.parse(). */
export function parseJsonWithUniqueObjectKeys(text: string): unknown | undefined {
  try {
    const value: unknown = JSON.parse(text);
    const end = scanJsonValue(text, skipWhitespace(text, 0));
    return end !== undefined && skipWhitespace(text, end) === text.length ? value : undefined;
  } catch {
    return undefined;
  }
}

function readJsonString(text: string, offset: number): { value: string; next: number } | undefined {
  if (text[offset] !== '"') return undefined;
  for (let index = offset + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') {
      const value: unknown = JSON.parse(text.slice(offset, index + 1));
      return typeof value === 'string' ? { value, next: index + 1 } : undefined;
    }
  }
  return undefined;
}

function scanJsonValue(text: string, offset: number): number | undefined {
  if (text[offset] === '"') return readJsonString(text, offset)?.next;
  if (text[offset] === '{') return scanJsonObject(text, offset);
  if (text[offset] === '[') return scanJsonArray(text, offset);
  let end = offset;
  while (
    end < text.length &&
    text[end] !== ',' &&
    text[end] !== '}' &&
    text[end] !== ']' &&
    !isJsonWhitespace(text[end])
  ) {
    end += 1;
  }
  return end > offset ? end : undefined;
}

function scanJsonObject(text: string, offset: number): number | undefined {
  let next = skipWhitespace(text, offset + 1);
  if (text[next] === '}') return next + 1;
  const keys = new Set<string>();
  while (next < text.length) {
    const key = readJsonString(text, next);
    if (key === undefined || keys.has(key.value)) return undefined;
    keys.add(key.value);
    next = skipWhitespace(text, key.next);
    if (text[next] !== ':') return undefined;
    const valueEnd = scanJsonValue(text, skipWhitespace(text, next + 1));
    if (valueEnd === undefined) return undefined;
    next = skipWhitespace(text, valueEnd);
    if (text[next] === '}') return next + 1;
    if (text[next] !== ',') return undefined;
    next = skipWhitespace(text, next + 1);
  }
  return undefined;
}

function scanJsonArray(text: string, offset: number): number | undefined {
  let next = skipWhitespace(text, offset + 1);
  if (text[next] === ']') return next + 1;
  while (next < text.length) {
    const valueEnd = scanJsonValue(text, next);
    if (valueEnd === undefined) return undefined;
    next = skipWhitespace(text, valueEnd);
    if (text[next] === ']') return next + 1;
    if (text[next] !== ',') return undefined;
    next = skipWhitespace(text, next + 1);
  }
  return undefined;
}

function skipWhitespace(text: string, offset: number): number {
  while (offset < text.length && isJsonWhitespace(text[offset])) {
    offset += 1;
  }
  return offset;
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}
