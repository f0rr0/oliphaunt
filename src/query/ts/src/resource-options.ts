/** Owned lifecycle budgets. A shutdown deadline may retire work still draining after close. */
export type RuntimeTimeouts = Readonly<{
  /** Startup through protocol readiness; resource preparation depends on the host placement. */
  startupTimeoutMs?: number;
  /** Grace for close before forced owner cleanup; accepted work may still be draining. */
  shutdownTimeoutMs?: number;
}>;

export function positiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function timeoutMilliseconds(value: unknown, label: string): number {
  return positiveInteger(value, label, 2_147_483_647);
}

export function optionRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new TypeError(`${label} accepts only ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

export function normalizeRuntimeTimeouts(value: unknown): RuntimeTimeouts | undefined {
  if (value === undefined) return undefined;
  const record = optionRecord(value, ['startupTimeoutMs', 'shutdownTimeoutMs'], 'timeouts');
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, timeoutMilliseconds(value, `timeouts.${key}`)]),
  );
}
