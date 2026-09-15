import type { NativeBinding, NativeBindingOptions } from './types.js';

export async function createDefaultNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  if (
    typeof (globalThis as { Deno?: { version?: { deno?: string } } }).Deno?.version?.deno ===
    'string'
  ) {
    // Deno 2.8.1 skips native cleanup when terminating a Worker executing JS
    // (even without a stream). Retire FFI after the blocked-worker proof passes.
    const { createDenoNativeBinding } = await import('./deno.js');
    return createDenoNativeBinding(options);
  }
  const { createNodeNativeBinding } = await import('./node.js');
  return createNodeNativeBinding(options);
}
