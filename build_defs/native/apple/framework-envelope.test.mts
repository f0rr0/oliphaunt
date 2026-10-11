import { expect, test } from 'bun:test';
import { inspectDynamicFrameworkBinary, runtimeContentIdentity } from './framework-envelope.mts';

// Independent minimal physical Mach-O fixture; no filename/header inference.
function image(platform: number, minimum: number, type = 6): Buffer {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(type, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(platform, 40);
  bytes.writeUInt32LE(minimum << 16, 44);
  bytes.writeUInt32LE(minimum << 16, 48);
  return bytes;
}

test('the public framework admits actual dynamic binaries for all three Apple slices', () => {
  for (const [target, platform, minimum] of [
    ['macos-arm64', 1, 14],
    ['ios-arm64', 2, 17],
    ['ios-arm64-simulator', 7, 17],
  ] as const)
    expect(inspectDynamicFrameworkBinary(image(platform, minimum), target).slices).toHaveLength(1);
});

test('a static object, swapped device/simulator image or incompatible OS floor cannot replace the public framework', () => {
  expect(() => inspectDynamicFrameworkBinary(image(2, 17, 1), 'ios-arm64')).toThrow(/MH_DYLIB/u);
  expect(() => inspectDynamicFrameworkBinary(image(7, 17), 'ios-arm64')).toThrow(
    /platform disagrees/u,
  );
  expect(() => inspectDynamicFrameworkBinary(image(2, 18), 'ios-arm64')).toThrow(/minimum/u);
  expect(() => inspectDynamicFrameworkBinary(Buffer.from('!<arch>\n'), 'ios-arm64')).toThrow();
});

test('runtime identity commits content and public names, independent of source location and entry order', () => {
  const header = Buffer.from('public ABI');
  const runtime = Buffer.from('dynamic runtime');
  const first = runtimeContentIdentity(
    { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': runtime },
    { domain: 'ios-datum64' },
  );
  expect(first).toBe(
    runtimeContentIdentity(
      { 'runtime/liboliphaunt': runtime, 'Headers/oliphaunt.h': header },
      { domain: 'ios-datum64' },
    ),
  );
  expect(first).toMatch(/^apple-runtime-[0-9a-f]{64}$/u);
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': Buffer.from('changed runtime') },
      { domain: 'ios-datum64' },
    ),
  );
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': runtime },
      { domain: 'macos-arm64' },
    ),
  );
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/other.h': header, 'runtime/liboliphaunt': runtime },
      { domain: 'ios-datum64' },
    ),
  );
  for (const name of ['/sandbox/runtime', '../runtime', 'runtime\\file', 'runtime/./file'])
    expect(() => runtimeContentIdentity({ [name]: runtime }, {})).toThrow(/public relative paths/u);
});
