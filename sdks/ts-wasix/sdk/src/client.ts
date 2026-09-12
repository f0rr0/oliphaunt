import { restoreWasix, serializeOpenConfig } from './client-common.js';
import {
  openWasixDirect,
  type DirectWasixEnvironment,
  type DirectWasixHost,
} from './direct-client-common.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

/** Open PostgreSQL in the importing browser realm. Guest execution may block that realm. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  return openWasixWithHost(config, () => import('./host/index.mjs'));
}

/** @internal Dependency seam for root-entrypoint contract qualification. */
export async function openWasixWithHost(
  config: OpenConfig,
  loadHost: () => Promise<DirectWasixHost>,
): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix-ts requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  const host = await loadHost();
  return openWasixDirect(openOptions, host, browserRealm());
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreWasix,
};

function browserRealm(): DirectWasixEnvironment {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope
    ? 'browser-worker'
    : 'browser-main';
}
