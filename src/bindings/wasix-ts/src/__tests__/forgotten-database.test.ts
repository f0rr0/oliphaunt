import { describe, expect, it, vi } from 'vitest';

import {
  WasixDatabaseImpl,
  WasixForgottenDatabaseRegistry,
  type WasixDatabaseSession,
} from '../database.js';

describe('WASIX forgotten database cleanup', () => {
  it('keeps the held generation owner-free and schedules worker termination nonblocking', async () => {
    const harness = finalizerHarness();
    const work: Array<() => void> = [];
    const abort = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const registry = new WasixForgottenDatabaseRegistry(harness.create, (operation) =>
      work.push(operation),
    );
    const owner = {};
    const registration = registry.register(owner, session({ abort, close }));

    expect(harness.registered).toMatchObject({ target: owner });
    expect(harness.registered?.heldValue).toBe(registration.generation);
    expect(harness.registered?.unregisterToken).toBe(registration.generation);
    expect(registration.generation).not.toBe(owner);
    expect(Object.keys(registration.generation)).toEqual([]);
    expect(Object.isFrozen(registration.generation)).toBe(true);

    harness.finalize(registration.generation);
    expect(abort).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(work).toHaveLength(1);

    work.shift()?.();
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  it('best-effort closes caller-realm sessions and absorbs their failure', async () => {
    const harness = finalizerHarness();
    const work: Array<() => void> = [];
    const failure = new Error('direct storage close failed');
    const close = vi.fn(async () => {
      throw failure;
    });
    const registry = new WasixForgottenDatabaseRegistry(harness.create, (operation) =>
      work.push(operation),
    );
    const registration = registry.register({}, session({ close }));

    harness.finalize(registration.generation);
    expect(close).not.toHaveBeenCalled();
    work.shift()?.();
    expect(close).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('makes an unregistered or already-claimed generation a harmless stale no-op', () => {
    const harness = finalizerHarness();
    const work: Array<() => void> = [];
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const registry = new WasixForgottenDatabaseRegistry(harness.create, (operation) =>
      work.push(operation),
    );
    const first = registry.register({}, session({ close: firstClose }));
    registry.unregister(first);
    const second = registry.register({}, session({ close: secondClose }));

    harness.finalize(first.generation);
    expect(work).toEqual([]);
    expect(harness.unregistered).toEqual([first.generation]);

    harness.finalize(second.generation);
    harness.finalize(second.generation);
    expect(work).toHaveLength(1);
    work.shift()?.();
    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('revokes forgotten cleanup when explicit close claims the public handle', async () => {
    const harness = finalizerHarness();
    const work: Array<() => void> = [];
    const close = vi.fn(async () => undefined);
    const registry = new WasixForgottenDatabaseRegistry(harness.create, (operation) =>
      work.push(operation),
    );
    const database = new WasixDatabaseImpl(session({ close }), registry);
    const generation = harness.registered?.heldValue;
    if (generation === undefined) throw new Error('database did not register finalizer cleanup');

    await database.close();
    expect(close).toHaveBeenCalledOnce();
    expect(harness.unregistered).toEqual([generation]);

    harness.finalize(generation);
    expect(work).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });
});

function session(
  lifecycle: Pick<WasixDatabaseSession, 'close'> & Partial<Pick<WasixDatabaseSession, 'abort'>>,
): WasixDatabaseSession {
  return {
    async exec(input) {
      return input;
    },
    async sync() {},
    ...lifecycle,
  };
}

function finalizerHarness() {
  let cleanup: ((heldValue: object) => void) | undefined;
  let registered:
    | Readonly<{
        target: object;
        heldValue: object;
        unregisterToken: object;
      }>
    | undefined;
  const unregistered: object[] = [];
  return {
    create(callback: (heldValue: object) => void) {
      cleanup = callback;
      return {
        register(target: object, heldValue: object, unregisterToken: object) {
          registered = { target, heldValue, unregisterToken };
        },
        unregister(unregisterToken: object) {
          unregistered.push(unregisterToken);
          return true;
        },
      };
    },
    finalize(heldValue: object) {
      if (cleanup === undefined) throw new Error('finalizer was not installed');
      cleanup(heldValue);
    },
    get registered() {
      return registered;
    },
    get unregistered() {
      return unregistered;
    },
  };
}
