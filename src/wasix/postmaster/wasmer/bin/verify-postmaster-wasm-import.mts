#!/usr/bin/env bun
import { readFileSync } from 'node:fs';

const namespace = 'oliphaunt_postmaster_v1';
const valueTypes = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f, 0x69]);

export class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  byte(): number {
    if (this.offset >= this.data.length) throw new Error('truncated WebAssembly module');
    return this.data[this.offset++]!;
  }
  uleb(bits = 32): bigint {
    let value = 0n;
    for (let shift = 0; shift < bits; shift += 7) {
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (!(byte & 128)) {
        if (value >= 1n << BigInt(bits)) break;
        return value;
      }
    }
    throw new Error('out-of-range unsigned LEB');
  }
  size(): number {
    return Number(this.uleb());
  }
  take(size: number): Uint8Array {
    if (size > this.data.length - this.offset) throw new Error('truncated WebAssembly section');
    const bytes = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }
  name(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.size()));
  }
  valueType(): number {
    const value = this.byte();
    if (!valueTypes.has(value)) throw new Error(`unsupported value type ${value}`);
    return value;
  }
  limits(): number {
    const flags = this.size();
    if (flags & ~7) throw new Error('unsupported import limits flags');
    this.uleb(flags & 4 ? 64 : 32);
    if (flags & 1) this.uleb(flags & 4 ? 64 : 32);
    return flags;
  }
}

export function verify(data: Uint8Array): void {
  const reader = new Reader(data);
  if (!Buffer.from(reader.take(8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('not a core WebAssembly version-1 module');
  }
  const types: number[][][] = [];
  const imports: { module: string; name: string; type?: number }[] = [];
  const seen = new Set<number>();
  while (reader.offset < data.length) {
    const id = reader.byte();
    const section = new Reader(reader.take(reader.size()));
    if (id !== 1 && id !== 2) continue;
    if (seen.has(id)) throw new Error(`duplicate section ${id}`);
    seen.add(id);
    const count = section.size();
    for (let i = 0; i < count; i++) {
      if (id === 1) {
        if (section.byte() !== 0x60) throw new Error('non-function type in postmaster module');
        const signature: number[][] = [];
        for (let vector = 0; vector < 2; vector++) {
          const values: number[] = [];
          const length = section.size();
          for (let j = 0; j < length; j++) values.push(section.valueType());
          signature.push(values);
        }
        types.push(signature);
      } else {
        const entry: (typeof imports)[number] = { module: section.name(), name: section.name() };
        const kind = section.byte();
        switch (kind) {
          case 0:
            entry.type = section.size();
            break;
          case 1:
            section.valueType();
            section.limits();
            break;
          case 2:
            section.limits();
            break;
          case 3:
            section.valueType();
            section.byte();
            break;
          case 4:
            section.byte();
            section.size();
            break;
          default:
            throw new Error(`unknown import kind ${kind}`);
        }
        imports.push(entry);
      }
    }
    if (section.offset !== section.data.length) throw new Error(`trailing bytes in section ${id}`);
  }
  const named = imports.filter((entry) => entry.name === 'fd_sync_range');
  if (named.some((entry) => entry.module !== namespace))
    throw new Error('forbidden fd_sync_range import alias');
  if (named.length !== 1) throw new Error(`expected exactly one ${namespace}.fd_sync_range import`);
  const index = named[0]!.type;
  if (index === undefined || index >= types.length)
    throw new Error('invalid function type index for fd_sync_range');
  if (JSON.stringify(types[index]) !== '[[127,126,126,127],[127]]') {
    throw new Error('fd_sync_range signature must be (i32,i64,i64,i32)->(i32)');
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3)
      throw new Error('usage: verify-postmaster-wasm-import.mts POSTGRES_WASM');
    verify(readFileSync(process.argv[2]!));
    console.log(
      `verified required postmaster imports: ${namespace}.fd_sync_range(i32,i64,i64,i32)->(i32)`,
    );
  } catch (error) {
    console.error(`verify-postmaster-wasm-import: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
