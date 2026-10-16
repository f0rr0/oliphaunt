import type { OliphauntDatabase } from './core/types.js';
import { admitWasixToolProcess, tryRunWasixNativeToolProcess } from './core/database.js';
import type { WasixToolProcessInput } from './resources/tool-runtime.js';
import type { WasixToolProcessResult } from './hosts/browser/internal-common.js';

export { getWasixDatabaseIdentity } from './core/database.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './hosts/browser/internal-common.js';

export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessInput,
): Promise<WasixToolProcessResult> {
  return admitWasixToolProcess(database, options, (prepared) => {
    const native = tryRunWasixNativeToolProcess(database, prepared);
    if (native !== undefined) return native;
    throw new Error(
      'this database is not backed by the Oliphaunt WASIX native runtime required by Node.js, Bun, Deno, and Electron tools',
    );
  });
}
