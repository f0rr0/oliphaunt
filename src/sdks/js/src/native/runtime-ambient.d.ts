declare module 'bun:ffi' {
  export const FFIType: {
    readonly buffer: unknown;
    readonly cstring: unknown;
    readonly i32: unknown;
    readonly ptr: unknown;
    readonly u32: unknown;
    readonly u64: unknown;
    readonly void: unknown;
  };

  export function dlopen(
    path: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>,
  ): { symbols: Record<string, (...args: unknown[]) => unknown> };

  export function ptr(value: Uint8Array): number | bigint;
  export function toArrayBuffer(
    pointer: number,
    byteOffset: number,
    byteLength: number,
  ): ArrayBuffer;
}
