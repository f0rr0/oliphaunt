import { restoreWasix, serializeOpenConfig } from './client-common.js';
import {
  openWasixDirect,
  type DirectWasixHost,
  type DirectWasixEnvironment,
} from './direct-client-common.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

/** Open PostgreSQL in the importing browser realm. Guest calls block that realm. */
export async function openWasixBlocking(
  config: OpenConfig = {},
): Promise<OliphauntDatabase> {
  return openWasixBlockingWithHost(config, () => import('./host/index.mjs'));
}

/** @internal Dependency seam for entrypoint contract qualification. */
export async function openWasixBlockingWithHost(
  config: OpenConfig,
  loadHost: () => Promise<DirectWasixHost>,
): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix-ts/blocking requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  const host = await loadHost();
  return openWasixDirect(openOptions, host, browserRealm());
}

export const Oliphaunt: OliphauntClient = {
  open: openWasixBlocking,
  restore: restoreWasix,
};

function browserRealm(): DirectWasixEnvironment {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope
    ? 'browser-worker'
    : 'browser-main';
}
