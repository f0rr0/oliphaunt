import { expect, test } from 'bun:test';
import {
  validateConsumerContractCoverage,
  validateReleaseConsumerCompatibility,
} from './consumer-compatibility.mts';
import { releasePackageBindings } from './release-graph.mts';

function fixture() {
  const extensionRuntimes = {
    'oliphaunt-wasix-ts': 'liboliphaunt-wasix',
    'oliphaunt-wasix-rust': 'liboliphaunt-wasix',
    'oliphaunt-js': 'liboliphaunt-native',
    'oliphaunt-kotlin': 'liboliphaunt-native',
    'oliphaunt-swift': 'liboliphaunt-native',
  };
  const sdks = new Set([...Object.keys(extensionRuntimes), 'oliphaunt-rust']);
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
        ...(sdks.has(id) ? { kind: 'sdk' } : {}),
        ...(extensionRuntimes[id]
          ? { exact_extension_runtime: extensionRuntimes[id] }
          : id === 'oliphaunt-rust'
            ? { exact_extension_runtime: false }
            : {}),
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
    'oliphaunt-rust': { 'liboliphaunt-native': '0.3.1' },
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

test('SDK releases do not require every latest extension to follow their runtime', () => {
  const state = fixture();
  state.published['oliphaunt-extension-vector'] = {
    'liboliphaunt-wasix': '0.3.0',
    'liboliphaunt-native': '0.3.0',
  };
  expect(() =>
    validateReleaseConsumerCompatibility(
      [
        'oliphaunt-wasix-ts',
        'oliphaunt-wasix-rust',
        'oliphaunt-rust',
        'oliphaunt-js',
        'oliphaunt-kotlin',
        'oliphaunt-swift',
      ],
      state,
    ),
  ).not.toThrow();
  expect(state.reads.some(({ product }) => product === 'oliphaunt-extension-vector')).toBe(false);
});

test('React Native validates the historical SDKs it actually pins', () => {
  const state = fixture();
  for (const dependency of ['oliphaunt-kotlin', 'oliphaunt-swift']) {
    state.products[dependency].version = '1.0.0';
    state.pins[dependency]['liboliphaunt-native'] = '0.4.0';
  }
  expect(() =>
    validateReleaseConsumerCompatibility(['oliphaunt-react-native'], state),
  ).not.toThrow();
  for (const dependency of ['oliphaunt-kotlin', 'oliphaunt-swift'])
    expect(state.reads).toContainEqual({
      product: dependency,
      source: 'liboliphaunt-native',
      ref: `${dependency}-v${dependency === 'oliphaunt-kotlin' ? '0.3.1' : '0.8.0'}`,
    });
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

test('installed SDK consumers must agree with their pinned SDK runtime', () => {
  const state = fixture();
  state.pins['postgres-tools-wasix']['liboliphaunt-wasix'] = '0.3.2';
  expect(() => validateReleaseConsumerCompatibility(['postgres-tools-wasix'], state)).toThrow(
    'postgres-tools-wasix targets liboliphaunt-wasix@0.3.2',
  );
});

test('compiled SDK sources follow the binary closure while installed addon consumers retain runtime checks', () => {
  const state = fixture();
  state.products['oliphaunt-wasix-napi'].compatibility_versions.sdk = {
    source_product: 'oliphaunt-wasix-rust',
    public_support: false,
  };
  state.pins['oliphaunt-wasix-napi']['oliphaunt-wasix-rust'] = '0.3.1';
  state.pins['oliphaunt-wasix-napi']['liboliphaunt-wasix'] = '0.3.2';
  const selected = ['oliphaunt-wasix-napi', 'oliphaunt-wasix-rust'];
  expect(() => validateReleaseConsumerCompatibility(selected, state)).toThrow(
    'oliphaunt-wasix-napi targets liboliphaunt-wasix@0.3.2',
  );
  const buildBound = new Map([
    ['oliphaunt-wasix-napi', new Set(['oliphaunt-wasix-rust', 'liboliphaunt-wasix'])],
  ]);
  expect(() =>
    validateReleaseConsumerCompatibility(selected, { ...state, buildBound }),
  ).not.toThrow();
  expect(() =>
    validateReleaseConsumerCompatibility([...selected, 'oliphaunt-wasix-ts'], {
      ...state,
      buildBound,
    }),
  ).toThrow('runtime 0.3.1 differs');
  state.products['oliphaunt-wasix-napi'].compatibility_versions.sdk.public_support = true;
  expect(() => validateReleaseConsumerCompatibility(selected, { ...state, buildBound })).toThrow(
    'oliphaunt-wasix-napi targets liboliphaunt-wasix@0.3.2',
  );
});

test('new runtime SDKs require an explicit consumer contract before metadata admission', () => {
  const state = fixture();
  state.products['future-sdk'] = {
    kind: 'sdk',
    compatibility_versions: { runtime: { source_product: 'liboliphaunt-wasix' } },
  };
  expect(() => validateConsumerContractCoverage(state.products)).toThrow('future-sdk must declare');
});

test('release bindings preserve an unchanged consumer pin when its runtime advances', () => {
  const state = fixture();
  const entries = Object.entries(state.pins).flatMap(([product, pins]) =>
    Object.keys(pins).map((sourceProduct) => ({ product, sourceProduct })),
  );
  const current = releasePackageBindings(['liboliphaunt-native'], {
    ...state,
    entries,
  });
  expect(
    current.find(
      ({ consumer, producer }) =>
        consumer === 'oliphaunt-rust' && producer === 'liboliphaunt-native',
    )?.origin,
  ).toBe('candidate');

  state.products['liboliphaunt-native'].version = '0.3.2';
  const advanced = releasePackageBindings(['liboliphaunt-native'], {
    ...state,
    entries,
  });
  expect(
    advanced.find(
      ({ consumer, producer }) =>
        consumer === 'oliphaunt-rust' && producer === 'liboliphaunt-native',
    ),
  ).toEqual({
    consumer: 'oliphaunt-rust',
    consumerVersion: '0.3.1',
    producer: 'liboliphaunt-native',
    producerVersion: '0.3.1',
    origin: 'published',
  });
  expect(state.reads).toContainEqual({
    product: 'oliphaunt-rust',
    source: 'liboliphaunt-native',
    ref: null,
  });
});

test('release bindings reject conflicting declarations for one package pair', () => {
  const state = fixture();
  let reads = 0;
  expect(() =>
    releasePackageBindings(['oliphaunt-rust'], {
      products: state.products,
      entries: [
        { product: 'oliphaunt-rust', sourceProduct: 'liboliphaunt-native' },
        { product: 'oliphaunt-rust', sourceProduct: 'liboliphaunt-native' },
      ],
      readCompatibility: () => (reads++ === 0 ? '0.3.1' : '0.3.0'),
    }),
  ).toThrow('declares conflicting liboliphaunt-native versions');
});
