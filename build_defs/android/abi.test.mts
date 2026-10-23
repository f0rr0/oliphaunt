import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { inspectPlatformBinaryBuffer } from '../../tools/packaging/platform-binary-contract.mts';

for (const [name, target] of [
  ['arm64', 'android-arm64-v8a'],
  ['x86_64', 'android-x86_64'],
] as const) {
  test(`${target}: native ELF meets the Android platform policy`, () => {
    const label = `build_defs/android/libabi_smoke_${name}.so`;
    const bytes = readFileSync(label);
    const inspected = inspectPlatformBinaryBuffer(bytes, { target, label });
    expect(inspected.format).toBe('elf');
  });
}
