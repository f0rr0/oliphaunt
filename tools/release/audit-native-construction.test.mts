import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { assertNativeConstructionAudit } from './audit-native-construction.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const products = loadPublicationCatalog('native construction audit fixture').products;
const swiftRoot = '//src/native/sdks/swift:shipping_Oliphaunt-source_zip';

// Structural observations exercise this diagnostic predicate only. These are
// neither authenticated origins nor physical packages, and grant no authority.
function fixture() {
  const cohorts = [0, 1, 2].map((part) => {
    const configuration = String(part + 1).repeat(64);
    const roots = products
      .filter((_, index) => index % 3 === part)
      .map((product) => ({
        label: product.id === 'oliphaunt-swift' ? swiftRoot : `//fixture/${product.id}:shipping`,
        configuration,
        package: {
          product: product.id,
          version: product.version,
          ecosystem: product.id === 'oliphaunt-swift' ? 'github' : 'npm',
          name: product.id === 'oliphaunt-swift' ? 'Oliphaunt-source.zip' : product.id,
          role: product.id === 'oliphaunt-swift' ? 'release-input' : 'facade',
          configuration: 'portable',
          outputs: [
            {
              path: `bazel-out/fixture/${product.id}/package`,
              owner: `//fixture/${product.id}:package`,
            },
          ],
        },
      }));
    const policies = roots.map((root) => ({
      owner:
        root.package.product === 'oliphaunt-swift'
          ? '//src/native/sdks/swift:preparation_shipping_export'
          : `//fixture/${root.package.product}:shipping_export`,
      roots: [root.label],
      requiredTests: [{ label: `//fixture/${root.package.product}:consumer_test`, configuration }],
    }));
    return {
      invocationId: `fixture-${part}`,
      roots,
      qualificationPolicy: {
        owner: `//fixture:cohort_${part}`,
        configuration,
        roots: roots.map((root) => root.label),
        rootConfigurations: roots.map(({ label, configuration }) => ({ label, configuration })),
        requiredTests: policies.flatMap((policy) => policy.requiredTests),
        policies,
      },
    };
  });
  const authenticated = cohorts.map((cohort) => ({
    evidence: {
      source: { ...source },
      cohorts: [{ roots: cohort.roots.map(({ configuration: _, ...root }) => root) }],
    },
    qualification: {
      source: { ...source },
      shippingAnalysis: 'bound',
      testQualification: 'passed',
      qualificationPolicy: 'bound',
      requiredTests: cohort.qualificationPolicy.requiredTests.map((test) => ({
        ...test,
        invocationId: cohort.invocationId,
      })),
      cohorts: [cohort],
    },
  }));
  const roots = cohorts.flatMap((cohort) => cohort.roots);
  const consumer = roots.find((root) => root.package.product === 'oliphaunt-js');
  const producer = roots.find((root) => root.package.product === 'liboliphaunt-wasix');
  assert.ok(consumer);
  assert.ok(producer);
  return {
    source: { ...source },
    expectedProducts: structuredClone(products),
    candidate: {
      scope: 'construction',
      source: { ...source },
      artifactPhase: 'pre-version',
      products: structuredClone(products),
      missing: [] as string[],
    },
    observation: {
      products: products.map((product) => ({
        product: structuredClone(product),
        construction: [
          {
            roots: cohorts
              .flatMap((cohort) => cohort.roots)
              .filter((root) => root.package.product === product.id),
            actions: [],
            inputs: [],
            leafInputPaths: [],
            analysisInputPaths: [] as string[],
          },
        ],
      })),
      authenticated,
      coverage: { completeProductInventory: true, releaseInputsRequired: true },
    },
    suppliers: {
      scope: 'construction',
      source: { ...source },
      suppliers: [
        {
          consumer: 'oliphaunt-js',
          product: 'liboliphaunt-wasix',
          version: producer.package.version,
          configuration: 'portable',
          binding: 'compiled-input',
          origin: { kind: 'current-source' },
          files: [{ path: producer.package.outputs[0].path }],
          root: consumer.label,
          consumerConfiguration: 'portable',
          rootConfiguration: consumer.configuration,
        },
      ],
      unknowns: [] as string[],
      buildBound: new Map(
        products.map((product) => [
          product.id,
          new Set(product.id === 'oliphaunt-js' ? ['liboliphaunt-wasix'] : []),
        ]),
      ),
    },
  };
}

const audit = (input: ReturnType<typeof fixture>) => assertNativeConstructionAudit(input as any);

test('all 27 owner observations compose through partial cohorts into construction diagnostics', () => {
  const input = fixture();
  expect(products).toHaveLength(27);
  expect(
    input.observation.authenticated.every(
      (build) => build.qualification.cohorts[0].roots.length < 27,
    ),
  ).toBe(true);
  const result = audit(input);
  expect(result).toEqual({
    scope: 'construction',
    source,
    products: products.map((product) => product.id).sort(),
    configuredRoots: 27,
    supplierBindings: 1,
  });
  expect(Object.keys(result).sort()).toEqual([
    'configuredRoots',
    'products',
    'scope',
    'source',
    'supplierBindings',
  ]);
  input.source.commit = 'f'.repeat(40);
  expect(result.source).toEqual(source);
});

test('already-validated final Swift facts compose into the same construction audit', () => {
  const input = fixture();
  const build = input.observation.authenticated.find((build) =>
    build.qualification.cohorts.some((cohort) =>
      cohort.roots.some((root) => root.label === swiftRoot),
    ),
  );
  assert.ok(build);
  const cohort = build.qualification.cohorts[0];
  const policy = cohort.qualificationPolicy.policies.find((policy) =>
    policy.roots.includes(swiftRoot),
  );
  assert.ok(policy);
  policy.owner = '//src/native/sdks/swift:shipping_export';
  const installedTest = {
    label: '//src/native/sdks/swift:installed_consumer_test',
    configuration: cohort.qualificationPolicy.configuration,
  };
  policy.requiredTests.push(installedTest);
  cohort.qualificationPolicy.requiredTests.push(installedTest);
  build.qualification.requiredTests.push({
    ...installedTest,
    invocationId: cohort.invocationId,
  });
  expect(audit(input).scope).toBe('construction');
});

const faults: [string, (input: ReturnType<typeof fixture>) => void][] = [
  [
    'dropped owner',
    (input) => {
      input.candidate.products.pop();
      input.observation.products.pop();
    },
  ],
  [
    'wrong candidate source',
    (input) => {
      input.candidate.source.tree = 'f'.repeat(40);
    },
  ],
  [
    'wrong producer source',
    (input) => {
      input.observation.authenticated[0].evidence.source.tree = 'f'.repeat(40);
    },
  ],
  [
    'wrong qualified source',
    (input) => {
      input.observation.authenticated[0].qualification.source.tree = 'f'.repeat(40);
    },
  ],
  [
    'wrong observed version',
    (input) => {
      input.observation.products[0].product.version = '9.9.9';
    },
  ],
  [
    'missing loaded recipe view',
    (input) => {
      delete (input.observation.products[0].construction[0] as { analysisInputPaths?: string[] })
        .analysisInputPaths;
    },
  ],
  [
    'missing configured owner',
    (input) => {
      input.observation.authenticated[0].qualification.cohorts[0].roots.pop();
      input.observation.authenticated[0].evidence.cohorts[0].roots.pop();
    },
  ],
  [
    'wrong supplier source',
    (input) => {
      input.suppliers.source.tree = 'f'.repeat(40);
    },
  ],
  [
    'supplier unknown',
    (input) => {
      input.suppliers.unknowns.push('missing configured supplier');
    },
  ],
  [
    'incomplete supplier map',
    (input) => {
      input.suppliers.buildBound.delete(products[0].id);
    },
  ],
  [
    'foreign supplier producer',
    (input) => {
      const suppliers = input.suppliers.buildBound.get(products[0].id);
      assert.ok(suppliers);
      suppliers.add('unknown-producer');
    },
  ],
  [
    'publication scope',
    (input) => {
      input.candidate.scope = 'publication';
    },
  ],
  [
    'missing final inputs',
    (input) => {
      input.candidate.missing.push('npm:missing');
    },
  ],
  [
    'incomplete configured inventory',
    (input) => {
      input.observation.coverage.completeProductInventory = false;
    },
  ],
  [
    'unchecked release inputs',
    (input) => {
      input.observation.coverage.releaseInputsRequired = false;
    },
  ],
  [
    'final version envelope',
    (input) => {
      input.candidate.artifactPhase = 'final';
    },
  ],
];

for (const [name, corrupt] of faults)
  test(`construction audit rejects ${name}`, () => {
    const input = fixture();
    corrupt(input);
    expect(() => audit(input)).toThrow();
  });
