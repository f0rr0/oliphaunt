import {
  requireAssetSource,
  requireExactObject,
  requireSafeRelativeAssetPath,
  requireSha256,
  requireSize,
  requireVersion,
  serializeAssetSource,
} from './descriptor-validation.js';
import type { SerializedRuntimeDescriptor } from './rpc.js';
import type { WasixRuntimeArchive, WasixRuntimeDescriptor, WasixRuntimeManifest } from './types.js';

const DESCRIPTOR_FIELDS = [
  'manifest',
  'product',
  'runtime',
  'runtimeArchive',
  'schema',
  'standardSeedArchive',
  'standardSeedManifest',
  'version',
];
const ARCHIVE_FIELDS = ['archive', 'sha256', 'size', 'source'];
const MANIFEST_FIELDS = ['sha256', 'size', 'source'];

/** Validate an imported runtime carrier before any bytes cross the worker boundary. */
export function serializeWasixRuntimeDescriptor(value: unknown): SerializedRuntimeDescriptor {
  validateRuntimeDescriptor(value, 'WASIX runtime descriptor');
  return {
    schema: value.schema,
    runtime: value.runtime,
    product: value.product,
    version: value.version,
    runtimeArchive: serializeArchive(value.runtimeArchive),
    standardSeedArchive: serializeArchive(value.standardSeedArchive),
    standardSeedManifest: serializeManifest(value.standardSeedManifest),
    manifest: {
      sha256: value.manifest.sha256,
      size: value.manifest.size,
      source: serializeAssetSource(value.manifest.source),
    },
  };
}

function validateRuntimeDescriptor(
  value: unknown,
  label: string,
): asserts value is WasixRuntimeDescriptor {
  const descriptor = requireExactObject(value, DESCRIPTOR_FIELDS, label);
  if (descriptor.schema !== 'oliphaunt-wasix-runtime-v2') {
    throw new Error(`${label} has unsupported schema`);
  }
  if (descriptor.runtime !== 'wasix') {
    throw new Error(`${label} must target runtime 'wasix'`);
  }
  if (descriptor.product !== 'liboliphaunt-wasix') {
    throw new Error(`${label} product must be 'liboliphaunt-wasix'`);
  }
  requireVersion(descriptor.version, `${label} version`);
  validateArchive(descriptor.runtimeArchive, `${label} runtime archive`);
  validateArchive(descriptor.standardSeedArchive, `${label} standard cluster seed archive`);
  validateManifest(descriptor.standardSeedManifest, `${label} standard cluster seed manifest`);
  validateManifest(descriptor.manifest, `${label} manifest`);
  if (descriptor.runtimeArchive.archive === descriptor.standardSeedArchive.archive) {
    throw new Error(`${label} runtime and standard cluster seed archives must have distinct paths`);
  }
}

function validateArchive(value: unknown, label: string): asserts value is WasixRuntimeArchive {
  const archive = requireExactObject(value, ARCHIVE_FIELDS, label);
  requireSafeRelativeAssetPath(archive.archive, `${label} path`);
  requireSha256(archive.sha256, `${label} SHA-256`);
  const size = requireSize(archive.size, `${label} size`);
  requireAssetSource(archive.source, `${label} source`, size);
}

function validateManifest(value: unknown, label: string): asserts value is WasixRuntimeManifest {
  const manifest = requireExactObject(value, MANIFEST_FIELDS, label);
  requireSha256(manifest.sha256, `${label} SHA-256`);
  const size = requireSize(manifest.size, `${label} size`);
  requireAssetSource(manifest.source, `${label} source`, size);
}

function serializeArchive(
  archive: WasixRuntimeArchive,
): SerializedRuntimeDescriptor['runtimeArchive'] {
  return {
    archive: archive.archive,
    sha256: archive.sha256,
    size: archive.size,
    source: serializeAssetSource(archive.source),
  };
}

function serializeManifest(
  manifest: WasixRuntimeManifest,
): SerializedRuntimeDescriptor['manifest'] {
  return {
    sha256: manifest.sha256,
    size: manifest.size,
    source: serializeAssetSource(manifest.source),
  };
}
