import { readFile } from 'node:fs/promises';

import * as host from './host/index.mjs';

export const Directory = host.Directory;
export const instantiateOliphauntDirect = host.instantiateOliphauntDirect;
export const prepareOliphauntTool = host.prepareOliphauntTool;
export const runOliphauntToolDirect = host.runOliphauntToolDirect;

export async function init(options: Record<string, unknown> = {}): Promise<unknown> {
  const module = await readFile(new URL('./host/wasmer_js_bg.wasm', import.meta.url));
  return host.init({
    ...options,
    module,
    sdkUrl: new URL('./host/index.mjs', import.meta.url),
  });
}
