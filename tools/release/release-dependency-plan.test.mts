import { expect, test } from 'bun:test';
import {
  loadProducts,
  compatibilityVersionEntries,
  compatibilityVersionValue,
} from './release-graph.mts';
import {
  buildBoundCompatibilityProducts,
  releaseDependencyPlan,
  requirePublicSupportTransition,
  resolveBuildBoundCompatibilityProducts,
} from './release-dependency-plan.mts';

function fixture() {
  const products = {
    sdk: { version: '1.2.0' },
    binary: { version: '1.0.1' },
    runtime: { version: '2.0.0' },
  };
  const buildBound = new Map([
    ['sdk', new Set()],
    ['binary', new Set(['runtime'])],
    ['runtime', new Set()],
  ]);
  return { products, buildBound };
}

test('selected source consumers retain declarations while compiled payloads name their real inputs', () => {
  const { products, buildBound } = fixture();
  const entries = ['sdk', 'binary'].map((product) => ({
    id: product,
    product,
    sourceProduct: 'runtime',
    publicSupport: false,
  }));
  const plan = releaseDependencyPlan(products, ['sdk', 'binary'], {
    entries,
    buildBound,
    readValue: () => '1.0.0',
  });
  expect(plan.map(({ version, binding }) => ({ version, binding }))).toEqual([
    { version: '1.0.0', binding: 'declared-requirement' },
    { version: '2.0.0', binding: 'compiled-input' },
  ]);
  expect(
    releaseDependencyPlan(products, [], {
      entries,
      buildBound,
      readValue: () => '1.0.0',
    }).every(({ version }) => version === '1.0.0'),
  ).toBe(true);
});

test('an absent buildBound option keeps legacy relationships without self dependencies', () => {
  const { products } = fixture();
  products.binary.embedded_payload_products = ['binary', 'runtime'];
  const expected = new Map([
    ['sdk', new Set()],
    ['binary', new Set(['runtime'])],
    ['runtime', new Set()],
  ]);
  expect(buildBoundCompatibilityProducts(products)).toEqual(expected);
  expect(resolveBuildBoundCompatibilityProducts(products)).toEqual(expected);
  expect(
    resolveBuildBoundCompatibilityProducts(products, Object.create({ buildBound: null })),
  ).toEqual(expected);
});

test('an explicit complete empty map retains held pins instead of merging legacy relationships', () => {
  const { products } = fixture();
  products.binary.embedded_payload_products = ['runtime'];
  const buildBound = new Map(Object.keys(products).map((id) => [id, new Set()]));
  let reads = 0;
  const plan = releaseDependencyPlan(products, ['binary'], {
    entries: [{ product: 'binary', sourceProduct: 'runtime' }],
    buildBound,
    readValue: () => {
      reads += 1;
      return '= 1.0.0';
    },
  });
  expect(plan).toEqual([
    {
      product: 'binary',
      sourceProduct: 'runtime',
      version: '= 1.0.0',
      binding: 'declared-requirement',
    },
  ]);
  expect(reads).toBe(1);
});

test('the resolver snapshots every Map and Set without retaining either direction of aliasing', async () => {
  const { products, buildBound } = fixture();
  const snapshot = resolveBuildBoundCompatibilityProducts(products, { buildBound });
  expect(snapshot).not.toBe(buildBound);
  for (const id of Object.keys(products)) expect(snapshot.get(id)).not.toBe(buildBound.get(id));
  await Promise.resolve();
  buildBound.get('binary').clear();
  buildBound.set('sdk', new Set(['runtime']));
  buildBound.delete('runtime');
  expect(snapshot.get('binary')).toEqual(new Set(['runtime']));
  expect(snapshot.get('sdk')).toEqual(new Set());
  expect(snapshot.has('runtime')).toBe(true);
  snapshot.get('sdk').add('binary');
  snapshot.delete('binary');
  expect(buildBound.get('sdk')).toEqual(new Set(['runtime']));
  expect(buildBound.has('binary')).toBe(true);
});

test('dependency planning uses its snapshot even when a held-pin reader mutates the supplied map', () => {
  const { products, buildBound } = fixture();
  const plan = releaseDependencyPlan(products, ['sdk', 'binary'], {
    entries: ['sdk', 'binary'].map((product) => ({ product, sourceProduct: 'runtime' })),
    buildBound,
    readValue: () => {
      buildBound.get('binary').clear();
      return '1.0.0';
    },
  });
  expect(plan.map(({ version, binding }) => ({ version, binding }))).toEqual([
    { version: '1.0.0', binding: 'declared-requirement' },
    { version: '2.0.0', binding: 'compiled-input' },
  ]);
});

for (const [name, invalid] of [
  ['undefined', () => undefined],
  ['null', () => null],
  ['object', () => ({ binary: new Set(['runtime']) })],
  ['partial Map', () => new Map([['binary', new Set(['runtime'])]])],
  ['extra consumer', (map) => map.set('foreign', new Set())],
  [
    'unknown consumer replacing a required key',
    (map) => {
      map.delete('sdk');
      return map.set('foreign', new Set());
    },
  ],
  ['non-string consumer', (map) => map.set(1, new Set())],
  ['non-Set producers', (map) => map.set('binary', ['runtime'])],
  ['undefined producers', (map) => map.set('binary', undefined)],
  ['unknown producer', (map) => map.set('binary', new Set(['foreign']))],
  ['inherited producer name', (map) => map.set('binary', new Set(['constructor']))],
  ['non-string producer', (map) => map.set('binary', new Set([1]))],
  ['self producer', (map) => map.set('binary', new Set(['binary']))],
])
  test(`invalid injected buildBound rejects ${name} before reading held pins`, () => {
    const { products, buildBound } = fixture();
    const supplied = invalid(buildBound);
    let reads = 0;
    expect(() =>
      releaseDependencyPlan(products, ['binary'], {
        entries: [{ product: 'binary', sourceProduct: 'runtime' }],
        buildBound: supplied,
        readValue: () => {
          reads += 1;
          return '1.0.0';
        },
      }),
    ).toThrow('buildBound');
    expect(reads).toBe(0);
  });

test('support removal requires the configured pre-1.0 or stable breaking boundary', () => {
  const base = {
    product: 'extension',
    previousSupport: 'runtime@1.0.0',
    nextSupport: 'runtime@2.0.0',
  };
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.2.3', after: '0.2.4' }),
  ).toThrow('breaking-version policy');
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.2.3', after: '0.3.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '1.2.3', after: '1.3.0' }),
  ).toThrow('breaking-version policy');
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '1.2.3', after: '2.0.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.0.0', after: '0.1.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({
      ...base,
      nextSupport: base.previousSupport,
      before: '1.2.3',
      after: '1.2.4',
    }),
  ).not.toThrow();
});

test('resource admitted consumer stays held when both independent products are selected', () => {
  const graph = loadProducts('resource consumer held plan');
  const entry = compatibilityVersionEntries(graph, { requireSourceProduct: true }).find(
    (row) => row.product === 'database-resources' && row.sourceProduct === 'liboliphaunt-wasix',
  );
  expect(entry).toBeDefined();
  const held = compatibilityVersionValue(entry);
  graph['liboliphaunt-wasix'].version = '999.0.0';
  graph['database-resources'].version = '999.0.0';
  const buildBound = new Map(Object.keys(graph).map((id) => [id, new Set()]));
  const planned = releaseDependencyPlan(graph, ['database-resources', 'liboliphaunt-wasix'], {
    buildBound,
  });
  const actual = planned.find((row) => row.product === entry.product && row.id === entry.id);
  expect(actual.version).toBe(held);
  expect(actual.binding).toBe('declared-requirement');
});
