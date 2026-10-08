import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the shipped adapter and platform provider, not duplicate arithmetic.
const additions = readFileSync(
  new URL('./patches/0045-wasmer-wasix-correct-browser-clock-domains.patch', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1))
  .join('\n');
const sources = additions + readFileSync(new URL('./adapter/clock.rs', import.meta.url), 'utf8');
const javascript = [...sources.matchAll(/inline_js = r#"([\s\S]*?)"#/gu)]
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

// Import-only Wasm instances exercise real immutable import bindings, including
// a setter-only side module. They all use the same memory as a linked guest.
function clockModule(memory: WebAssembly.Memory, name: string, callback: Function) {
  const string = (value: string) => [value.length, ...Buffer.from(value)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const getter = name === 'clock_time_get';
  const namespace = getter ? 'wasi_snapshot_preview1' : 'wasix_32v1';
  const type = getter ? [0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f] : [0x60, 2, 0x7f, 0x7e, 1, 0x7f];
  const module = new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, ...type]),
      ...section(2, [
        2,
        ...string(namespace),
        ...string(name),
        0,
        0,
        ...string('env'),
        ...string('memory'),
        2,
        memory.buffer instanceof SharedArrayBuffer ? 3 : 1,
        1,
        2,
      ]),
      ...section(7, [1, ...string('call'), 0, 0]),
    ]),
  );
  return new WebAssembly.Instance(module, {
    [namespace]: { [name]: callback },
    env: { memory },
  }).exports.call as (...args: (number | bigint)[]) => number;
}

for (const clockId of [0, 1]) {
  test(`clock setter switches main, existing and late readers together: domain ${clockId}`, () => {
    let now = 100;
    const factories = runInNewContext(
      `${javascript}; ({read: oliphauntDirectClockImport, set: oliphauntClockSetImport})`,
      { Date: { now: () => now }, performance: { now: () => now } },
    );
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const offsets = [0n, 0n];
    let calls = 0;
    const fallback = (id: number, _precision: bigint, pointer: number) => {
      calls++;
      if (pointer > memory.buffer.byteLength - 8) return 28;
      new DataView(memory.buffer).setBigUint64(
        pointer,
        BigInt(now) * 1_000_000n + offsets[id],
        true,
      );
      return 0;
    };
    const main = clockModule(memory, 'clock_time_get', factories.read(memory, fallback));
    const side = clockModule(memory, 'clock_time_get', factories.read(memory, fallback));
    main(clockId, 0n, 0);
    side(clockId, 0n, 8);
    now++;
    main(clockId, 0n, 0);
    side(clockId, 0n, 8);
    assert.equal(calls, 2);
    const setter = clockModule(
      memory,
      'clock_time_set',
      factories.set(memory, (id: number, target: bigint) => {
        // Pending runtime work can reenter a reader before the offset is changed.
        const before = calls;
        main(id, 0n, 0);
        assert.equal(calls, before + 1);
        offsets[id] = target - BigInt(now) * 1_000_000n;
        return 0;
      }),
    );
    // Linking a setter is not a reason to abandon the fast path.
    main(clockId, 0n, 0);
    assert.equal(calls, 2);
    assert.equal(setter(clockId, 5_000_000_000n), 0);
    const late = clockModule(memory, 'clock_time_get', factories.read(memory, fallback));
    now++;
    for (const read of [main, side, late]) {
      const before = calls;
      assert.equal(read(clockId, 0n, 0), 0);
      assert.equal(calls, before + 1);
      assert.equal(new DataView(memory.buffer).getBigUint64(0, true), 5_001_000_000n);
    }
    // Other clock domains also use the same authoritative runtime after a set.
    const before = calls;
    main(1 - clockId, 0n, 0);
    assert.equal(calls, before + 1);
    memory.grow(1);
    assert.equal(late(clockId, 0n, 65_536), 0);
    assert.equal(new DataView(memory.buffer).getBigUint64(65_536, true), 5_001_000_000n);
    assert.equal(main(clockId, 0n, memory.buffer.byteLength), 28);

    const other = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const otherRead = clockModule(
      other,
      'clock_time_get',
      factories.read(other, () => 0),
    );
    otherRead(clockId, 0n, 0);
    let otherCalls = 0;
    const isolatedRead = factories.read(other, () => {
      otherCalls++;
      return 0;
    });
    isolatedRead(clockId, 0n, 0);
    isolatedRead(clockId, 0n, 0);
    assert.equal(otherCalls, 1, 'another database must retain its fast path');
  });
}

test('setter errors and traps propagate without reviving fast readers', () => {
  const factories = runInNewContext(
    `${javascript}; ({read: oliphauntDirectClockImport, set: oliphauntClockSetImport})`,
    { Date: { now: () => 100 }, performance: { now: () => 100 } },
  );
  for (const trap of [false, true]) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    let calls = 0;
    const read = clockModule(
      memory,
      'clock_time_get',
      factories.read(memory, () => {
        calls++;
        return 0;
      }),
    );
    const error = new Error('clock setter trap');
    const set = clockModule(
      memory,
      'clock_time_set',
      factories.set(memory, () => {
        if (trap) throw error;
        return 28;
      }),
    );
    read(0, 0n, 0);
    read(0, 0n, 0);
    assert.equal(calls, 1);
    if (trap)
      assert.throws(
        () => set(0, 1n),
        (thrown) => thrown === error,
      );
    else assert.equal(set(0, 1n), 28);
    read(0, 0n, 0);
    read(0, 0n, 0);
    assert.equal(calls, 3);
  }
});
