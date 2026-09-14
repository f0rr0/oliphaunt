import type { WasixRuntimeDescriptor } from '../types.js';

export const POSTGRES_MAJOR = 18 as const;
export const PHYSICAL_FORMAT = 'wasix-pg18-v1' as const;

const runtime: WasixRuntimeDescriptor = {
  schema: 'oliphaunt-wasix-runtime-v2',
  runtime: 'wasix',
  product: 'liboliphaunt-wasix',
  version: '0.1.1',
  runtimeArchive: {
    archive: 'oliphaunt.wasix.tar.zst',
    sha256: '1'.repeat(64),
    size: 1,
    source: Uint8Array.of(1),
  },
  manifest: {
    sha256: '3'.repeat(64),
    size: 1,
    source: Uint8Array.of(3),
  },
};
export default runtime;
