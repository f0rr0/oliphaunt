import {
  requireAssetSource,
  requireExactObject,
  requireSafeRelativeAssetPath,
  requireSha256,
  requireSize,
  requireVersion,
  serializeAssetSource,
} from './descriptor-validation.js';
import type { SerializedIcuDescriptor, SerializedRuntimeArchive } from './rpc.js';
import type { WasixIcuDescriptor, WasixRuntimeArchive, WasixRuntimeManifest } from './types.js';

const DESCRIPTOR_FIELDS = [
  'clusterSeedArchive',
  'clusterSeedManifest',
  'compatibility',
  'dataArchive',
  'product',
  'runtime',
  'schema',
  'version',
] as const;
const COMPATIBILITY_FIELDS = [
  'compatibilityKey',
  'dataForm',
  'dataTreeSha256',
  'dataVersion',
  'physicalFormat',
  'postgresMajor',
  'runtimeProduct',
  'runtimeVersion',
] as const;
const ARCHIVE_FIELDS = ['archive', 'sha256', 'size', 'source'] as const;
const MANIFEST_FIELDS = ['sha256', 'size', 'source'] as const;

/** Validate an explicitly imported ICU carrier before bytes cross a worker boundary. */
export function serializeWasixIcuDescriptor(value: unknown): SerializedIcuDescriptor {
  validateWasixIcuDescriptor(value, 'WASIX ICU descriptor');
  return {
    schema: value.schema,
    runtime: value.runtime,
    product: value.product,
    version: value.version,
    compatibility: { ...value.compatibility },
    dataArchive: serializeArchive(value.dataArchive),
    clusterSeedArchive: serializeArchive(value.clusterSeedArchive),
    clusterSeedManifest: serializeManifest(value.clusterSeedManifest),
  };
}

function validateWasixIcuDescriptor(
  value: unknown,
  label: string,
): asserts value is WasixIcuDescriptor {
  const descriptor = requireExactObject(value, DESCRIPTOR_FIELDS, label);
  if (descriptor.schema !== 'oliphaunt-wasix-icu-v1')
    throw new Error(`${label} has unsupported schema`);
  if (descriptor.runtime !== 'wasix') throw new Error(`${label} must target runtime 'wasix'`);
  if (descriptor.product !== 'oliphaunt-icu')
    throw new Error(`${label} product must be 'oliphaunt-icu'`);
  requireVersion(descriptor.version, `${label} version`);
  const compatibility = requireExactObject(
    descriptor.compatibility,
    COMPATIBILITY_FIELDS,
    `${label} compatibility`,
  );
  if (
    compatibility.runtimeProduct !== 'liboliphaunt-wasix' ||
    compatibility.postgresMajor !== '18' ||
    compatibility.physicalFormat !== 'wasix-pg18-v1' ||
    compatibility.compatibilityKey !== 'wasix-pg18-datum32-v1' ||
    compatibility.dataVersion !== '76.1' ||
    compatibility.dataForm !== 'files-le'
  ) {
    throw new Error(`${label} has an incompatible WASIX/ICU identity`);
  }
  requireVersion(compatibility.runtimeVersion, `${label} compatible runtime version`);
  requireSha256(compatibility.dataTreeSha256, `${label} ICU data tree SHA-256`);
  validateArchive(descriptor.dataArchive, `${label} ICU data archive`);
  validateArchive(descriptor.clusterSeedArchive, `${label} ICU cluster seed archive`);
  validateManifest(descriptor.clusterSeedManifest, `${label} ICU cluster seed manifest`);
  if (descriptor.dataArchive.archive === descriptor.clusterSeedArchive.archive) {
    throw new Error(`${label} ICU data and cluster seed archives must have distinct paths`);
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

function serializeArchive(archive: WasixRuntimeArchive): SerializedRuntimeArchive {
  return {
    archive: archive.archive,
    sha256: archive.sha256,
    size: archive.size,
    source: serializeAssetSource(archive.source),
  };
}

function serializeManifest(
  manifest: WasixRuntimeManifest,
): SerializedIcuDescriptor['clusterSeedManifest'] {
  return {
    sha256: manifest.sha256,
    size: manifest.size,
    source: serializeAssetSource(manifest.source),
  };
}
