import { DEFAULT_BROWSER_STARTUP_TIMEOUT_MS, StartupBudget } from '../../core/startup-budget.js';
import { restoreWasix } from './client-common.js';
import { requireBrowserStorage, serializeOpenConfig } from '../../core/open-config.js';
import {
  openWasixDirect,
  type DirectWasixEnvironment,
  type DirectWasixHost,
} from './direct-client-common.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './browser-public.js';

/** Open PostgreSQL in the importing browser realm. Guest execution may block that realm. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  return openWasixWithHost(config, () => import('../../host/index.mjs'));
}

/** @internal Dependency seam for root-entrypoint contract qualification. */
export async function openWasixWithHost(
  config: OpenConfig,
  loadHost: () => Promise<DirectWasixHost>,
): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  requireBrowserStorage(openOptions);
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix-ts requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  if (openOptions.timeouts?.shutdownTimeoutMs !== undefined)
    throw new TypeError('shutdownTimeoutMs requires a /worker database');
  const budget = new StartupBudget(
    openOptions.timeouts?.startupTimeoutMs ?? DEFAULT_BROWSER_STARTUP_TIMEOUT_MS,
  );
  try {
    const host = await budget.prepare(loadHost());
    return await openWasixDirect(openOptions, host, browserRealm(), budget);
  } finally {
    budget.finish();
  }
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: (storage, bytes, options) =>
    restoreWasix(storage, bytes, requireBrowserStorage, options),
};

function browserRealm(): DirectWasixEnvironment {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope
    ? 'browser-worker'
    : 'browser-main';
}
