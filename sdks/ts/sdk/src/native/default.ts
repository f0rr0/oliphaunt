import type { NativeBinding, NativeBindingOptions } from './types.js';

export async function createDefaultNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  if (
    typeof (globalThis as { Deno?: { version?: { deno?: string } } }).Deno?.version?.deno ===
    'string'
  ) {
    // Deno 2.8.1 does not drain an addon's queued stream callback when its
    // Worker is terminated. Retire this FFI path after that teardown proof passes.
    const { createDenoNativeBinding } = await import('./deno.js');
    return createDenoNativeBinding(options);
  }
  const { createNodeNativeBinding } = await import('./node.js');
  return createNodeNativeBinding(options);
}
