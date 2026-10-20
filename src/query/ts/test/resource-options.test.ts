import { expect, test } from 'bun:test';
import { normalizeRuntimeTimeouts, timeoutMilliseconds } from '../src/resource-options.js';

test('lifecycle options are snapshotted and reject unknown fields and timer overflow', () => {
  const input = { startupTimeoutMs: 12, shutdownTimeoutMs: 34 };
  const selected = normalizeRuntimeTimeouts(input);
  input.startupTimeoutMs = 56;
  expect(selected).toEqual({ startupTimeoutMs: 12, shutdownTimeoutMs: 34 });
  expect(() => normalizeRuntimeTimeouts({ startupTimeoutMS: 1 })).toThrow('accepts only');
  for (const value of [0, -1, 1.5, Infinity, NaN, '100', 2_147_483_648]) {
    expect(() => timeoutMilliseconds(value, 'timeout')).toThrow();
  }
  expect(timeoutMilliseconds(2_147_483_647, 'timeout')).toBe(2_147_483_647);
});
