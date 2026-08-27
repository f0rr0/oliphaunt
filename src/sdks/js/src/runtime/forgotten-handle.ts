/**
 * A private, exact-handle leak guard for process-owning runtime adapters.
 *
 * The held record never contains the public facade or its release callback.
 * A per-registration generation makes an old callback a no-op after explicit
 * unregister or after the same handle is registered for a newer owner.
 */
export function createForgottenRuntimeHandleCleanup<Handle extends object>(
  cleanup: (handle: Handle) => Promise<void>,
): {
  register(owner: object, handle: Handle): void;
  unregister(owner: object): void;
} {
  type Lease = {
    state: 'active' | 'claimed' | 'retired';
  };
  type Held = {
    readonly handle: Handle;
    readonly generation: Lease;
  };

  const leaseByHandle = new WeakMap<Handle, Lease>();
  const heldByOwner = new WeakMap<object, Held>();
  const registry = new FinalizationRegistry<Held>((held) => {
    if (held.generation.state !== 'active' || leaseByHandle.get(held.handle) !== held.generation) {
      return;
    }
    held.generation.state = 'claimed';

    // Do not enter process or socket teardown from the finalizer job itself.
    void Promise.resolve()
      .then(async () => {
        if (
          held.generation.state !== 'claimed' ||
          leaseByHandle.get(held.handle) !== held.generation
        ) {
          return;
        }
        held.generation.state = 'retired';
        leaseByHandle.delete(held.handle);
        await cleanup(held.handle);
      })
      .catch(() => {
        // Garbage-collection cleanup is deliberately unobservable best effort.
      });
  });

  return {
    register(owner: object, handle: Handle): void {
      const previous = leaseByHandle.get(handle);
      if (previous !== undefined) previous.state = 'retired';
      const lease: Lease = { state: 'active' };
      const held = Object.freeze({ handle, generation: lease });
      leaseByHandle.set(handle, lease);
      heldByOwner.set(owner, held);
      try {
        registry.register(owner, held, owner);
      } catch (error) {
        if (leaseByHandle.get(handle) === lease) {
          lease.state = 'retired';
          leaseByHandle.delete(handle);
        }
        heldByOwner.delete(owner);
        throw error;
      }
    },

    unregister(owner: object): void {
      const held = heldByOwner.get(owner);
      if (held !== undefined && leaseByHandle.get(held.handle) === held.generation) {
        held.generation.state = 'retired';
        leaseByHandle.delete(held.handle);
      }
      heldByOwner.delete(owner);
      registry.unregister(owner);
    },
  };
}
