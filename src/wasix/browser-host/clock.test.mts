import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the actual inline JavaScript shipped by the source patch, not a
// second implementation of its clock arithmetic.
const additions = readFileSync(
  new URL('./patches/0013-wasmer-wasix-fast-single-backend-clock.patch', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1))
  .join('\n');
const javascript = [...additions.matchAll(/inline_js = r#"([\s\S]*?)"#/gu)]
  .map((match) => match[1].replaceAll('export function ', 'function '))
  .join('\n');

test('canonical monotonic time shares an origin across workers', () => {
  const readClock = (timeOrigin: number, now: number) =>
    runInNewContext(`${javascript}; oliphaunt_monotonic_time_ms()`, {
      performance: { timeOrigin, now: () => now },
    });
  assert.equal(readClock(1_000, 100), readClock(1_050, 50));
  assert.equal(readClock(1_050, 51), 1_101);
});

test('direct clock preserves the canonical epoch and bounds fallback intervals', () => {
  let now = 100;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  let calls = 0;
  const fallback = (clockId: number, _precision: bigint, pointer: number) => {
    calls++;
    if (clockId > 1 || pointer > memory.buffer.byteLength - 8) return 28;
    new DataView(memory.buffer).setBigUint64(pointer, 9_000_000_000n, true);
    return 0;
  };
  const clock = runInNewContext(`${javascript}; oliphauntDirectClockImport(memory, fallback)`, {
    memory,
    fallback,
    Date: { now: () => now },
    performance: { now: () => now },
  });
  assert.equal(clock(1, 0n, 0), 0);
  now++;
  assert.equal(clock(1, 0n, 0), 0);
  assert.equal(new DataView(memory.buffer).getBigUint64(0, true), 9_001_000_000n);
  assert.equal(calls, 1);
  now += 16;
  clock(1, 0n, 0);
  assert.equal(calls, 2);
  for (let i = 0; i < 1024; i++) clock(1, 0n, 0);
  assert.equal(calls, 2);
  clock(1, 0n, 0);
  assert.equal(calls, 3);
  memory.grow(1);
  assert.equal(clock(1, 0n, 65_536), 0);
  assert.equal(new DataView(memory.buffer).getBigUint64(65_536, true), 9_000_000_000n);
  assert.equal(clock(1, 0n, memory.buffer.byteLength), 28);
  assert.equal(clock(2, 0n, 0), 28);
});

test('linking a setter preserves fast reads; calling it switches all shared-memory readers', () => {
  const factories = runInNewContext(
    `${javascript}; ({read: oliphauntDirectClockImport, set: oliphauntClockSetImport})`,
    { Date: { now: () => 100 }, performance: { now: () => 100 } },
  );
  for (const clockId of [0, 1]) {
    for (const errno of [0, 28]) {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
      let calls = 0;
      let time = 100_000_000n;
      const fallback = (_id: number, _precision: bigint, pointer: number) => {
        calls++;
        new DataView(memory.buffer).setBigUint64(pointer, time, true);
        return 0;
      };
      const main = factories.read(memory, fallback);
      const side = factories.read(memory, fallback);
      main(clockId, 0n, 0);
      side(clockId, 0n, 8);
      const setter = factories.set(memory, (_id: number, value: bigint) => {
        // WASIX can run pending work before updating its clock offset.
        const before = calls;
        main(clockId, 0n, 0);
        assert.equal(calls, before + 1);
        if (errno === 0) time = value;
        return errno;
      });
      main(clockId, 0n, 0);
      side(clockId, 0n, 8);
      assert.equal(calls, 2, 'importing the setter must not disable fast reads');
      assert.equal(setter(clockId, 5_000_000_000n), errno);
      const late = factories.read(memory, fallback);
      memory.grow(1);
      for (const read of [main, side, late]) {
        const before = calls;
        read(clockId, 0n, 65_536);
        assert.equal(calls, before + 1);
        assert.equal(new DataView(memory.buffer).getBigUint64(65_536, true), time);
      }
      const other = new WebAssembly.Memory({ initial: 1 });
      const independent = factories.read(other, () => {
        calls++;
        return 0;
      });
      const before = calls;
      independent(clockId, 0n, 0);
      independent(clockId, 0n, 0);
      assert.equal(calls, before + 1, 'unrelated databases keep their fast path');
    }
  }
});
