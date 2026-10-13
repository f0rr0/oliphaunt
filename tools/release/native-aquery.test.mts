import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShippingInputView, configuredAqueryTargetInputs } from './bazel-shipping-inputs.mts';
import { nativeAqueryType, readNativeAquery } from './native-aquery.mts';

const version = '8.8.1';
const file = (name: string) =>
  fileURLToPath(new URL(`./fixtures/aquery-bazel-8.8.1/${name}`, import.meta.url));

test('full original upstream schemas retain their pinned bytes and license headers', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('./bazel-8.8.1/sources.json', import.meta.url), 'utf8'),
  );
  expect(snapshot.bazelVersion).toBe(version);
  for (const source of snapshot.files) {
    const bytes = readFileSync(new URL(`./bazel-8.8.1/${source.file}`, import.meta.url));
    expect(bytes.length).toBe(source.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    expect(bytes.toString('utf8')).toContain('Licensed under the Apache License, Version 2.0');
  }
});

test('genuine stock protobuf and JSON preserve configured TestRunner and FileWrite semantics', () => {
  const protobuf = readNativeAquery(file('aquery.pb'), 'proto', version) as any;
  const json = readNativeAquery(file('aquery.json'), 'jsonproto', version) as any;
  const label = '//src/query/ts:unit_test';
  const configuration = (graph: any) => {
    const target = graph.targets.find((row: any) => row.label.replace(/^@@?\/\//u, '//') === label);
    const test = graph.actions.find(
      (row: any) => row.targetId === target.id && row.mnemonic === 'TestRunner',
    );
    return graph.configuration.find((row: any) => row.id === test.configurationId).checksum;
  };
  expect(configuration(protobuf)).toBe(configuration(json));
  const inputs = (graph: any) => {
    const actual = configuredAqueryTargetInputs(graph, label, configuration(graph));
    return { inputs: [...actual.inputs].sort(), written: [...actual.written].sort() };
  };
  expect(inputs(protobuf)).toEqual(inputs(json));
  expect(inputs(protobuf).inputs.length).toBeGreaterThan(0);
  expect(inputs(protobuf).written.length).toBeGreaterThan(0);
  expect(protobuf.actions.length).toBe(json.actions.length);
  expect(protobuf.artifacts.length).toBe(json.artifacts.length);
  // Use the real stock JSON model as the schema conversion control. Independent
  // raw query IDs/order may differ because the stock proto emitter is parallel.
  const type = nativeAqueryType(version);
  expect(type.toObject(type.decode(type.encode(type.fromObject(json)).finish()))).toEqual(json);
});

test('genuine shipping metadata resolves the same complete package inputs and producer actions', () => {
  const root = JSON.parse(readFileSync(file('shipping_package.shipping.json'), 'utf8'));
  // Adapt the actual emitted NativeRoot to the existing input-view API. All
  // product/version/output/owner values come from that genuine constructor File.
  const exported = {
    schema: 'oliphaunt-bazel-shipping-v1',
    scope: 'construction',
    packages: [root.package],
  };
  const protobuf = buildShippingInputView(
    exported,
    readNativeAquery(file('aquery.pb'), 'proto', version),
  );
  const json = buildShippingInputView(
    exported,
    readNativeAquery(file('aquery.json'), 'jsonproto', version),
  );
  expect(protobuf).toEqual(json);
  expect(protobuf.products[root.package.product].inputs.length).toBeGreaterThan(0);
  expect(protobuf.products[root.package.product].actions.length).toBeGreaterThan(0);
  expect(protobuf.physicalInputs.length).toBeGreaterThan(0);
});

test('historical JSON reading preserves its original graph without requiring a proto schema', () => {
  expect(readNativeAquery(file('aquery.json'), 'jsonproto', 'historical-bazel')).toEqual(
    JSON.parse(readFileSync(file('aquery.json'), 'utf8')),
  );
});

test('malformed, truncated, wrong-format and wrong-version captures fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-aquery-'));
  try {
    const malformed = join(directory, 'malformed.pb');
    const truncated = join(directory, 'truncated.pb');
    writeFileSync(
      malformed,
      Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    );
    const bytes = readFileSync(file('aquery.pb'));
    writeFileSync(truncated, bytes.subarray(0, bytes.length - 1));
    expect(() => readNativeAquery(malformed, 'proto', version)).toThrow();
    expect(() => readNativeAquery(truncated, 'proto', version)).toThrow();
    expect(() => readNativeAquery(file('aquery.pb'), 'jsonproto', version)).toThrow();
    expect(() => readNativeAquery(file('aquery.json'), 'proto', version)).toThrow();
    expect(() => readNativeAquery(file('aquery.pb'), 'streamed_proto' as any, version)).toThrow();
    expect(() => readNativeAquery(file('aquery.pb'), 'proto', '8.8.2')).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
