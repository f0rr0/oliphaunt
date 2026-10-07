import { expect, test } from 'bun:test';
import {
  validatePublishedCargoExtensionConsumers,
  validateReleaseConsumerCompatibility,
  validateConsumerContractCoverage,
} from './consumer-compatibility.mts';

function fixture() {
  const versions = {
    'oliphaunt-wasix-ts': '0.2.1',
    'oliphaunt-wasix-napi': '0.2.0',
    'postgres-tools-wasix': '0.2.3',
    'oliphaunt-wasix-rust': '0.3.1',
    'oliphaunt-rust': '0.3.1',
    'oliphaunt-js': '0.3.0',
    'oliphaunt-kotlin': '0.3.1',
    'oliphaunt-swift': '0.8.0',
    'oliphaunt-react-native': '0.3.0',
    'oliphaunt-extension-vector': '9.8.7',
    'liboliphaunt-wasix': '0.3.1',
    'liboliphaunt-native': '0.3.1',
  };
  const products = Object.fromEntries(
    Object.entries(versions).map(([id, version]) => [
      id,
      {
        version,
        tag_prefix: `${id}-v`,
        ...(id === 'oliphaunt-extension-vector' ? { extension: { class: 'external' } } : {}),
      },
    ]),
  );
  const pins = {
    'oliphaunt-wasix-ts': { 'liboliphaunt-wasix': '0.3.1', 'oliphaunt-wasix-napi': '0.2.0' },
    'oliphaunt-wasix-napi': { 'liboliphaunt-wasix': '0.3.1' },
    'oliphaunt-wasix-rust': { 'liboliphaunt-wasix': '0.3.1' },
    'postgres-tools-wasix': {
      'oliphaunt-wasix-ts': '0.2.1',
      'liboliphaunt-wasix': '0.3.1',
    },
    'oliphaunt-js': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-kotlin': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-swift': { 'liboliphaunt-native': '0.3.1' },
    'oliphaunt-react-native': { 'oliphaunt-kotlin': '0.3.1', 'oliphaunt-swift': '0.8.0' },
    'oliphaunt-extension-vector': { 'liboliphaunt-wasix': '0.3.1', 'liboliphaunt-native': '0.3.1' },
  };
  const published = structuredClone(pins);
  for (const [id, fields] of Object.entries(pins)) {
    products[id].compatibility_versions = Object.fromEntries(
      Object.keys(fields).map((source) => [source, { source_product: source }]),
    );
  }
  const reads = [];
  const readCompatibility = (product, source, _prefix, { ref }) => {
    reads.push({ product, source, ref });
    if (ref !== null) expect(ref.startsWith(products[product].tag_prefix)).toBe(true);
    return (ref === null ? pins : published)[product][source];
  };
  return { products, pins, published, reads, readCompatibility };
}

test('compatible independent products pass without coupling their packaging versions', () => {
  const state = fixture();
  expect(() =>
    validateReleaseConsumerCompatibility(['oliphaunt-wasix-ts', 'oliphaunt-kotlin'], state),
  ).not.toThrow();
});

test('source qualification cannot substitute a newer workspace addon for a published carrier', () => {
  const state = fixture();
  state.published['oliphaunt-wasix-napi']['liboliphaunt-wasix'] = '0.3.0';
  expect(() => validateReleaseConsumerCompatibility(['oliphaunt-wasix-ts'], state)).toThrow(
    'runtime 0.3.1 differs',
  );
  expect(() =>
    validateReleaseConsumerCompatibility(['oliphaunt-wasix-ts', 'oliphaunt-wasix-napi'], state),
  ).not.toThrow();
});

test('historical extension metadata must load with every selected consumer runtime', () => {
  for (const product of [
    'oliphaunt-wasix-ts',
    'oliphaunt-wasix-rust',
    'oliphaunt-js',
    'oliphaunt-kotlin',
    'oliphaunt-swift',
  ]) {
    const state = fixture();
    state.published['oliphaunt-extension-vector'] = {
      'liboliphaunt-wasix': '0.3.0',
      'liboliphaunt-native': '0.3.0',
    };
    expect(() => validateReleaseConsumerCompatibility([product], state)).toThrow(
      'vector@9.8.7 targets',
    );
    expect(() =>
      validateReleaseConsumerCompatibility([product, 'oliphaunt-extension-vector'], state),
    ).not.toThrow();
  }
});

test('tools and React Native validate the historical SDKs they actually pin', () => {
  for (const [owner, dependency, source] of [
    ['postgres-tools-wasix', 'oliphaunt-wasix-ts', 'liboliphaunt-wasix'],
    ['oliphaunt-react-native', 'oliphaunt-kotlin', 'liboliphaunt-native'],
    ['oliphaunt-react-native', 'oliphaunt-swift', 'liboliphaunt-native'],
  ]) {
    const state = fixture();
    state.published[dependency][source] = '0.3.0';
    expect(() => validateReleaseConsumerCompatibility([owner], state)).toThrow(
      `${owner} through ${dependency}`,
    );
  }
});

test('an unrelated runtime or extension release retains independent consumer boundaries', () => {
  const state = fixture();
  state.published['oliphaunt-wasix-napi']['liboliphaunt-wasix'] = '0.3.0';
  expect(() =>
    validateReleaseConsumerCompatibility(
      ['liboliphaunt-wasix', 'oliphaunt-extension-vector'],
      state,
    ),
  ).not.toThrow();
  expect(state.reads).toEqual([]);
});

test('a tools-only release uses its older SDK tag after the workspace SDK advances', () => {
  const state = fixture();
  state.products['oliphaunt-wasix-ts'].version = '0.2.2';
  state.pins['oliphaunt-wasix-ts']['liboliphaunt-wasix'] = '0.3.2';
  expect(() => validateReleaseConsumerCompatibility(['postgres-tools-wasix'], state)).not.toThrow();
  expect(state.reads).toContainEqual({
    product: 'oliphaunt-wasix-ts',
    source: 'liboliphaunt-wasix',
    ref: 'oliphaunt-wasix-ts-v0.2.1',
  });
});

test('tools and embedded SDK consumers must agree with their pinned SDK runtime', () => {
  const state = fixture();
  state.pins['postgres-tools-wasix']['liboliphaunt-wasix'] = '0.3.2';
  expect(() => validateReleaseConsumerCompatibility(['postgres-tools-wasix'], state)).toThrow(
    'postgres-tools-wasix targets liboliphaunt-wasix@0.3.2',
  );
});

test('Cargo SDK release admission rejects exact historical facade API pins and accepts compatible ranges', async () => {
  const state = fixture();
  const dependencies = [
    { crate_id: 'oliphaunt-build', req: '=0.3.0' },
    { crate_id: 'oliphaunt-wasix', req: '=0.3.0' },
  ];
  const options = { products: state.products, readDependencies: async () => dependencies };
  await expect(
    validatePublishedCargoExtensionConsumers(['oliphaunt-rust', 'oliphaunt-wasix-rust'], options),
  ).rejects.toThrow('cannot resolve');
  for (const row of dependencies) row.req = '^0.3.0';
  await expect(
    validatePublishedCargoExtensionConsumers(['oliphaunt-rust', 'oliphaunt-wasix-rust'], options),
  ).resolves.toBeUndefined();
  dependencies[0].req = '^0.4.0';
  await expect(
    validatePublishedCargoExtensionConsumers(['oliphaunt-rust'], options),
  ).rejects.toThrow('incompatible');
  await expect(
    validatePublishedCargoExtensionConsumers(
      ['oliphaunt-rust', 'oliphaunt-extension-vector'],
      options,
    ),
  ).resolves.toBeUndefined();
});

test('missing facade APIs fail closed and unrelated releases make no Cargo requests', async () => {
  const state = fixture();
  let calls = 0;
  const options = {
    products: state.products,
    readDependencies: async () => {
      calls += 1;
      return [];
    },
  };
  await expect(
    validatePublishedCargoExtensionConsumers(['oliphaunt-rust'], options),
  ).rejects.toThrow('<missing>');
  await validatePublishedCargoExtensionConsumers(['oliphaunt-js'], options);
  expect(calls).toBe(1);
});

test('new runtime SDKs require an explicit consumer contract before metadata admission', () => {
  const state = fixture();
  state.products['future-sdk'] = {
    kind: 'sdk',
    compatibility_versions: { runtime: { source_product: 'liboliphaunt-wasix' } },
  };
  expect(() => validateConsumerContractCoverage(state.products)).toThrow('future-sdk must declare');
});
