import { expect, test } from 'bun:test';
import { OperationBudget, snapshotProtocolInput } from '../src/operation-budget.js';
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

test('deadline rejection retains admission until the queued closure releases its input', async () => {
  const budget = new OperationBudget();
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
