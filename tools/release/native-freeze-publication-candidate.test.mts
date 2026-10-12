import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  admitNativePublicationCandidate,
  assertAdmittedNativePublicationCandidate,
  assertSelectedNativeEnvelope,
  assertSuccessfulNativePublicationRun,
  nativeSwiftFixtureRequest,
} from './native-freeze-publication-candidate.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import {
  expectedProductArtifactRows,
  freezeNativePublicationCandidate,
} from './publication-lock.mts';

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const successful = {
  id: 77,
  run_attempt: 2,
  head_sha: source.commit,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/bazel.yml',
  name: 'Native Bazel qualification',
  status: 'completed',
  conclusion: 'success',
};
test('post-version publication accepts only the exact successful main Native run', () => {
  expect(() => assertSuccessfulNativePublicationRun(successful, source)).not.toThrow();
  for (const [field, value] of [
    ['id', 0],
    ['run_attempt', 0],
    ['head_sha', 'c'.repeat(40)],
    ['head_branch', 'feature'],
    ['event', 'pull_request'],
    ['path', '.github/workflows/ci.yml'],
    ['name', 'CI Builds'],
    ['status', 'in_progress'],
    ['conclusion', 'failure'],
  ])
    expect(() =>
      assertSuccessfulNativePublicationRun({ ...successful, [field]: value }, source),
    ).toThrow();
});

function envelopes() {
  const products = ['sdk', 'query', 'broker'].map((id, index) => ({
    id,
    version: `0.${index + 1}.0`,
  }));
  const carriers = products.map(({ id, version }, index) => ({
    id: `npm:${id}`,
    product: id,
    version,
    ecosystem: 'npm',
    name: id,
    dependencies: [],
    publishOrder: index,
    packageDependencies: [
      { ecosystem: 'npm', name: 'held', requirement: '1.2.3', scope: 'optional' },
    ],
    artifacts: [{ path: `target/${id}.tgz`, sha256: `${index + 1}`.repeat(64), size: 100 + index }],
  }));
  const artifacts = products.map(({ id }, index) => ({
    id: `github-release:${id}.tar.gz`,
    product: id,
    kind: 'native-runtime',
    path: `target/${id}.tar.gz`,
    sha256: `${index + 1}`.repeat(64),
    size: 200 + index,
  }));
  return { source, products, carriers, productArtifacts: artifacts, artifactPhase: 'pre-version' };
}
function select(full, products: string[]) {
  const copy = structuredClone(full);
  return {
    ...copy,
    artifactPhase: 'final',
    products: copy.products.filter(({ id }) => products.includes(id)),
    carriers: copy.carriers
      .filter(({ product }) => products.includes(product))
      .map((row, publishOrder) => ({ ...row, publishOrder })),
    productArtifacts: copy.productArtifacts.filter(({ product }) => products.includes(product)),
  };
}
test('one or several products project original byte identities without retargeting held requirements', () => {
  const full = envelopes();
  for (const ids of [['query'], ['sdk', 'broker'], ['sdk', 'query', 'broker']]) {
    const candidate = select(full, ids);
    expect(() => assertSelectedNativeEnvelope(candidate as any, full as any, ids)).not.toThrow();
    expect(full.carriers.filter(({ product }) => !ids.includes(product))).toEqual(
      envelopes().carriers.filter(({ product }) => !ids.includes(product)),
    );
  }
});
test('scope, source, manifest requirement and carrier payload substitutions fail before freeze', () => {
  const full = envelopes();
  for (const mutate of [
    (candidate) => {
      candidate.source.commit = 'c'.repeat(40);
    },
    (candidate) => {
      candidate.products.push(full.products[0]);
    },
    (candidate) => {
      candidate.carriers[0].version = '9.0.0';
    },
    (candidate) => {
      candidate.carriers[0].packageDependencies[0].requirement = '9.0.0';
    },
    (candidate) => {
      candidate.carriers[0].artifacts[0].sha256 = 'f'.repeat(64);
    },
    (candidate) => {
      candidate.productArtifacts[0].size++;
    },
    (candidate) => {
      candidate.artifactPhase = 'pre-version';
    },
  ]) {
    const candidate = select(full, ['query']);
    mutate(candidate);
    expect(() => assertSelectedNativeEnvelope(candidate as any, full as any, ['query'])).toThrow();
  }
  expect(() =>
    assertSelectedNativeEnvelope(select(full, ['query']) as any, full as any, ['query', 'query']),
  ).toThrow();
});
test('structural prepared inputs and raw observation JSON cannot mint admission', async () => {
  await expect(
    admitNativePublicationCandidate({
      candidate: {},
      complete: {},
      prepared: { record: { selectedProducts: ['query'] } },
      acquisition: { run: successful, origins: new Map(), builds: [] },
      observation: {},
      completed: [],
    } as any),
  ).rejects.toThrow(/authenticated Prepare producer/);
  expect(() => assertAdmittedNativePublicationCandidate({} as any)).toThrow(
    /authenticated publication admission/,
  );
  // The native freezer still validates the entire canonical envelope first.
  await expect(freezeNativePublicationCandidate({})).rejects.toThrow();
});

test('Swift fixture requests follow the original source requirements, not selected product co-occurrence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-swift-fixture-scope-'));
  const reference = (product, version) => ({ product, version, tag: `${product}-v${version}` });
  const artifact = (product, version, baseVersion, kind) => {
    const file = path.join(root, `${product}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        release: reference(product, version),
        base: reference('liboliphaunt-native', baseVersion),
      }),
    );
    return { product, kind, path: file };
  };
  try {
    const complete = {
      products: [
        { id: 'oliphaunt-swift', version: '1.0.0' },
        { id: 'liboliphaunt-native', version: '0.3.4' },
        { id: 'oliphaunt-extension-vector', version: '0.2.0' },
        { id: 'liboliphaunt-wasix', version: '0.3.4' },
      ],
      productArtifacts: [
        artifact('oliphaunt-swift', '1.0.0', '0.3.3', 'swiftpm-ios-carrier-manifest'),
        artifact('liboliphaunt-native', '0.3.4', '0.3.4', 'swift-extension-carrier'),
        artifact('oliphaunt-extension-vector', '0.2.0', '0.3.3', 'swift-extension-carrier'),
      ],
    } as any;
    for (const [selection, requested] of [
      [['oliphaunt-swift'], []],
      [['oliphaunt-swift', 'liboliphaunt-wasix'], []],
      [['oliphaunt-swift', 'liboliphaunt-native'], []],
      [['oliphaunt-swift', 'oliphaunt-extension-vector'], ['oliphaunt-extension-vector']],
      [
        ['oliphaunt-swift', 'oliphaunt-extension-vector', 'liboliphaunt-native'],
        ['oliphaunt-extension-vector'],
      ],
      [['liboliphaunt-native', 'oliphaunt-extension-vector'], []],
    ])
      expect(nativeSwiftFixtureRequest(complete, selection)).toEqual(requested);
    // Substituting a final control from another package version fails before
    // compatibility matching; no mismatched artifact is silently discarded.
    writeFileSync(
      complete.productArtifacts[2].path,
      JSON.stringify({
        release: reference('oliphaunt-extension-vector', '9.0.0'),
        base: reference('liboliphaunt-native', '9.0.0'),
      }),
    );
    expect(() =>
      nativeSwiftFixtureRequest(complete, ['oliphaunt-swift', 'oliphaunt-extension-vector']),
    ).toThrow(/carrier version differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact inventory records an explicit consumer input without reading current SDK adoption for historical locks', () => {
  const catalog = loadPublicationCatalog('actual Swift fixture scope', {
    products: ['oliphaunt-swift', 'liboliphaunt-native'],
  });
  const fixture = (options = {}) =>
    expectedProductArtifactRows(catalog.products, options).filter(
      ({ kind }) => kind === 'swiftpm-extension-consumer-fixture',
    );
  expect(fixture()).toHaveLength(0);
  expect(fixture({ swiftExtensionFixture: true })).toHaveLength(1);
  expect(fixture({ swiftExtensionFixture: true, artifactPhase: 'pre-version' })).toHaveLength(0);
  expect(() =>
    expectedProductArtifactRows(
      catalog.products.filter(({ id }) => id !== 'oliphaunt-swift'),
      { swiftExtensionFixture: true },
    ),
  ).toThrow(/source SDK product/);
});
