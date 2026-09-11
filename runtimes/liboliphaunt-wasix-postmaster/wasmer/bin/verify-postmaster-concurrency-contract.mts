#!/usr/bin/env bun
// Verify the final linked module, after optimizers could erase synchronization.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, fchmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { atomicFile } from '../../lib/linear-memory-transaction.mts';
import { Reader } from './verify-postmaster-wasm-import.mts';

const schema = 'oliphaunt.wasix-postmaster.final-wasm-concurrency.v1';
const packed = 'packed-atomic-v1';
export const fences = { SetLatch: 2, ResetLatch: 1, WaitEventSetWait: 1 };
const opcodes = [
  'atomic.fence',
  'i32.atomic.load',
  'i32.atomic.rmw.and',
  'i32.atomic.rmw.or',
] as const;
type Counts = Record<(typeof opcodes)[number], number>;
type Inventory = { total: Counts; functions: Record<string, Counts> };
const empty = (): Counts => ({
  'atomic.fence': 0,
  'i32.atomic.load': 0,
  'i32.atomic.rmw.and': 0,
  'i32.atomic.rmw.or': 0,
});
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const requireDigest = (value: string) =>
  assert(/^[0-9a-f]{64}$/u.test(value), 'invalid concurrency SHA-256');
const done = (reader: Reader) =>
  assert.equal(reader.offset, reader.data.length, 'trailing section bytes');
const numericFields = {
  atomic_fence_total: ['atomic.fence'],
  atomic_fence_set_latch: ['atomic.fence', 'SetLatch'],
  atomic_fence_reset_latch: ['atomic.fence', 'ResetLatch'],
  atomic_fence_wait_event_set_wait: ['atomic.fence', 'WaitEventSetWait'],
  i32_atomic_load_total: ['i32.atomic.load'],
  i32_atomic_load_wait_event_set_wait: ['i32.atomic.load', 'WaitEventSetWait'],
  i32_atomic_rmw_and_total: ['i32.atomic.rmw.and'],
  i32_atomic_rmw_and_reset_latch: ['i32.atomic.rmw.and', 'ResetLatch'],
  i32_atomic_rmw_and_wait_event_set_wait: ['i32.atomic.rmw.and', 'WaitEventSetWait'],
  i32_atomic_rmw_or_total: ['i32.atomic.rmw.or'],
  i32_atomic_rmw_or_set_latch: ['i32.atomic.rmw.or', 'SetLatch'],
  i32_atomic_rmw_or_wait_event_set_wait: ['i32.atomic.rmw.or', 'WaitEventSetWait'],
} as const;
const receiptKeys = [
  'schema',
  'postgres_sha256',
  'wasm_dis_sha256',
  'wasm_dis_version',
  'latch_state_contract',
  ...Object.keys(numericFields),
];

export function structure(data: Uint8Array) {
  const reader = new Reader(data);
  assert(
    Buffer.from(reader.take(8)).equals(Buffer.from('0061736d01000000', 'hex')),
    'not a core WebAssembly version-1 module',
  );
  const sections = new Map<number, Reader>();
  while (reader.offset < data.length) {
    const id = reader.byte(),
      section = new Reader(reader.take(reader.size()));
    if (id === 0) continue;
    assert(!sections.has(id), `duplicate section ${id}`);
    sections.set(id, section);
  }
  for (const id of [2, 3, 7, 10]) assert(sections.has(id), `missing section ${id}`);
  const imports = sections.get(2)!;
  const memories: number[] = [];
  let imported = 0;
  for (let count = imports.size(); count > 0; count--) {
    const module = imports.name(),
      name = imports.name();
    switch (imports.byte()) {
      case 0:
        imports.size();
        imported++;
        break;
      case 1:
        imports.byte();
        imports.limits();
        break;
      case 2: {
        const flags = imports.limits();
        if (module === 'env' && name === 'memory') memories.push(flags);
        break;
      }
      case 3:
        imports.byte();
        imports.byte();
        break;
      case 4:
        imports.byte();
        imports.size();
        break;
      default:
        throw new Error('unknown import kind');
    }
  }
  done(imports);
  assert(
    memories.length === 1 && memories[0]! & 2,
    'env.memory is not declared shared exactly once',
  );
  const functions = sections.get(3)!;
  const defined = functions.size();
  for (let i = 0; i < defined; i++) functions.size();
  done(functions);
  const exports = sections.get(7)!,
    indices = new Map<string, number>();
  for (let count = exports.size(); count > 0; count--) {
    const name = exports.name(),
      kind = exports.byte(),
      index = exports.size();
    if (kind !== 0) continue;
    assert(!indices.has(name), `duplicate function export ${name}`);
    indices.set(name, index);
  }
  done(exports);
  const code = sections.get(10)!;
  assert.equal(code.size(), defined, 'function/code count mismatch');
  const bodies: Uint8Array[] = [];
  for (let i = 0; i < defined; i++) bodies.push(code.take(code.size()));
  done(code);
  const critical: Record<string, Uint8Array> = {};
  for (const name of Object.keys(fences)) {
    const index = indices.get(name);
    assert(
      index !== undefined && index >= imported && index - imported < defined,
      `${name} does not refer to a defined function`,
    );
    critical[name] = bodies[index - imported]!;
  }
  return { bodies, critical };
}
export async function watInventory(
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<Inventory> {
  const targets = new Map<string, string>(),
    exports = new Set<string>(),
    seen = new Set<string>();
  const inventory: Inventory = {
    total: empty(),
    functions: Object.fromEntries(Object.keys(fences).map((name) => [name, empty()])),
  };
  let current: string | undefined;
  for await (const raw of lines) {
    const line = raw.replace(/\n$/u, '');
    assert(!line.includes('\r'), 'wasm-dis emitted non-canonical CR text');
    const exported = /^ \(export "([^"]+)" \(func (\$[^ ()]+)\)\)$/u.exec(line);
    if (exported && Object.hasOwn(fences, exported[1]!)) {
      const [, name, id] = exported;
      assert(!exports.has(name!), `duplicate export ${name}`);
      assert(!targets.has(id!), 'critical exports share one function identifier');
      exports.add(name!);
      targets.set(id!, name!);
    }
    const fn = /^ \(func (\$[^ ()]+)(?:[ ()]|$)/u.exec(line);
    if (fn) {
      current = targets.get(fn[1]!);
      if (current) {
        assert(!seen.has(current), `duplicate function body ${current}`);
        seen.add(current);
      }
    }
    const opcode =
      /^ +\((atomic\.fence|i32\.atomic\.load|i32\.atomic\.rmw\.and|i32\.atomic\.rmw\.or)\b/u.exec(
        line,
      )?.[1] as (typeof opcodes)[number] | undefined;
    if (opcode) {
      inventory.total[opcode]++;
      if (current) inventory.functions[current]![opcode]++;
    }
    if (line === ' )') current = undefined;
  }
  assert.equal(exports.size, 3, 'wasm-dis lacks critical exports');
  assert.equal(seen.size, 3, 'wasm-dis lacks critical function bodies');
  return inventory;
}
export function checkInventory(inventory: Inventory, expected?: number, packedContract = true) {
  const { total, functions } = inventory;
  if (expected !== undefined)
    assert.equal(total['atomic.fence'], expected, 'module fence total differs');
  for (const [name, count] of Object.entries(fences))
    assert.equal(functions[name]!['atomic.fence'], count, `${name} atomic.fence differs`);
  assert(total['atomic.fence'] >= 4, 'module has too few fences');
  if (!packedContract) return;
  for (const [name, opcode, count] of [
    ['SetLatch', 'i32.atomic.rmw.or', 1],
    ['ResetLatch', 'i32.atomic.rmw.and', 1],
    ['WaitEventSetWait', 'i32.atomic.rmw.and', 2],
    ['WaitEventSetWait', 'i32.atomic.rmw.or', 1],
  ] as const)
    assert.equal(functions[name]![opcode], count, `${name} ${opcode} differs`);
  assert(
    functions.WaitEventSetWait!['i32.atomic.load'] >= 1,
    'waiter needs at least one atomic load',
  );
}
export function receipt(data: Uint8Array, inventory: Inventory, disHash: string, version: string) {
  requireDigest(disHash);
  assert(version && !/[\r\n]/u.test(version), 'wasm-dis must provide one canonical version line');
  const values: Record<string, string | number> = {
    schema,
    postgres_sha256: digest(data),
    wasm_dis_sha256: disHash,
    wasm_dis_version: version,
    latch_state_contract: packed,
  };
  for (const [key, [opcode, name]] of Object.entries(numericFields))
    values[key] = name ? inventory.functions[name]![opcode] : inventory.total[opcode];
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}
export function verifyReceipt(contents: string, data: Uint8Array, expected?: number) {
  assert(contents.endsWith('\n') && !contents.includes('\r'), 'non-canonical receipt text');
  const lines = contents.slice(0, -1).split('\n');
  assert.equal(lines.length, receiptKeys.length, 'receipt field count differs');
  const values: Record<string, string> = {};
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator),
      value = line.slice(separator + 1);
    assert(separator > 0 && key === receiptKeys[index] && value, 'non-canonical receipt field');
    values[key] = value;
  }
  assert.equal(values.schema, schema, 'receipt schema differs');
  assert.equal(values.latch_state_contract, packed, 'receipt latch contract differs');
  requireDigest(values.postgres_sha256!);
  requireDigest(values.wasm_dis_sha256!);
  assert.equal(values.postgres_sha256, digest(data), 'receipt does not identify PostgreSQL module');
  const numbers: Record<string, bigint> = {};
  for (const key of Object.keys(numericFields)) {
    assert(/^(0|[1-9][0-9]*)$/u.test(values[key]!), `${key} is not a canonical integer`);
    numbers[key] = BigInt(values[key]!);
  }
  if (expected !== undefined)
    assert.equal(numbers.atomic_fence_total, BigInt(expected), 'receipt fence total differs');
  for (const [key, value] of Object.entries({
    atomic_fence_set_latch: 2n,
    atomic_fence_reset_latch: 1n,
    atomic_fence_wait_event_set_wait: 1n,
    i32_atomic_rmw_and_reset_latch: 1n,
    i32_atomic_rmw_and_wait_event_set_wait: 2n,
    i32_atomic_rmw_or_set_latch: 1n,
    i32_atomic_rmw_or_wait_event_set_wait: 1n,
  }))
    assert.equal(numbers[key], value, `receipt contract differs: ${key}`);
  assert(
    numbers.i32_atomic_load_wait_event_set_wait! >= 1n &&
      numbers.i32_atomic_load_total! >= numbers.i32_atomic_load_wait_event_set_wait! &&
      numbers.i32_atomic_rmw_and_total! >= 3n &&
      numbers.i32_atomic_rmw_or_total! >= 2n,
    'receipt atomic totals are inconsistent',
  );
  return values;
}
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        'expected-total': { type: 'string' },
        'latch-state-contract': { type: 'string', default: 'upstream-sig-atomic-v1' },
        'wasm-dis-output': { type: 'string' },
        receipt: { type: 'string' },
        'verified-receipt': { type: 'string' },
        'receipt-only': { type: 'boolean' },
      },
    });
    assert.equal(positionals.length, 1, 'one PostgreSQL module is required');
    const expected =
      values['expected-total'] === undefined ? undefined : Number(values['expected-total']);
    assert(
      expected === undefined || (Number.isSafeInteger(expected) && expected >= 4),
      '--expected-total must be at least four',
    );
    const contract = values['latch-state-contract'];
    assert([packed, 'upstream-sig-atomic-v1'].includes(contract!), 'unknown latch contract');
    const disassembly = values['wasm-dis-output'],
      verified = values['verified-receipt'];
    assert(!(disassembly && verified), 'disassembly and verified receipt are exclusive');
    assert(
      contract !== packed || disassembly || verified,
      'packed contract requires disassembly or verified receipt',
    );
    assert(
      !values.receipt || (disassembly && contract === packed),
      'receipt requires packed disassembly',
    );
    assert(
      !values['receipt-only'] ||
        (verified &&
          expected !== undefined &&
          contract === packed &&
          !disassembly &&
          !values.receipt),
      'receipt-only requires a packed verified receipt and expected total',
    );
    const data = readFileSync(positionals[0]!);
    let total: string | number;
    if (verified) {
      if (!values['receipt-only']) structure(data);
      const checked = verifyReceipt(readFileSync(verified, 'utf8'), data, expected);
      total = checked.atomic_fence_total!;
    } else {
      const module = structure(data);
      if (disassembly) {
        const input = createReadStream(disassembly);
        const decoder = new TextDecoderStream('utf-8', { fatal: true });
        const stream = Readable.toWeb(input)
          .pipeThrough(decoder)
          .pipeThrough(
            new TransformStream<string, string>({
              transform(chunk, controller) {
                assert(!chunk.includes('\r'), 'wasm-dis emitted non-canonical CR text');
                controller.enqueue(chunk);
              },
            }),
          );
        const lines = createInterface({ input: Readable.fromWeb(stream), crlfDelay: Infinity });
        try {
          const iterator = lines[Symbol.asyncIterator]();
          const disHash = (await iterator.next()).value,
            version = (await iterator.next()).value;
          assert(
            typeof disHash === 'string' && typeof version === 'string',
            'missing Binaryen identity',
          );
          requireDigest(disHash);
          assert(version, 'missing Binaryen version');
          const inventory = await watInventory({ [Symbol.asyncIterator]: () => iterator });
          checkInventory(inventory, expected, contract === packed);
          total = inventory.total['atomic.fence'];
          if (values.receipt) {
            const contents = receipt(data, inventory, disHash, version);
            atomicFile(values.receipt, (fd) => {
              writeFileSync(fd, contents);
              fchmodSync(fd, 0o444);
            });
          }
        } finally {
          lines.close();
          input.destroy();
        }
      } else {
        // Only legacy unsealed development profiles use byte inventory. Packed
        // release profiles always use Binaryen's decoded instructions above.
        const count = (bytes: Uint8Array) => {
          const body = Buffer.from(bytes);
          let result = 0;
          const fence = Buffer.from([254, 3, 0]);
          for (
            let offset = body.indexOf(fence);
            offset !== -1;
            offset = body.indexOf(fence, offset + 3)
          )
            result++;
          return result;
        };
        for (const [name, required] of Object.entries(fences))
          assert.equal(count(module.critical[name]!), required, `${name} fence count differs`);
        total = module.bodies.reduce((sum, body) => sum + count(body), 0);
        if (expected !== undefined) assert.equal(total, expected, 'module fence total differs');
      }
    }
    console.log(
      `verified PostgreSQL Wasm concurrency contract: total=${total} SetLatch=2 ResetLatch=1 WaitEventSetWait=1`,
    );
  } catch (error) {
    console.error(`verify-postmaster-concurrency-contract: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
