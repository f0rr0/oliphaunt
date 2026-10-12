import { expect, test } from 'bun:test';
import { validateReleaseConsumerCompatibility } from './consumer-compatibility.mts';
import {
  defaultExtensionReleasePlan,
  snapshotCurrentExactInputs,
} from './default-extension-release-plan.mts';
import { loadProducts } from './release-graph.mts';
import { fixture } from './testdata/extension-release-fixture.mts';

const native = 'liboliphaunt-native';
const wasix = 'liboliphaunt-wasix';
const extension = 'oliphaunt-extension-vector';

function advance(product) {
  const parts = product.version.split('.').map(Number);
  parts[2] += 1;
  product.version = parts.join('.');
}

function close(state, requested) {
  const selected = new Set(requested);
  for (const id of selected) advance(state.products[id]);
  let plan;
  for (let attempt = 0; attempt <= Object.keys(state.products).length; attempt += 1) {
    const before = structuredClone({ products: state.products, pins: state.pins });
    plan = defaultExtensionReleasePlan(state.products, selected, state);
    expect({ products: state.products, pins: state.pins }).toEqual(before);
    const missing = [...plan.required].filter((id) => !selected.has(id));
    if (!missing.length) break;
    for (const id of missing) {
      selected.add(id);
      advance(state.products[id]);
    }
  }
  expect([...plan.required].every((id) => selected.has(id))).toBe(true);
  for (const { product, sourceProduct, version } of plan.requirements.values())
    state.pins[product][sourceProduct] = version;
  for (const id of selected) {
    if (state.products[id].extension?.class === 'external')
      for (const runtime of [native, wasix])
        state.pins[id][runtime] = state.products[runtime].version;
    if (id === 'oliphaunt-wasix-napi') state.pins[id][wasix] = state.products[wasix].version;
  }
  expect(() => validateReleaseConsumerCompatibility([...selected], state)).not.toThrow();
  const repeated = defaultExtensionReleasePlan(state.products, selected, state);
  expect([...repeated.required].sort()).toEqual([...selected].sort());
  expect(
    [...repeated.requirements.values()].every(
      ({ product, sourceProduct, version }) => state.pins[product][sourceProduct] === version,
    ),
  ).toBe(true);
  return selected;
}

test('runtime-only, SDK-only and compatible extension updates retain independent scopes', () => {
  for (const requested of [[], [native], ['oliphaunt-js'], [extension]]) {
    const state = fixture();
    const baseline = structuredClone(state.pins);
    const selected = close(state, requested);
    // A runtime version update does not repackage unchanged extensions or SDKs.
    expect([...selected].sort()).toEqual([...requested].sort());
    expect(state.pins).toEqual(baseline);
  }
});

test('a supplied held extension host does not adopt an unrelated newer workspace runtime', () => {
  const state = fixture();
  advance(state.products[native]);
  advance(state.products[wasix]);
  const buildBound = new Map(Object.keys(state.products).map((id) => [id, new Set<string>()]));
  const before = structuredClone({ products: state.products, pins: state.pins });
  const plan = defaultExtensionReleasePlan(state.products, [extension], { ...state, buildBound });
  expect([...plan.required]).toEqual([extension]);
  expect(plan.requirements.size).toBe(0);
  expect({ products: state.products, pins: state.pins }).toEqual(before);
  expect(() =>
    validateReleaseConsumerCompatibility([extension], { ...state, buildBound }),
  ).not.toThrow();

  buildBound.get(extension).add(native);
  const current = defaultExtensionReleasePlan(state.products, [extension], {
    ...state,
    buildBound,
  });
  expect(current.requirements.get(`oliphaunt-js:${native}`).version).toBe(
    state.products[native].version,
  );
});

test('conflicting held extension suppliers reject before synthetic host adoption', () => {
  const state = fixture();
  const second = 'oliphaunt-extension-pg-hashids';
  state.products[second] = {
    ...structuredClone(state.products[extension]),
    tag_prefix: `${second}-v`,
  };
  state.pins[second] = structuredClone(state.pins[extension]);
  state.published[second] = structuredClone(state.pins[extension]);
  advance(state.products[native]);
  const buildBound = new Map(Object.keys(state.products).map((id) => [id, new Set<string>()]));
  buildBound.get(extension).add(native);
  const before = structuredClone({ products: state.products, pins: state.pins });
  expect(() =>
    defaultExtensionReleasePlan(state.products, [extension], { ...state, buildBound }),
  ).toThrow('update its conventional runtime requirement');
  expect({ products: state.products, pins: state.pins }).toEqual(before);

  // A source adoption can deliberately use a published host older than the
  // unrelated workspace host; an empty map must not silently replace it.
  advance(state.products[native]);
  state.pins[extension][native] = '0.3.2';
  state.pins[second][native] = '0.3.2';
  buildBound.get(extension).clear();
  const adopted = defaultExtensionReleasePlan(state.products, [extension], {
    ...state,
    buildBound,
  });
  expect(adopted.required.has(second)).toBe(true);
  expect(adopted.requirements.get(`oliphaunt-js:${native}`).version).toBe('0.3.2');
});

test('a native host change selects exactly the required default SDK and wrapper updates', () => {
  const state = fixture();
  advance(state.products[native]);
  expect([...close(state, [extension])].sort()).toEqual(
    [
      extension,
      'oliphaunt-js',
      'oliphaunt-kotlin',
      'oliphaunt-react-native',
      'oliphaunt-swift',
    ].sort(),
  );
  expect(state.pins['oliphaunt-react-native']['oliphaunt-swift']).toBe(
    state.products['oliphaunt-swift'].version,
  );
  expect(state.pins['oliphaunt-react-native']['oliphaunt-kotlin']).toBe(
    state.products['oliphaunt-kotlin'].version,
  );
});

test('default native SDK adoption preserves independently held dynamic helpers', () => {
  const state = fixture();
  for (const [id, version] of [
    ['oliphaunt-node-direct', '0.2.2'],
    ['oliphaunt-broker', '0.3.1'],
  ]) {
    state.products[id] = {
      version,
      kind: 'runtime',
      tag_prefix: `${id}-v`,
      compatibility_versions: {
        host: { source_product: native, public_support: false },
      },
    };
    state.pins[id] = { [native]: state.products[native].version };
    state.published[id] = structuredClone(state.pins[id]);
    state.pins['oliphaunt-js'][id] = version;
    state.published['oliphaunt-js'][id] = version;
    state.products['oliphaunt-js'].compatibility_versions[id] = {
      source_product: id,
      public_support: false,
    };
  }
  advance(state.products[native]);
  // The selected extension deliberately adopts an already published new host.
  // Its ABI supplier map does not falsely turn dynamically loaded helpers into
  // consumers that embed the current runtime.
  state.pins[extension][native] = state.products[native].version;
  const buildBound = new Map(Object.keys(state.products).map((id) => [id, new Set<string>()]));
  const before = structuredClone({ products: state.products, pins: state.pins });
  const plan = defaultExtensionReleasePlan(state.products, [extension], { ...state, buildBound });
  expect(plan.requirements.get(`oliphaunt-js:${native}`).version).toBe(
    state.products[native].version,
  );
  for (const helper of ['oliphaunt-node-direct', 'oliphaunt-broker']) {
    expect(plan.required.has(helper)).toBe(false);
    expect(plan.requirements.has(`oliphaunt-js:${helper}`)).toBe(false);
    expect(state.pins['oliphaunt-js'][helper]).toBe(before.pins['oliphaunt-js'][helper]);
  }
  expect({ products: state.products, pins: state.pins }).toEqual(before);
});

test('a WASIX host change selects a matching addon instead of substituting workspace bytes', () => {
  const state = fixture();
  advance(state.products[wasix]);
  expect([...close(state, [extension])].sort()).toEqual(
    [extension, 'oliphaunt-wasix-ts', 'oliphaunt-wasix-rust', 'oliphaunt-wasix-napi'].sort(),
  );
  expect(state.pins['oliphaunt-wasix-ts']['oliphaunt-wasix-napi']).toBe(
    state.products['oliphaunt-wasix-napi'].version,
  );
});

test('an existing compatible addon and historical platform SDKs avoid unnecessary candidates', () => {
  const state = fixture();
  advance(state.products[wasix]);
  state.publishedVersions['oliphaunt-wasix-napi-v0.2.1'] = {
    [wasix]: state.products[wasix].version,
  };
  state.products['oliphaunt-wasix-napi'].version = '0.2.1';
  const selected = close(state, [extension]);
  expect(selected.has('oliphaunt-wasix-napi')).toBe(false);
  expect(selected.has('oliphaunt-react-native')).toBe(false);
  expect(state.pins['oliphaunt-wasix-ts']['oliphaunt-wasix-napi']).toBe('0.2.1');
});

test('a held registry addon cannot acquire a new runtime merely by selecting its product', () => {
  for (const selected of [[extension], [extension, 'oliphaunt-wasix-napi']]) {
    const state = fixture();
    delete state.products['oliphaunt-wasix-napi'].embedded_payload_products;
    advance(state.products[wasix]);
    const before = structuredClone({ products: state.products, pins: state.pins });
    expect(() => defaultExtensionReleasePlan(state.products, selected, state)).toThrow(
      'update its conventional runtime and SDK requirements',
    );
    expect({ products: state.products, pins: state.pins }).toEqual(before);
  }
});

test('authored requirements beyond available producer versions fail before candidate application', () => {
  const state = fixture();
  state.pins['oliphaunt-js'][native] = '9.0.0';
  expect(() => defaultExtensionReleasePlan(state.products, ['oliphaunt-js'], state)).toThrow(
    'not a candidate or published host',
  );
});

test('500 seeded sparse and broad releases close compatible defaults and preserve unrelated requirements', () => {
  let seed = 0x71b6c3a5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  for (let scenario = 0; scenario < 500; scenario += 1) {
    const state = fixture();
    for (let index = 1; index < 7; index += 1) {
      const id = `oliphaunt-extension-fixture-${index}`;
      state.products[id] = {
        ...structuredClone(state.products[extension]),
        tag_prefix: `${id}-v`,
        version: `1.${index}.0`,
      };
      state.pins[id] = structuredClone(state.pins[extension]);
      state.published[id] = structuredClone(state.published[extension]);
    }
    // A producer can already have advanced independently before this batch.
    for (const runtime of [native, wasix]) if (random() < 0.5) advance(state.products[runtime]);
    const fraction = scenario % 3 === 0 ? 0.85 : scenario % 3 === 1 ? 0.2 : 0.05;
    const requested = Object.keys(state.products).filter(() => random() < fraction);
    // Unselected source requirements may differ from their immutable packages.
    for (const product of Object.keys(state.pins))
      for (const runtime of [native, wasix])
        if (
          (state.products[product].kind === 'sdk' || state.products[product].extension) &&
          state.pins[product][runtime] &&
          random() < 0.3
        )
          state.pins[product][runtime] = state.products[runtime].version;
    const before = structuredClone(state.pins);
    const selected = close(state, requested);
    for (const id of Object.keys(before)) {
      if (!selected.has(id)) expect(state.pins[id]).toEqual(before[id]);
    }
  }
}, 30_000);

// Physical module/descriptor authentication is the controller precondition;
// these tests exercise only the one frozen requirements/RP seam.
test('verified exact-module contracts retarget only necessary selected consumers and producers', () => {
  const products = loadProducts('exact current requirement test');
  const product = 'database-resources',
    sourceProduct = 'liboliphaunt-wasix';
  const buildBound = new Map(Object.keys(products).map((id) => [id, new Set<string>()]));
  const readCompatibility = () => '0.3.2';
  products[sourceProduct].version = '0.3.4';
  const currentExactInputs = [{ product, sourceProduct }];
  const before = structuredClone(products);
  for (const selected of [[], [sourceProduct], [product]]) {
    const plan = defaultExtensionReleasePlan(products, selected, {
      buildBound,
      readCompatibility,
      currentExactInputs,
    });
    expect([...plan.required]).toEqual(selected);
    expect(plan.requirements.size).toBe(0);
  }
  const selected = [sourceProduct, product];
  const planned = defaultExtensionReleasePlan(products, selected, {
    buildBound,
    readCompatibility,
    currentExactInputs,
  });
  expect([...planned.required]).toEqual(selected);
  expect([...planned.requirements.values()]).toEqual([
    { product, sourceProduct, version: '0.3.4' },
  ]);
  expect(buildBound.get(product).size).toBe(0);
  expect(products).toEqual(before);
  const same = defaultExtensionReleasePlan(products, selected, {
    buildBound,
    readCompatibility: () => '0.3.4',
    currentExactInputs,
  });
  expect(same.requirements.size).toBe(0);
});

test('current exact associations are immutable, conventional, unique and cannot select releases', () => {
  const products = loadProducts('exact current requirement negative');
  const pair = { product: 'database-resources', sourceProduct: 'liboliphaunt-wasix' };
  const input = [pair];
  const snapshot = snapshotCurrentExactInputs(products, input);
  pair.sourceProduct = 'liboliphaunt-native';
  input.push({ product: 'foreign', sourceProduct: 'foreign' });
  expect(snapshot).toEqual([
    { product: 'database-resources', sourceProduct: 'liboliphaunt-wasix' },
  ]);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
  for (const invalid of [
    null,
    {},
    [null],
    [{ ...snapshot[0], version: '0.3.4' }],
    [{ product: 'foreign', sourceProduct: 'liboliphaunt-wasix' }],
    [{ product: 'database-resources', sourceProduct: 'database-resources' }],
    [{ product: 'database-resources', sourceProduct: 'oliphaunt-query' }],
    [...snapshot, ...snapshot],
  ]) {
    expect(() => snapshotCurrentExactInputs(products, invalid)).toThrow();
  }
});
