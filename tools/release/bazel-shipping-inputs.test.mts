import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildShippingInputView, selectShippingChanges } from './bazel-shipping-inputs.mts';

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
