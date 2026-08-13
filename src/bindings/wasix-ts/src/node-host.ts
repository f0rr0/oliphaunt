import { readFile } from 'node:fs/promises';

import * as host from './host/index.mjs';
import { installNodeWebWorker } from './node-web-worker.js';

export const Directory = host.Directory;
export const runWasix = host.runWasix;
export const instantiateOliphauntDirect = host.instantiateOliphauntDirect;

export async function init(options: Record<string, unknown> = {}): Promise<unknown> {
  installNodeWebWorker();
  return initDirect(options);
}

/** Initialize the host without installing Wasmer's inner-worker adapter. */
export async function initDirect(options: Record<string, unknown> = {}): Promise<unknown> {
  const module = await readFile(new URL('./host/wasmer_js_bg.wasm', import.meta.url));
  return host.init({
    ...options,
    module,
    sdkUrl: new URL('./host/index.mjs', import.meta.url),
    workerUrl: new URL('./host/worker.mjs', import.meta.url),
  });
}
