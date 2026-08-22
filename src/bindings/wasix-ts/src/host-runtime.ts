export type WasixHostRuntime = 'bun' | 'deno' | 'node';

/** @internal Identify the JavaScript host selected by package exports. */
export function hostRuntime(): WasixHostRuntime {
  const globals = globalThis as typeof globalThis & {
    Bun?: unknown;
    Deno?: unknown;
  };
  if (globals.Bun !== undefined) return 'bun';
  if (globals.Deno !== undefined) return 'deno';
  return 'node';
}

/** @internal Human-readable host name for diagnostics. */
export function hostRuntimeName(runtime: WasixHostRuntime = hostRuntime()): string {
  return runtime === 'bun' ? 'Bun' : runtime === 'deno' ? 'Deno' : 'Node';
}
