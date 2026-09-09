import { expect, test } from 'vitest';
import { snapshotNativeExtensions, snapshotNativeIcu } from '@oliphaunt/js-core/resources';
import { extensions } from '../extensions.js';
import { directory } from '../storage/node.js';

const vector = {
  schema: 'oliphaunt-native-extension-v1' as const,
  sqlName: 'vector',
  product: 'oliphaunt-extension-vector',
  packageName: '@oliphaunt/extension-vector',
  version: '0.8.2',
};

test('resource selection is explicit and snapshots imported values', () => {
  expect(snapshotNativeExtensions([])).toEqual([]);
  const selected = snapshotNativeExtensions([vector, extensions.hstore]);
  expect(selected.map((item) => item.sqlName)).toEqual(['vector', 'hstore']);
  expect(Object.isFrozen(selected[0])).toBe(true);
  expect(selected[0]).not.toBe(vector);
  expect(snapshotNativeIcu(undefined)).toBeUndefined();
});

test('resource selection rejects raw names, wrong runtimes, and conflicting versions', () => {
  expect(() => snapshotNativeExtensions(['vector'] as never)).toThrow(/descriptors/);
  expect(() =>
    snapshotNativeExtensions([{ ...vector, schema: 'oliphaunt-wasix-extension-v1' }] as never),
  ).toThrow();
  expect(() => snapshotNativeExtensions([vector, { ...vector, version: '0.8.3' }])).toThrow(
    /conflicting/,
  );
  expect(() => snapshotNativeExtensions([{ ...vector, version: undefined }])).toThrow(/version/);
  expect(() => snapshotNativeIcu(true as never)).toThrow(/descriptor/);
});

test('Node directory follows filesystem string and URL conventions', () => {
  expect(directory(new URL('file:///tmp/my%20db'))).toEqual(directory('/tmp/my db'));
  expect(directory('file:///tmp/db')).toEqual({ kind: 'directory', path: 'file:///tmp/db' });
  expect(() => directory(new URL('https://example.com/db'))).toThrow();
  expect(() => directory('\0')).toThrow();
});
