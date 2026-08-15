export type WasixServerRuntime = 'bun' | 'deno' | 'node';

/** @internal Identify the server-side JavaScript runtime selected by package exports. */
export function serverRuntime(): WasixServerRuntime {
  const globals = globalThis as typeof globalThis & { Bun?: unknown; Deno?: unknown };
  if (globals.Bun !== undefined) return 'bun';
  if (globals.Deno !== undefined) return 'deno';
  return 'node';
}

/** @internal Human-readable runtime name for diagnostics. */
export function serverRuntimeName(runtime: WasixServerRuntime = serverRuntime()): string {
  return runtime === 'bun' ? 'Bun' : runtime === 'deno' ? 'Deno' : 'Node';
}
