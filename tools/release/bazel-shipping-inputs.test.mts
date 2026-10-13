import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildShippingInputView,
  isNativeAppleBaseInputRoot,
  selectObservedShippingChanges,
  selectShippingChanges,
} from './bazel-shipping-inputs.mts';

test('only the exact declared private Apple File root is transportable', () => {
  const root = {
    label: '@@//src/native/runtime:apple_ios_manifest_shipping',
    package: {
      product: 'liboliphaunt-native',
      ecosystem: 'internal',
      configuration: 'ios-xcframework',
      name: 'ios.json',
      role: 'apple-base-ios-manifest-input',
      outputs: [{ path: 'bazel-out/cfg/bin/src/native/runtime/apple_release_assets/ios.json' }],
    },
  };
  expect(isNativeAppleBaseInputRoot(root)).toBe(true);
  for (const changed of [
    { product: 'fixture' },
    { ecosystem: 'github' },
    { configuration: 'macos-arm64' },
    { name: 'other.json' },
    { role: 'construction' },
    { outputs: [] },
    { outputs: [...root.package.outputs, ...root.package.outputs] },
    { outputs: [{ path: 'source/apple_release_assets/ios.json' }] },
    { outputs: [{ path: 'bazel-out/cfg/bin/unrelated/ios.json' }] },
  ])
    expect(isNativeAppleBaseInputRoot({ ...root, package: { ...root.package, ...changed } })).toBe(
      false,
    );
  expect(
    isNativeAppleBaseInputRoot({ ...root, label: '//other:apple_ios_manifest_shipping' }),
  ).toBe(false);
});

function fixture() {
  const exported = {
    schema: 'oliphaunt-bazel-shipping-v1',
    scope: 'construction',
    packages: [
      {
        product: 'alpha',
        version: '1.2.3',
        ecosystem: 'npm',
        name: '@example/alpha',
        configuration: 'linux-x64',
        role: 'package',
        outputs: [{ path: 'bazel-out/package.tgz', owner: '@@//:package' }],
      },
    ],
  };
  const graph = {
    pathFragments: [
      { id: 1, label: 'src' },
      { id: 2, parentId: 1, label: 'alpha.c' },
      { id: 3, label: 'tools' },
      { id: 4, parentId: 3, label: 'packager' },
      { id: 5, label: 'bazel-out' },
      { id: 6, parentId: 5, label: 'alpha.o' },
      { id: 7, parentId: 5, label: 'package.tgz' },
    ],
    artifacts: [
      { id: 1, pathFragmentId: 2 },
      { id: 2, pathFragmentId: 4 },
      { id: 3, pathFragmentId: 6 },
      { id: 4, pathFragmentId: 7 },
    ],
    targets: [
      { id: 1, label: '//:compile' },
      { id: 2, label: '//:package' },
    ],
    configuration: [{ id: 1, mnemonic: 'fixture' }],
    depSetOfFiles: [
      { id: 1, directArtifactIds: [1] },
      { id: 2, directArtifactIds: [2, 3] },
    ],
    actions: [
      {
        targetId: 1,
        configurationId: 1,
        actionKey: 'compile-action',
        mnemonic: 'CppCompile',
        inputDepSetIds: [1],
        outputIds: [3],
        primaryOutputId: 3,
        arguments: ['cc', 'src/alpha.c'],
      },
      {
        targetId: 2,
        configurationId: 1,
        actionKey: 'package-action',
        mnemonic: 'Package',
        inputDepSetIds: [2],
        outputIds: [4],
        primaryOutputId: 4,
        arguments: ['pack', '1.2.3'],
      },
    ],
  };
  return { exported, graph };
}

function observedFixture(product = 'alpha', configuration = 'a'.repeat(64)) {
  const { exported, graph } = fixture();
  for (const pkg of exported.packages) pkg.product = product;
  const view = buildShippingInputView(exported, graph);
  const capture = (path: string) => ({
    path,
    members: [{ path: '', type: 'file', mode: 0o644, size: 1, sha256: '1'.repeat(64) }],
  });
  return {
    product: { id: product, version: view.products[product].version },
    construction: [
      {
        roots: exported.packages.map((pkg) => ({
          label: pkg.outputs[0].owner,
          configuration,
          package: pkg,
        })),
        actions: view.products[product].actions,
        inputs: view.physicalInputs.map(capture),
        leafInputPaths: view.products[product].inputs,
        analysisInputPaths: ['BUILD.bazel', 'build_defs/package.bzl'],
        analysisInputs: ['BUILD.bazel', 'build_defs/package.bzl'].map(capture),
      },
    ],
  };
}

function capturedMember(
  view: ReturnType<typeof observedFixture>['construction'][number],
  path: string,
) {
  const capture = view.inputs.find((file) => file.path === path);
  if (!capture) throw new Error(`fixture has no captured input: ${path}`);
  return capture.members[0];
}

test('captured shipping footprints leave docs and test-only changes to Bazel execution', () => {
  const before = observedFixture();
  const current = structuredClone(before);
  // The execution graph can contain other test inputs. Shipping leaf projection
  // must neither classify them as payload changes nor suppress their Bazel test.
  current.construction[0].inputs.push({
    path: 'test/alpha.test.ts',
    members: [{ path: '', type: 'file', mode: 0o644, size: 2, sha256: '2'.repeat(64) }],
  });
  expect(selectObservedShippingChanges([current], { alpha: before })).toEqual({
    affectedProducts: [],
    unclassifiedPaths: [],
    unknownProducts: [],
  });
  capturedMember(current.construction[0], 'bazel-out/alpha.o').sha256 = '3'.repeat(64);
  expect(selectObservedShippingChanges([current], { alpha: before }).affectedProducts).toEqual([]);
});

test('source and external tool bytes request checks without directory ownership', () => {
  for (const changed of ['src/alpha.c', 'tools/packager', 'external/toolchain/compiler']) {
    const before = observedFixture();
    if (changed.startsWith('external/')) {
      before.construction[0].leafInputPaths.push(changed);
      before.construction[0].inputs.push({
        path: changed,
        members: [{ path: '', type: 'file', mode: 0o755, size: 1, sha256: '1'.repeat(64) }],
      });
    }
    const current = structuredClone(before);
    capturedMember(current.construction[0], changed).sha256 = '2'.repeat(64);
    expect(selectObservedShippingChanges([current], { alpha: before })).toEqual({
      affectedProducts: ['alpha'],
      unclassifiedPaths: [],
      unknownProducts: [],
    });
  }
});

test('loaded recipe content and configured action changes request construction checks', () => {
  const before = observedFixture();
  const recipe = structuredClone(before);
  recipe.construction[0].analysisInputs[1].members[0].sha256 = '2'.repeat(64);
  expect(selectObservedShippingChanges([recipe], { alpha: before }).affectedProducts).toEqual([
    'alpha',
  ]);
  const action = structuredClone(before);
  action.construction[0].actions[0] = action.construction[0].actions[0].replace('cc', 'clang');
  expect(selectObservedShippingChanges([action], { alpha: before }).affectedProducts).toEqual([
    'alpha',
  ]);
});

test('missing historical metadata or causal maps remain required and unknown', () => {
  const current = observedFixture();
  expect(selectObservedShippingChanges([current], {})).toEqual({
    affectedProducts: ['alpha'],
    unclassifiedPaths: [],
    unknownProducts: ['alpha'],
  });
  const legacy = structuredClone(current) as any;
  delete legacy.construction[0].analysisInputPaths;
  delete legacy.construction[0].analysisInputs;
  expect(selectObservedShippingChanges([current], { alpha: legacy }).unknownProducts).toEqual([
    'alpha',
  ]);
  const incomplete = structuredClone(current);
  incomplete.construction[0].inputs = [];
  expect(() => selectObservedShippingChanges([incomplete], { alpha: current })).toThrow(
    'shipping causal File was not captured',
  );
});

test('configured captures preserve context when one logical tool path has different host bytes', () => {
  const before = observedFixture();
  const other = observedFixture('alpha', 'b'.repeat(64));
  capturedMember(other.construction[0], 'src/alpha.c').sha256 = '2'.repeat(64);
  before.construction.push(other.construction[0]);
  const current = structuredClone(before);
  current.construction.reverse();
  expect(selectObservedShippingChanges([current], { alpha: before }).affectedProducts).toEqual([]);
  // Swapping the same two byte identities between configured roots is a change.
  capturedMember(current.construction[0], 'src/alpha.c').sha256 = '1'.repeat(64);
  capturedMember(current.construction[1], 'src/alpha.c').sha256 = '2'.repeat(64);
  expect(selectObservedShippingChanges([current], { alpha: before }).affectedProducts).toEqual([
    'alpha',
  ]);
});

test('few and many owners compare their own completed footprints coherently', () => {
  const before = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((id) => observedFixture(id));
  const baselines = Object.fromEntries(before.map((product) => [product.product.id, product]));
  for (const changed of [
    [],
    ['beta'],
    ['alpha', 'gamma', 'epsilon'],
    before.map((p) => p.product.id),
  ]) {
    const current = structuredClone(before);
    for (const product of current)
      if (changed.includes(product.product.id))
        capturedMember(product.construction[0], 'src/alpha.c').sha256 = '2'.repeat(64);
    expect(selectObservedShippingChanges(current, baselines).affectedProducts).toEqual(
      [...changed].sort(),
    );
  }
});

test('a proven unchanged footprint cannot explain changed delivered bytes', () => {
  const current = observedFixture();
  const different = [{ product: 'alpha', deliveryStatus: 'different' }];
  expect(() => selectObservedShippingChanges([current], { alpha: current }, different)).toThrow(
    'unchanged shipping inputs produced different delivery: alpha',
  );
  expect(selectObservedShippingChanges([current], {}, different).affectedProducts).toEqual([
    'alpha',
  ]);
  expect(
    selectObservedShippingChanges([current], { alpha: current }, [
      { product: 'alpha', deliveryStatus: 'identical' },
    ]).affectedProducts,
  ).toEqual([]);
});

test('shipping source and packager inputs follow actual producer edges', () => {
  const { exported, graph } = fixture();
  const view = buildShippingInputView(exported, graph);
  expect(view.products.alpha.inputs).toEqual(['src/alpha.c', 'tools/packager']);
  expect(view.products.alpha.actions).toHaveLength(2);
  expect(selectShippingChanges(view.products, view, { alpha: [] })).toEqual({
    affectedProducts: [],
    unclassifiedPaths: [],
  });
  expect(
    selectShippingChanges(view.products, view, { alpha: ['tools/packager'] }).affectedProducts,
  ).toEqual(['alpha']);
  expect(selectShippingChanges(view.products, view, { alpha: ['test/alpha.test.c'] })).toEqual({
    affectedProducts: [],
    unclassifiedPaths: ['test/alpha.test.c'],
  });
});

test('supplier File checks retain each sibling closure without changing the shared product view', () => {
  const { exported, graph } = fixture();
  exported.packages.push({
    ...exported.packages[0],
    name: '@example/alpha-objects',
    outputs: [{ path: 'bazel-out/alpha.o', owner: '//:compile' }],
  });
  const before = buildShippingInputView(exported, graph);
  const observed = new Map();
  const requested = ['bazel-out/alpha.o', 'src/alpha.c', 'tools/packager', 'missing/input'];
  expect(
    buildShippingInputView(exported, graph, {
      inspectPackageInputs: (pkg, consumes) => observed.set(pkg.name, requested.filter(consumes)),
    }),
  ).toEqual(before);
  expect(observed.get('@example/alpha')).toEqual([
    'bazel-out/alpha.o',
    'src/alpha.c',
    'tools/packager',
  ]);
  expect(observed.get('@example/alpha-objects')).toEqual(['src/alpha.c']);
  graph.actions[0].mnemonic = 'Middleman';
  observed.clear();
  buildShippingInputView(exported, graph, {
    inspectPackageInputs: (pkg, consumes) => observed.set(pkg.name, requested.filter(consumes)),
  });
  expect(observed.get('@example/alpha')).toEqual(['src/alpha.c', 'tools/packager']);
});

test('supplier File checks resolve transitive dep sets and reject the root File itself', () => {
  const { exported, graph } = fixture();
  graph.depSetOfFiles[1].transitiveDepSetIds = [3];
  graph.depSetOfFiles.push({ id: 3, directArtifactIds: [1] });
  const observed: Record<string, boolean> = {};
  const before = buildShippingInputView(exported, graph);
  expect(
    buildShippingInputView(exported, graph, {
      inspectPackageInputs(_pkg, consumes) {
        for (const name of ['src/alpha.c', 'bazel-out/alpha.o', 'bazel-out/package.tgz'])
          observed[name] = consumes(name);
      },
    }),
  ).toEqual(before);
  expect(observed).toEqual({
    'src/alpha.c': true,
    'bazel-out/alpha.o': true,
    'bazel-out/package.tgz': false,
  });
});

test('GitHub candidate inputs can share one producer across component releases', () => {
  const { exported, graph } = fixture();
  const first = exported.packages[0];
  first.ecosystem = 'github';
  first.name = 'shared-ios-carriers.json';
  first.role = 'release-input';
  exported.packages.push({ ...first, product: 'beta', version: '2.3.4' });
  const view = buildShippingInputView(exported, graph);
  expect(view.products.alpha.version).toBe('1.2.3');
  expect(view.products.beta.version).toBe('2.3.4');
  expect(view.products.beta.inputs).toEqual(view.products.alpha.inputs);
  expect(view.products.beta.actions).toEqual(view.products.alpha.actions);
  exported.packages.push({ ...first });
  expect(() => buildShippingInputView(exported, graph)).toThrow('duplicate shipping identity');
});

test('registry identity ownership remains globally unique across products', () => {
  for (const ecosystem of ['cargo', 'npm', 'maven']) {
    const { exported, graph } = fixture();
    const first = exported.packages[0];
    first.ecosystem = ecosystem;
    exported.packages.push({ ...first, product: 'beta', version: '2.3.4' });
    expect(() => buildShippingInputView(exported, graph)).toThrow('duplicate shipping identity');
  }
});

test('before and after roots handle deletion, renaming, removed packages and different baselines', () => {
  const { exported, graph } = fixture();
  const before = buildShippingInputView(exported, graph);
  graph.pathFragments[1].label = 'renamed.c';
  const after = buildShippingInputView(exported, graph);
  expect(
    selectShippingChanges(before.products, after, { alpha: ['src/alpha.c', 'src/renamed.c'] }),
  ).toEqual({
    affectedProducts: ['alpha'],
    unclassifiedPaths: [],
  });
  expect(selectShippingChanges({}, after, {}).affectedProducts).toEqual(['alpha']);
  expect(
    selectShippingChanges(before.products, { ...after, products: {} }, { alpha: [] })
      .affectedProducts,
  ).toEqual(['alpha']);
  graph.actions[1].arguments[1] = '2.0.0';
  expect(
    selectShippingChanges(after.products, buildShippingInputView(exported, graph), { alpha: [] })
      .affectedProducts,
  ).toEqual(['alpha']);
});

test('already delivered shared-source changes do not select a newer product baseline', () => {
  const { exported, graph } = fixture();
  const view = buildShippingInputView(exported, graph);
  view.products.beta = structuredClone(view.products.alpha);
  expect(selectShippingChanges(view.products, view, { alpha: ['src/alpha.c'], beta: [] })).toEqual({
    affectedProducts: ['alpha'],
    unclassifiedPaths: [],
  });
  expect(() => selectShippingChanges(view.products, view, { alpha: [] })).toThrow(
    'missing product baseline delta for beta',
  );
});

function aliasedFixture() {
  const { exported, graph } = fixture();
  graph.artifacts.push({ id: 5, pathFragmentId: 6 });
  graph.targets.push({ id: 3, label: '//:other-compile' });
  graph.actions.push({ ...graph.actions[0], targetId: 3, outputIds: [5], primaryOutputId: 5 });
  graph.depSetOfFiles[1].directArtifactIds.push(5);
  return { exported, graph };
}

test('identical configured action aliases share a path; conflicting producers fail', () => {
  const { exported, graph } = aliasedFixture();
  expect(buildShippingInputView(exported, graph).products.alpha.inputs).toEqual([
    'src/alpha.c',
    'tools/packager',
  ]);
  graph.actions[2].arguments = ['different-compiler', 'src/alpha.c'];
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
});

test('action aliases require complete keys, configuration and primary outputs', () => {
  for (const field of ['actionKey', 'configurationId', 'primaryOutputId']) {
    const { exported, graph } = aliasedFixture();
    Reflect.deleteProperty(graph.actions[2], field);
    expect(() => buildShippingInputView(exported, graph)).toThrow();
  }
  let { exported, graph } = aliasedFixture();
  graph.actions[2].actionKey = 'different-action';
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
  ({ exported, graph } = aliasedFixture());
  graph.actions[2].configurationId = 99;
  expect(() => buildShippingInputView(exported, graph)).toThrow('incomplete aquery');
  ({ exported, graph } = aliasedFixture());
  graph.configuration.push({ id: 2, mnemonic: 'other-configuration' });
  graph.actions[2].configurationId = 2;
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
  ({ exported, graph } = aliasedFixture());
  graph.actions[2].primaryOutputId = 4;
  expect(() => buildShippingInputView(exported, graph)).toThrow('primary output is missing');
});

test('shared outputs retain Bazel output order and primary output semantics', () => {
  const { exported, graph } = aliasedFixture();
  graph.pathFragments.push({ id: 8, parentId: 5, label: 'alpha.metadata' });
  graph.artifacts.push({ id: 6, pathFragmentId: 8 }, { id: 7, pathFragmentId: 8 });
  graph.actions[0].outputIds.push(6);
  graph.actions[2].outputIds.push(7);
  expect(buildShippingInputView(exported, graph).products.alpha.inputs).toEqual([
    'src/alpha.c',
    'tools/packager',
  ]);
  graph.actions[2].outputIds.reverse();
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
  graph.actions[2].outputIds.reverse();
  graph.actions[2].primaryOutputId = 7;
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
});

test('an exported shared output resolves its exact declared owner', () => {
  const { exported, graph } = fixture();
  graph.artifacts.unshift({ id: 5, pathFragmentId: 7 });
  graph.targets.push({ id: 3, label: '//:other-package' });
  graph.actions.push({ ...graph.actions[1], targetId: 3, outputIds: [5], primaryOutputId: 5 });
  const view = buildShippingInputView(exported, graph);
  expect(view.products.alpha.actions.map((action) => JSON.parse(action).target).sort()).toEqual([
    '//:compile',
    '//:package',
  ]);
});

test('shared producers require the same ordered physical inputs', () => {
  const { exported, graph } = aliasedFixture();
  graph.depSetOfFiles[0].directArtifactIds.push(2);
  expect(buildShippingInputView(exported, graph).products.alpha.inputs).toEqual([
    'src/alpha.c',
    'tools/packager',
  ]);
  graph.depSetOfFiles.push({ id: 3, directArtifactIds: [2, 1] });
  graph.actions[2].inputDepSetIds = [3];
  expect(() => buildShippingInputView(exported, graph)).toThrow('ambiguous artifact producers');
});

test('repeated native Symlink records preserve one complete producer and exact ownership', () => {
  // Minimized from Bazel 8.8.1 rules_rust toolchain aquery: the same Symlink
  // record occurs twice with one artifact ID when Cargo is used for inventory.
  const { exported, graph } = fixture();
  const action = graph.actions[0];
  action.mnemonic = 'Symlink';
  action.actionKey = '7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac';
  Reflect.deleteProperty(action, 'arguments');
  Reflect.set(action, 'executionPlatform', '@@platforms//host:host');
  const before = buildShippingInputView(exported, graph);
  graph.actions.push(structuredClone(action));
  expect(buildShippingInputView(exported, graph)).toEqual(before);
  for (const field of ['actionKey', 'configurationId', 'primaryOutputId']) {
    const malformed = structuredClone(graph);
    Reflect.deleteProperty(malformed.actions[0], field);
    Reflect.deleteProperty(malformed.actions[2], field);
    expect(() => buildShippingInputView(exported, malformed)).toThrow();
  }
  for (const [field, value] of [
    ['arguments', ['different-command']],
    ['environmentVariables', [{ key: 'CHANGED', value: '1' }]],
    ['executionPlatform', '//:different-platform'],
    ['targetId', 2],
  ] as const) {
    const conflicting = structuredClone(graph);
    Reflect.set(conflicting.actions[2], field, value);
    expect(() => buildShippingInputView(exported, conflicting)).toThrow('multiple producers');
  }
  exported.packages[0].outputs[0].owner = '//:other';
  expect(() => buildShippingInputView(exported, graph)).toThrow('owner disagrees');
});

test('partial, substituted or cyclic graphs fail closed', () => {
  let { exported, graph } = fixture();
  exported.packages[0].outputs[0].owner = '//:other';
  expect(() => buildShippingInputView(exported, graph)).toThrow('owner disagrees');
  ({ exported, graph } = fixture());
  graph.artifacts.pop();
  expect(() => buildShippingInputView(exported, graph)).toThrow('incomplete aquery');
  ({ exported, graph } = fixture());
  graph.depSetOfFiles.push({ id: 1, directArtifactIds: [1] });
  expect(() => buildShippingInputView(exported, graph)).toThrow('duplicate aquery id');
  ({ exported, graph } = fixture());
  graph.actions[0].inputDepSetIds = [2];
  expect(() => buildShippingInputView(exported, graph)).toThrow('cycle in aquery producers');
  ({ exported, graph } = fixture());
  graph.actions.push({ ...graph.actions[1], actionKey: 'conflicting-package-action' });
  expect(() => buildShippingInputView(exported, graph)).toThrow('multiple producers');
  ({ exported, graph } = fixture());
  graph.actions.shift();
  expect(() => buildShippingInputView(exported, graph)).toThrow('missing generated input producer');
});

test('compact descriptions bind exact sorted physical input sets and retain the full capture closure', () => {
  const { exported, graph } = fixture();
  const view = buildShippingInputView(exported, graph);
  const actions = view.products.alpha.actions.map((action) => JSON.parse(action));
  expect(view.schema).toBe('oliphaunt-bazel-construction-inputs-v2');
  expect(view.physicalInputs).toEqual(['bazel-out/alpha.o', 'src/alpha.c', 'tools/packager']);
  expect(view.captureInputs).toEqual(['src/alpha.c', 'tools/packager']);
  const packageInputs = ['bazel-out/alpha.o', 'tools/packager'];
  expect(actions.find((action) => action.target === '//:package').inputs).toEqual({
    count: packageInputs.length,
    sha256: createHash('sha256').update(JSON.stringify(packageInputs)).digest('hex'),
  });
  expect(() =>
    selectShippingChanges(
      view.products,
      { ...view, schema: 'oliphaunt-bazel-construction-inputs-v1' } as any,
      { alpha: [] },
    ),
  ).toThrow('unsupported construction input view');
});

test('input-set factoring, ordering and query-local ID changes do not change normalized declarations', () => {
  const { exported, graph } = fixture();
  const before = buildShippingInputView(exported, graph);
  graph.depSetOfFiles[1].directArtifactIds = [];
  Reflect.set(graph.depSetOfFiles[1], 'transitiveDepSetIds', [3, 4]);
  graph.depSetOfFiles.push({ id: 3, directArtifactIds: [3] }, { id: 4, directArtifactIds: [2] });
  for (const set of graph.depSetOfFiles) {
    set.id += 100;
    const children = Reflect.get(set, 'transitiveDepSetIds');
    if (children)
      Reflect.set(set, 'transitiveDepSetIds', children.map((id: number) => id + 100).reverse());
  }
  for (const action of graph.actions)
    action.inputDepSetIds = action.inputDepSetIds.map((id) => id + 100);
  graph.depSetOfFiles.reverse();
  graph.actions.reverse();
  graph.pathFragments.reverse();
  expect(buildShippingInputView(exported, graph)).toEqual(before);
});

test('same-count input edge swaps and command changes remain visible with identical source and capture unions', () => {
  const { exported, graph } = fixture();
  const before = buildShippingInputView(exported, graph);
  graph.depSetOfFiles[0].directArtifactIds = [2];
  graph.depSetOfFiles[1].directArtifactIds = [1, 3];
  const swapped = buildShippingInputView(exported, graph);
  expect(swapped.physicalInputs).toEqual(before.physicalInputs);
  expect(swapped.products.alpha.inputs).toEqual(before.products.alpha.inputs);
  expect(swapped.products.alpha.actions).not.toEqual(before.products.alpha.actions);
  expect(selectShippingChanges(before.products, swapped, { alpha: [] }).affectedProducts).toEqual([
    'alpha',
  ]);
  graph.actions[0].arguments.push('-DCHANGED=1');
  const command = buildShippingInputView(exported, graph);
  expect(command.physicalInputs).toEqual(swapped.physicalInputs);
  expect(command.products.alpha.actions).not.toEqual(swapped.products.alpha.actions);
});

test('physical source aliases collapse only after validation and repository paths stay distinct', () => {
  const { exported, graph } = fixture();
  const before = buildShippingInputView(exported, graph);
  graph.artifacts.push({ id: 5, pathFragmentId: 2 });
  graph.depSetOfFiles[0].directArtifactIds.push(5);
  expect(buildShippingInputView(exported, graph)).toEqual(before);
  graph.pathFragments.push(
    { id: 8, label: 'external' },
    { id: 9, parentId: 8, label: 'dependency' },
    { id: 10, parentId: 9, label: 'src' },
    { id: 11, parentId: 10, label: 'alpha.c' },
  );
  graph.artifacts.push({ id: 6, pathFragmentId: 11 });
  graph.depSetOfFiles[0].directArtifactIds.push(6);
  const external = buildShippingInputView(exported, graph);
  expect(external.physicalInputs).toContain('src/alpha.c');
  expect(external.physicalInputs).toContain('external/dependency/src/alpha.c');
  expect(external.products.alpha.actions).not.toEqual(before.products.alpha.actions);
});

test('only declared virtual Middleman outputs are removed from the physical closure', () => {
  const { exported, graph } = fixture();
  graph.actions[0].mnemonic = 'Middleman';
  const view = buildShippingInputView(exported, graph);
  expect(view.physicalInputs).toEqual(['src/alpha.c', 'tools/packager']);
  expect(view.products.alpha.actions).toHaveLength(2);
  graph.actions.shift();
  expect(() => buildShippingInputView(exported, graph)).toThrow('missing generated input producer');
});

test('reused compiler headers remain complete without multiplying retained descriptions', () => {
  const { exported, graph } = fixture();
  for (let index = 0; index < 2048; index++) {
    const id = 100 + index;
    graph.pathFragments.push({ id, parentId: 1, label: `header-${index}.h` });
    graph.artifacts.push({ id, pathFragmentId: id });
    graph.depSetOfFiles[0].directArtifactIds.push(id);
  }
  const compiler = graph.actions[0];
  for (let index = 0; index < 128; index++) {
    const id = 10000 + index;
    graph.pathFragments.push({ id, parentId: 5, label: `object-${index}.o` });
    graph.artifacts.push({ id, pathFragmentId: id });
    graph.actions.push({
      ...compiler,
      actionKey: `compile-${index}`,
      outputIds: [id],
      primaryOutputId: id,
    });
    graph.depSetOfFiles[1].directArtifactIds.push(id);
  }
  const view = buildShippingInputView(exported, graph);
  expect(view.products.alpha.inputs).toHaveLength(2050);
  expect(view.physicalInputs).toHaveLength(2179);
  expect(view.products.alpha.actions).toHaveLength(130);
  expect(JSON.stringify(view).length).toBeLessThan(512_000);
});

test('only consumed typed supplier Files join the required byte frontier', () => {
  const { exported, graph } = fixture();
  const pkg = exported.packages[0] as any;
  pkg.supplierInputs = [
    {
      product: 'supplier',
      version: '1.0.0',
      configuration: 'linux-x64',
      binding: 'abi-contract',
      origin: { kind: 'current-source' },
      files: [{ path: 'bazel-out/alpha.o' }],
    },
  ];
  expect(buildShippingInputView(exported, graph).captureInputs).toEqual([
    'bazel-out/alpha.o',
    'src/alpha.c',
    'tools/packager',
  ]);
  pkg.supplierInputs[0].files[0].path = 'unconsumed';
  expect(buildShippingInputView(exported, graph).captureInputs).toEqual([
    'src/alpha.c',
    'tools/packager',
  ]);
});
