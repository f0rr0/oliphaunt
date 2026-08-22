import type { WasixRuntimeDescriptor } from '../types.js';

export const POSTGRES_MAJOR = 18 as const;
export const PHYSICAL_FORMAT = 'wasix-pg18-v1' as const;

const runtime = undefined as unknown as WasixRuntimeDescriptor;
export default runtime;
