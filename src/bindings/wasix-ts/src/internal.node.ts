import type { OliphauntDatabase } from './types.js';
import { tryRunWasixNativeToolProcess } from './database.js';
import type { WasixToolProcessOptions, WasixToolProcessResult } from './internal-common.js';

export { getWasixDatabaseIdentity } from './database.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './internal-common.js';

export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
): Promise<WasixToolProcessResult> {
  const native = tryRunWasixNativeToolProcess(database, options);
  if (native !== undefined) return native;
  throw new Error(
    'this database is not backed by the Oliphaunt WASIX native runtime required by Node.js, Bun, Deno, and Electron tools',
  );
}
