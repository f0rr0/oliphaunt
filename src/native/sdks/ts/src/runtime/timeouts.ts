import { envVar } from '../native/common.js';

export const CONTROL_TIMEOUT_MS_ENV = 'OLIPHAUNT_CONTROL_TIMEOUT_MS';
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** Node, Bun, and Deno timers share a signed 32-bit millisecond ceiling. */
export function lifecycleTimeoutMs(name: string, fallback: number): number {
  const value = envVar(name);
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value.trim());
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > 2_147_483_647 ||
    parsed.toString() !== value.trim()
  ) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds between 1 and 2147483647`,
    );
  }
  return parsed;
}
