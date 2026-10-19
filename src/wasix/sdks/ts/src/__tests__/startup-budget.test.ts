import { expect, test } from 'bun:test';
import { StartupBudget } from '../core/startup-budget.js';
import { loadAsset } from '../resources/archive.js';
import { prepareRuntimeCached } from '../hosts/browser/direct-client-common.js';
import type { PreparedWasixRuntime } from '../resources/extensions.js';
import { workerOpenOptions } from './worker-helpers.js';

test('expired preparation observes its already-rejected input and rejects as a promise', async () => {
  const budget = new StartupBudget(10);
  try {
    const unblock = performance.now() + 30;
    while (performance.now() < unblock) {}
    const prepared = budget.prepare(Promise.reject(new Error('preparation failed')));
    expect(prepared).toBeInstanceOf(Promise);
    await expect(prepared).rejects.toThrow('exceeded 10ms');
  } finally {
    budget.finish();
  }
});

test('startup rejects late preparation even when its microtask beats the overdue timer', async () => {
  const budget = new StartupBudget(10);
  try {
    const prepared = budget.prepare(Promise.resolve('late'));
    const unblock = performance.now() + 30;
    while (performance.now() < unblock) {}
    await expect(prepared).rejects.toThrow('exceeded 10ms');
    expect(budget.signal.aborted).toBe(true);
  } finally {
    budget.finish();
  }
});

test('startup budget aborts an asset fetch before instance creation begins', async () => {
  const original = globalThis.fetch;
  let received: AbortSignal | undefined;
  globalThis.fetch = ((_source: unknown, options: RequestInit | undefined) => {
    received = options?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      received!.addEventListener('abort', () => reject(received!.reason), { once: true });
    });
  }) as typeof fetch;
  const budget = new StartupBudget(25);
  try {
    await expect(
      budget.prepare(loadAsset('https://example.invalid/runtime', 'runtime', budget.signal)),
    ).rejects.toThrow('exceeded');
    expect(received?.aborted).toBe(true);
  } finally {
    budget.finish();
    globalThis.fetch = original;
  }
});

test('shared preparation is cancelled only after its final waiting open leaves', async () => {
  const options = workerOpenOptions();
  options.runtime = { ...options.runtime, version: 'shared-budget-test' };
  let shared: AbortSignal | undefined;
  const prepare = (_options: typeof options, signal?: AbortSignal) => {
    shared = signal;
    return new Promise<PreparedWasixRuntime>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  };
  const first = new AbortController();
  const second = new AbortController();
  const a = prepareRuntimeCached(options, prepare, first.signal);
  const b = prepareRuntimeCached(options, prepare, second.signal);
  const firstFailure = a.catch((error: unknown) => error);
  first.abort(new Error('first'));
  expect(await firstFailure).toEqual(new Error('first'));
  expect(shared?.aborted).toBe(false);
  const secondFailure = b.catch((error: unknown) => error);
  second.abort(new Error('second'));
  expect(await secondFailure).toEqual(new Error('second'));
  expect(shared?.aborted).toBe(true);
});
