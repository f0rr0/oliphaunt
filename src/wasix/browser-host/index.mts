import initialize, { setSDKUrl, setWorkerUrl } from './pkg/wasmer_sdk_js.js';
import type { InitInput, InitOutput } from './pkg/wasmer_sdk_js.js';

export * from './pkg/wasmer_sdk_js.js';
export { default } from './pkg/wasmer_sdk_js.js';

export type WasmerInitOptions = Readonly<{
  module?: InitInput | Promise<InitInput>;
  memory?: WebAssembly.Memory;
  workerUrl?: string | URL;
  sdkUrl?: string | URL;
  log?: string;
  registryUrl?: string;
  token?: string;
}>;

export async function init(options: WasmerInitOptions = {}): Promise<InitOutput> {
  const output = await initialize({
    module_or_path: options.module ?? new URL('./wasmer_js_bg.wasm', import.meta.url),
    memory: options.memory,
  });
  setSDKUrl(String(options.sdkUrl ?? new URL('./index.mjs', import.meta.url)));
  setWorkerUrl(String(options.workerUrl ?? new URL('./worker.mjs', import.meta.url)));
  return output;
}
