import { expect, test } from 'bun:test';
import {
  OperationBudget,
  normalizeAdmissionLimits,
  snapshotProtocolInput,
} from '../src/operation-budget.js';
import { binary, planQuery } from '../src/query.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('count admission precedes copying and releases after the owner settles', async () => {
  const budget = new OperationBudget();
  const owner = latch();
  for (let count = 0; count < 64; count++) {
    budget.admit(
      () => owner.promise,
      () => owner.promise,
    );
  }
  let copied = false;
  expect(() =>
    budget.admit(
      () => {
        copied = true;
        return owner.promise;
      },
      () => owner.promise,
    ),
  ).toThrow(/queue is full/);
  expect(copied).toBe(false);
  owner.resolve();
  await owner.promise;
  await budget.admit(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
});

test('byte admission includes inferred parameter snapshots and rejects before another copy', async () => {
  const budget = new OperationBudget();
  const owner = latch();
  budget.admit(
    (retain) => {
      retain(128 * 1024 * 1024);
      return owner.promise;
    },
    () => owner.promise,
  );
  const input = Uint8Array.of(1);
  expect(() =>
    budget.admit(
      (retain) => {
        snapshotProtocolInput(input, retain);
        return owner.promise;
      },
      () => owner.promise,
    ),
  ).toThrow(/queue is full/);
  owner.resolve();
  await owner.promise;
  let bytes = 0;
  const plan = planQuery('SELECT $1', [binary(new Uint8Array(1024))], {}, (count) => {
    bytes += count;
  });
  expect(plan.kind).toBe('describe');
  expect(bytes).toBe(1024 + plan.input.byteLength);
});

test.each([
  undefined,
  { maxPendingOperations: 1, highWaterMarkBytes: 8 },
])('deadline rejection retains admission until the queued closure releases its input', async (limits) => {
  const budget = new OperationBudget(limits);
  const owner = latch();
  const expired = new Error('expired before dispatch');
  const rejected = budget.admit(
    (retain) => {
      retain(128 * 1024 * 1024);
      return Promise.reject(expired);
    },
    () => owner.promise,
  );
  await expect(rejected).rejects.toBe(expired);
  expect(() =>
    budget.admit(
      () => Promise.resolve(),
      () => Promise.resolve(),
    ),
  ).toThrow(/queue is full/);
  owner.resolve();
  await owner.promise;
  await budget.admit(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
});

test('failed preparation releases its reservation and large single requests remain admissible', async () => {
  const budget = new OperationBudget();
  expect(() =>
    budget.admit(
      (retain) => {
        retain(8);
        throw new Error('invalid input');
      },
      () => Promise.resolve(),
    ),
  ).toThrow('invalid input');
  await budget.admit(
    (retain) => {
      retain(129 * 1024 * 1024);
      return Promise.resolve();
    },
    () => Promise.resolve(),
  );
});

test('explicit limits are immutable, complete, and validated before preparation', () => {
  const input = { maxPendingOperations: 2, highWaterMarkBytes: 8 };
  const limits = normalizeAdmissionLimits(input)!;
  input.maxPendingOperations = 99;
  expect(limits.maxPendingOperations).toBe(2);
  expect(Object.isFrozen(limits)).toBe(true);
  for (const value of [
    null,
    {},
    { maxPendingOperations: 1 },
    { maxPendingOperations: 1, highWaterMarkBytes: 0 },
    { maxPendingOperations: 1.5, highWaterMarkBytes: 8 },
    { maxPendingOperations: 1, highWaterMarkBytes: 8, typo: 1 },
  ]) {
    expect(() => normalizeAdmissionLimits(value as never)).toThrow();
  }
});

test('a configured watermark permits an oversized operation only alone, including zero-input work', async () => {
  const budget = new OperationBudget({ maxPendingOperations: 2, highWaterMarkBytes: 8 });
  const owner = latch();
  budget.admit(
    (retain) => {
      retain(9);
      return owner.promise;
    },
    () => owner.promise,
  );
  let prepared = false;
  expect(() =>
    budget.admit(
      () => {
        prepared = true;
        return owner.promise;
      },
      () => owner.promise,
    ),
  ).toThrow(/queue is full/);
  expect(prepared).toBe(false);
  owner.resolve();
  await owner.promise;
  await budget.admit(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
});

test('explicit byte admission precedes packet encoding and failed preparation releases once', async () => {
  const budget = new OperationBudget({ maxPendingOperations: 3, highWaterMarkBytes: 8 });
  const owner = latch();
  budget.admit(
    (retain) => {
      retain(7);
      return owner.promise;
    },
    () => owner.promise,
  );
  let encoded = false;
  expect(() =>
    budget.admit(
      (retain) => {
        budget.snapshotEncodedInput(retain, 2, () => {
          encoded = true;
          return Uint8Array.of(1, 2);
        });
        return owner.promise;
      },
      () => owner.promise,
    ),
  ).toThrow(/queue is full/);
  expect(encoded).toBe(false);
  // A failed reservation did not consume another slot or byte.
  budget.admit(
    (retain) => {
      retain(1);
      return owner.promise;
    },
    () => owner.promise,
  );
  owner.resolve();
  await owner.promise;
  await budget.admit(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
});

test('explicit admission releases before a sequential caller continues on success or owner error', async () => {
  const budget = new OperationBudget({ maxPendingOperations: 1, highWaterMarkBytes: 8 });
  for (const fail of [false, true, false]) {
    let tail!: Promise<unknown>;
    const operation = budget.admit(
      () => {
        const result = fail ? Promise.reject(new Error('owner failed')) : Promise.resolve();
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      () => tail,
    );
    if (fail) await expect(operation).rejects.toThrow('owner failed');
    else await operation;
  }
});

test('BEGIN reservation releases before callback work and owner-tail cleanup releases only once', async () => {
  const budget = new OperationBudget({ maxPendingOperations: 1, highWaterMarkBytes: 8 });
  const lease = latch();
  const callbackOwner = latch();
  await budget.admit(
    (retain, release) => {
      retain(9);
      release();
      release();
      return Promise.resolve();
    },
    () => lease.promise,
  );
  const callback = budget.admit(
    () => callbackOwner.promise,
    () => callbackOwner.promise,
  );
  lease.resolve();
  await lease.promise;
  expect(() =>
    budget.admit(
      () => Promise.resolve(),
      () => Promise.resolve(),
    ),
  ).toThrow(/queue is full/);
  callbackOwner.resolve();
  await callback;
  await budget.admit(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
});
