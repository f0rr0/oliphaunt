import type { SerializedAssetSource } from './rpc.js';
import type { WasixAssetSource } from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function requireExactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== fields.length || actual.some((field, index) => field !== fields[index])) {
    throw new Error(`${label} fields must be exactly ${fields.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

export function requireVersion(value: unknown, label: string): string {
  const version = requireString(value, label);
  if (!SEMVER.test(version)) {
    throw new Error(`${label} must be a SemVer version`);
  }
  return version;
}

export function requireSha256(value: unknown, label: string): string {
  const sha256 = requireString(value, label);
  if (!SHA256.test(sha256)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return sha256;
}

export function requireSize(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function requireAssetSource(
  value: unknown,
  label: string,
  size: number,
  sizeKind: 'asset' | 'carrier' = 'asset',
): WasixAssetSource {
  if (typeof value === 'string') {
    return requireString(value, label);
  }
  if (value instanceof URL) {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    if (value.byteLength !== size) {
      throw new Error(`${label} byte length must match declared ${sizeKind} size ${size}`);
    }
    return value;
  }
  throw new Error(`${label} must be a URL, string, ArrayBuffer, or Uint8Array`);
}

export function serializeAssetSource(source: WasixAssetSource): SerializedAssetSource {
  if (typeof source === 'string') {
    return source;
  }
  if (source instanceof URL) {
    return source.href;
  }
  if (source instanceof Uint8Array) {
    return source.slice();
  }
  return new Uint8Array(source.slice(0));
}

export function requireSafeRelativeAssetPath(value: unknown, label: string): string {
  const path = requireString(value, label);
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a safe relative asset path`);
  }
  return path;
}
