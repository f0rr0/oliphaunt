import { optionRecord, positiveInteger } from '@oliphaunt/ts-query/internal/resource-options';
import { loadNativeWasixAddon } from './native-addon.js';

/** Shared by all native-host WASIX databases and tools in this process. */
export type HostRuntimeOptions = Readonly<{
  /** Async executor workers. Omitted: CPU count / TOKIO_WORKER_THREADS. */
  asyncWorkerThreads?: number;
  /** Maximum lazily created Tokio blocking workers. Default: 512. */
  maxBlockingThreads?: number;
  /** Dedicated Wasm/host task workers, created on demand and retained. Default: max(200, CPUs * 100). */
  maxDedicatedThreads?: number;
  /** Parallel file helpers per initial-copy/publication operation. Default: 4. */
  maxConcurrentIO?: number;
}>;

/** Configure before first database/tool use. Conflicting changes to a live host fail. */
export function configureHostRuntime(options: HostRuntimeOptions): void {
  const record = optionRecord(
    options,
    ['asyncWorkerThreads', 'maxBlockingThreads', 'maxDedicatedThreads', 'maxConcurrentIO'],
    'host runtime',
  );
  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, positiveInteger(value, `host runtime ${key}`, 0xffff_ffff)]),
  );
  const configure = loadNativeWasixAddon().configureHostRuntime;
  if (configure === undefined)
    throw new Error(
      'installed WASIX addon does not support host runtime configuration; update the addon',
    );
  configure(normalized);
}
