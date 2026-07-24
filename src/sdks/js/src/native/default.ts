import type { NativeBinding, NativeBindingOptions } from './types.js';

export async function createDefaultNativeBinding(
  options: NativeBindingOptions = {},
): Promise<NativeBinding> {
  if (isDeno()) {
    const { createDenoNativeBinding } = await import('./deno.js');
    return createDenoNativeBinding(options);
  }
  if (isBun()) {
    const { createBunNativeBinding } = await import('./bun.js');
    return createBunNativeBinding(options);
  }
  const { createNodeNativeBinding } = await import('./node.js');
  return createNodeNativeBinding(options);
}

function isDeno(): boolean {
  return (
    typeof (globalThis as { Deno?: { version?: { deno?: string } } }).Deno?.version?.deno ===
    'string'
  );
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}
