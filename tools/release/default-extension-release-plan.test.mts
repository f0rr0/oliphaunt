import { expect, test } from 'bun:test';
import { validateReleaseConsumerCompatibility } from './consumer-compatibility.mts';
import { defaultExtensionReleasePlan } from './default-extension-release-plan.mts';
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
