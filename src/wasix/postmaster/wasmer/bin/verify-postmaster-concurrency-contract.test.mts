import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fences,
  structure,
  watInventory,
  checkInventory,
  receipt,
  verifyReceipt,
} from './verify-postmaster-concurrency-contract.mts';

import { minimalPostmaster as moduleBytes } from '../../testdata/minimal-postmaster.mts';
export function packedWat(loads = 1, ands = 2) {
  return [
    ' (export "SetLatch" (func $19))',
    ' (export "ResetLatch" (func $20))',
    ' (export "WaitEventSetWait" (func $21))',
    ' (data $0 (i32.const 0) "(atomic.fence) is data, not code")',
    ' (func $19 (param $0 i32)',
    '  (atomic.fence)',
    '  (i32.atomic.rmw.or (local.get $0) (i32.const 1))',
    '  (atomic.fence)',
    ' )',
    ' (func $20 (param $0 i32)',
    '  (i32.atomic.rmw.and (local.get $0) (i32.const -2))',
    '  (atomic.fence)',
    ' )',
    ' (func $21 (param $0 i32)',
    '  (i32.atomic.rmw.or (local.get $0) (i32.const 2))',
    ...Array.from({ length: loads }, () => '  (i32.atomic.load (local.get $0))'),
    ...Array.from({ length: ands }, () => '  (i32.atomic.rmw.and (local.get $0) (i32.const -3))'),
    '  (atomic.fence)',
    ' )',
  ];
}
test('verifies final-module structure and decoded latch atomics, rejecting drift and aliases', async () => {
  const data = moduleBytes(true, true);
  assert.equal(structure(data).bodies.length, 4);
  assert.throws(() => structure(moduleBytes(false)), /shared/);
  assert.throws(() => structure(data.subarray(0, -1)), /truncated/);
  assert.throws(
    () => structure(Buffer.concat([data, Buffer.from([3, 1, 0])])),
    /duplicate section/,
  );
  const inventory = await watInventory(packedWat());
  assert.equal(inventory.total['atomic.fence'], 4);
  checkInventory(inventory, 4);
  assert.throws(() => checkInventory(inventory, 5), /total differs/);
  assert.throws(
    () =>
      checkInventory({
        ...inventory,
        functions: {
          ...inventory.functions,
          SetLatch: { ...inventory.functions.SetLatch!, 'atomic.fence': 1 },
        },
      }),
    /SetLatch/,
  );
  for (const [loads, ands] of [
    [0, 2],
    [1, 1],
  ]) {
    const invalid = await watInventory(packedWat(loads, ands));
    assert.throws(() => checkInventory(invalid));
  }
  await assert.rejects(
    watInventory(
      packedWat().map((line) => line.replace('"SetLatch" (func $19)', '"SetLatch" (func $20)')),
    ),
    /share one/,
  );
  await assert.rejects(watInventory(packedWat().map((line) => `${line}\r`)), /CR text/);
  await assert.rejects(
    watInventory(packedWat().filter((line) => !line.startsWith(' (func $19'))),
    /function bodies/,
  );
});

test('receipt binds exact module bytes and preserves exact numeric and field contracts', async () => {
  const data = moduleBytes();
  const text = receipt(
    data,
    await watInventory(packedWat()),
    '2'.repeat(64),
    'wasm-dis version 130',
  );
  assert.equal(verifyReceipt(text, data, 4).atomic_fence_total, '4');
  for (const changed of [
    text.replace('i32_atomic_rmw_or_set_latch=1', 'i32_atomic_rmw_or_set_latch=0'),
    text.replace('atomic_fence_total=4', 'atomic_fence_total=04'),
    text.replace('atomic_fence_total=4', 'atomic_fence_total=4.0'),
    text.replace('i32_atomic_load_total=1', 'i32_atomic_load_total=0'),
    text.replace('schema=', 'extra='),
    text.slice(0, -1),
    text.replaceAll('\n', '\r\n'),
  ])
    assert.throws(() => verifyReceipt(changed, data, 4));
  assert.throws(() => verifyReceipt(text, moduleBytes(true, true), 4), /does not identify/);
});
