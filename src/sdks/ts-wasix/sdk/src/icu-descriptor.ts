import {
  requireAssetSource,
  requireExactObject,
  serializeAssetSource,
} from './descriptor-validation.js';
import type { SerializedIcuDescriptor, SerializedSeed } from './rpc.js';

function source(value: unknown, label: string) {
  const size = value instanceof Uint8Array || value instanceof ArrayBuffer ? value.byteLength : 0;
  return serializeAssetSource(requireAssetSource(value, label, size));
}

export function serializeWasixIcuDescriptor(value: unknown): SerializedIcuDescriptor {
  const data = requireExactObject(value, ['data', 'manifest'], 'ICU data');
  return { data: source(data.data, 'ICU data'), manifest: source(data.manifest, 'ICU manifest') };
}

export function serializeWasixSeed(value: unknown): SerializedSeed {
  const seed = requireExactObject(value, ['archive', 'manifest'], 'WASIX seed');
  return {
    archive: source(seed.archive, 'seed archive'),
    manifest: source(seed.manifest, 'seed manifest'),
  };
}
