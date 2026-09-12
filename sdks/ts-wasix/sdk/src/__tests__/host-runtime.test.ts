import { expect, test } from 'bun:test';
import { hostRuntime, hostRuntimeName } from '../host-runtime.js';

test('identifies the actual host and gives stable diagnostic names', () => {
  expect(hostRuntime()).toBe('bun');
  expect(hostRuntimeName()).toBe('Bun');
  expect(hostRuntimeName('node')).toBe('Node');
  expect(hostRuntimeName('deno')).toBe('Deno');
});
