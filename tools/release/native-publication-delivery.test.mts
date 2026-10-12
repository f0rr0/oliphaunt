import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageEnvelope } from '../../build_defs/native/carriers/envelopes.mts';
import {
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
} from '../../src/native/runtime/tools/native-runtime-payload.mts';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../packaging/portable-archive.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import type { CompletedPublication } from './completed-release-publication.mts';
import {
  bindNativeArchiveDelivery,
  captureCompletedNativeArchiveDelivery,
  compareCompletedNativeArchiveDelivery,
  compareNativePreVersionDelivery,
  differentNativeDeliveredMembers,
} from './native-publication-delivery.mts';
import {
  captureNativePreEnvelopePayloads,
  type NativePayloadCohort,
} from './native-publication-payloads.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { allArtifactTargets } from './release-artifact-targets.mts';

const source = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const ids = ['liboliphaunt-native', 'postgres-tools-native'];

test('canonical member equality preserves names, modes and every delivered identity field', () => {
  const file = { path: 'public.bin', mode: 0o644, type: 'file', size: 1, sha256: 'a'.repeat(64) };
  const directory = { path: '', mode: 0o755, type: 'directory' };
  expect(differentNativeDeliveredMembers([directory, file], [file, directory])).toEqual([]);
  for (const updated of [
    { ...file, path: 'renamed.bin' },
    { ...file, mode: 0o755 },
    { ...file, sha256: 'b'.repeat(64) },
    { ...file, size: 2 },
    { ...file, type: 'directory' },
  ])
    expect(differentNativeDeliveredMembers([file], [updated]).length).toBeGreaterThan(0);
  expect(() => differentNativeDeliveredMembers([file, file], [])).toThrow(/duplicate/);
  expect(() => differentNativeDeliveredMembers([{ ...file, path: '../outside' }], [])).toThrow(
    /unsafe/,
  );
});

// These origin shapes exercise the decision seam. Authentication, physical
// archive readers and owner-policy capture have their separate real fixtures.
function decisionFixture(
  ids = loadPublicationCatalog('native decision fixture').products.map(({ id }) => id),
) {
  const products = loadPublicationCatalog('native decision fixture', { products: ids }).products;
  const github = {
    repository: 'f0rr0/oliphaunt',
    workflow: 'Native Bazel qualification',
    workflowPath: '.github/workflows/bazel.yml',
    runId: 7,
    runAttempt: 1,
    job: 'Linux runtime (x86_64)',
  };
  const artifact = {
    id: 9,
    name: 'native-build-evidence-x86_64',
    digest: `sha256:${'d'.repeat(64)}`,
    size: 1,
  };
  const evidenceDigest = `sha256:${'e'.repeat(64)}`;
  const configuration = 'c'.repeat(64);
  const requiredTests = [
    { label: '//fixture:installed_test', configuration, invocationId: 'fixture-qualified' },
  ];
  const roots = products.map((product) => ({
    label: `//fixture/${product.id}:shipping`,
    configuration,
    package: { product: product.id, version: product.version },
  }));
  const qualificationPolicy = {
    owner: '//fixture:shipping_export',
    configuration,
    roots: roots.map(({ label }) => label),
    requiredTests: requiredTests.map(({ invocationId: _, ...test }) => test),
  };
  const producerAssurance = {
    scope: 'reviewed-producer-assurance',
    reviewedSource: source,
    event: 'push',
    ref: 'refs/heads/main',
    github,
    artifact,
    evidenceDigest,
    shippingAnalysis: 'bound',
    testQualification: 'passed',
    requiredTests,
    acceptedExecutionAssumptions: [
      'producer inputs remained immutable through capture in the reviewed isolated job',
      'the reviewed coordinator retained the native after-build dump from its producer invocation',
    ],
  };
  const observation: any = {
    coverage: { completeProductInventory: true },
    products: products.map((product) => ({ product, carriers: [], productArtifacts: [] })),
    authenticated: [
      {
        origin: { github, artifact, evidenceDigest },
        evidence: { source },
        producerAssurance,
        qualification: {
          source,
          shippingAnalysis: 'bound',
          testQualification: 'passed',
          requiredTests,
          cohorts: [{ roots, qualificationPolicy }],
          unverified: ['complete canonical product qualification and completed-baseline admission'],
        },
      },
    ],
  };
  const completed: any = {
    scope: 'construction',
    source,
    products: products.map(({ id }) => ({
      product: id,
      deliveryStatus: 'identical',
      carriers: [],
      productArtifacts: [],
    })),
  };
  return { source, products: ids, observation, completed };
}

test('complete catalog resolves zero, few and many changes independently of checks while seed reuse remains unverified', () => {
  const input = decisionFixture();
  const seeds = new Set(
    loadPublicationCatalog('native seed decision fixture')
      .products.filter((product) =>
        expectedProductArtifactRows([product]).some((row) =>
          ['native-seeds', 'wasix-seeds'].includes(row.kind),
        ),
      )
      .map(({ id }) => id),
  );
  expect(seeds.size).toBeGreaterThan(0);
  const initial = compareNativePreVersionDelivery(input);
  expect(initial.completeRepositoryInventory).toBe(true);
  expect(initial.releaseDecision).toBe('qualified');
  expect(initial.selectedProducts).toEqual([]);
  let seed = 0x294b4e1;
  for (let scenario = 0; scenario < 24; scenario++) {
    const expected = [];
    const affected = [];
    for (const [index, product] of input.completed.products.entries()) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const changed =
        scenario === 0
          ? false
          : scenario === 1
            ? index === 0
            : scenario === 2
              ? true
              : Boolean(seed & 1);
      product.deliveryStatus = changed ? 'different' : 'identical';
      if (changed && !seeds.has(product.product)) expected.push(product.product);
      if (seed & 2) affected.push(product.product);
    }
    const result = compareNativePreVersionDelivery({ ...input, affectedProducts: affected });
    const seedChanged = input.completed.products.some(
      (product) => seeds.has(product.product) && product.deliveryStatus === 'different',
    );
    expect(result.releaseDecision).toBe(seedChanged ? 'unverified' : 'qualified');
    expect(result.selectedProducts).toEqual(seedChanged ? undefined : expected.sort());
    for (const product of result.products) {
      expect(product.affectedBuild).toBe(
        affected.includes(product.product) ? 'required' : 'not-required',
      );
      expect(product.necessaryDelivery).toBe(
        seeds.has(product.product) &&
          input.completed.products.find((row) => row.product === product.product).deliveryStatus ===
            'different'
          ? 'unknown'
          : expected.includes(product.product)
            ? 'needed'
            : 'not-needed',
      );
    }
  }
});

test('unchanged real catalog seeds need no release, while fresh control or WAL entropy cannot justify one', () => {
  const catalog = loadPublicationCatalog('native real seed negative');
  const product = catalog.products.find((product) =>
    expectedProductArtifactRows([product]).some((row) => row.kind === 'native-seeds'),
  )!;
  const input = decisionFixture([product.id]);
  const rows = expectedProductArtifactRows([product])
    .filter((row) => ['native-seeds', 'wasix-seeds'].includes(row.kind))
    .map((row) => ({ ...row, sha256: 'f'.repeat(64), size: 1, path: `target/${row.name}` }));
  expect(rows.some((row) => row.kind === 'native-seeds')).toBe(true);
  expect(rows.some((row) => row.kind === 'wasix-seeds')).toBe(true);
  input.observation.products[0].productArtifacts = rows;
  input.completed.products[0].productArtifacts = rows;
  expect(compareNativePreVersionDelivery(input).products[0].necessaryDelivery).toBe('not-needed');
  input.completed.products[0].deliveryStatus = 'different';
  input.completed.products[0].comparisons = rows.map((row) => ({
    id: row.id,
    currentId: row.id,
    kind: row.kind,
    differentMembers: [],
  }));
  const nonSeed = catalog.carriers.find(
    (carrier) => carrier.product === product.id && carrier.ecosystem === 'npm',
  )!;
  input.completed.products[0].comparisons.push({
    id: nonSeed.id,
    kind: 'npm',
    differentMembers: ['THIRD_PARTY_NOTICES.md'],
  });
  expect(compareNativePreVersionDelivery(input).products[0].necessaryDelivery).toBe('needed');
  for (const differentMembers of [
    ['pgdata/global/pg_control'],
    ['pgdata/pg_wal/000000010000000000000001'],
  ]) {
    input.completed.products[0].deliveryStatus = 'different';
    input.completed.products[0].comparisons = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      differentMembers,
    }));
    const result = compareNativePreVersionDelivery(input);
    expect(result.products[0].configuredTests).toBe('qualified');
    expect(result.products[0].deliveryStatus).toBe('different');
    expect(result.products[0].necessaryDelivery).toBe('unknown');
    expect(result.products[0].reason).toBe('seed-lifetime-or-reuse-unverified');
    expect(result.releaseDecision).toBe('unverified');
  }
});

test('focused qualification can resolve a product without claiming a complete repository release plan', () => {
  const input = decisionFixture(['oliphaunt-query-ts']);
  input.completed.products[0].deliveryStatus = 'different';
  const result = compareNativePreVersionDelivery(input);
  expect(result.products[0].necessaryDelivery).toBe('needed');
  expect(result.completeRepositoryInventory).toBe(false);
  expect(result.releaseDecision).toBe('unverified');
  expect(result.selectedProducts).toBeUndefined();
  expect(result.unverified).toContain('complete repository product decision inventory');
});

test('qualified decision snapshots its source and rejects foreign or duplicate affected products', () => {
  const input = decisionFixture();
  input.source = { ...source };
  const result = compareNativePreVersionDelivery(input);
  input.source.commit = 'f'.repeat(40);
  expect(result.source).toEqual(source);
  for (const affectedProducts of [['foreign'], [input.products[0], input.products[0]]])
    expect(() =>
      compareNativePreVersionDelivery({ ...decisionFixture(), affectedProducts }),
    ).toThrow(/affected build selection/);
});

test('an unrelated unknown producer does not erase a complete product decision', () => {
  const input = decisionFixture(['oliphaunt-query-ts', 'oliphaunt-query']);
  const build = input.observation.authenticated[0];
  const other = structuredClone(build);
  build.qualification.cohorts[0].roots = build.qualification.cohorts[0].roots.filter(
    (root) => root.package.product === 'oliphaunt-query-ts',
  );
  other.qualification.cohorts[0].roots = other.qualification.cohorts[0].roots.filter(
    (root) => root.package.product === 'oliphaunt-query',
  );
  delete other.producerAssurance;
  other.qualification.unverified.push('unreviewed separate producer');
  input.observation.authenticated.push(other);
  const result = compareNativePreVersionDelivery(input);
  expect(
    result.products.find(({ product }) => product === 'oliphaunt-query-ts')?.necessaryDelivery,
  ).toBe('not-needed');
  expect(
    result.products.find(({ product }) => product === 'oliphaunt-query')?.necessaryDelivery,
  ).toBe('unknown');
  expect(result.releaseDecision).toBe('unverified');
});

for (const fault of [
  'observed-only',
  'missing-policy',
  'empty-policy',
  'unknown-delivery',
  'qualification-unknown',
  'archive-only',
] as const)
  test(`complete native delivery decisions remain unverified for ${fault}`, () => {
    const input = decisionFixture();
    const build = input.observation.authenticated[0];
    if (fault === 'observed-only') delete build.producerAssurance;
    else if (fault === 'missing-policy') delete build.qualification.cohorts[0].qualificationPolicy;
    else if (fault === 'empty-policy')
      build.qualification.cohorts[0].qualificationPolicy.requiredTests = [];
    else if (fault === 'unknown-delivery') input.completed.products[0].deliveryStatus = 'unknown';
    else if (fault === 'qualification-unknown')
      build.qualification.unverified.push('unmapped producer qualification');
    const result = compareNativePreVersionDelivery({
      ...input,
      ...(fault === 'archive-only'
        ? {
            completed: undefined,
            archives: {
              scope: 'construction',
              source,
              releaseDecision: 'unverified',
              currentArchives: [],
              products: input.products.map((product) => ({ product, deliveryStatus: 'identical' })),
            } as any,
          }
        : {}),
    });
    expect(result.releaseDecision).toBe('unverified');
    expect(result.selectedProducts).toBeUndefined();
    expect(result.products.some(({ necessaryDelivery }) => necessaryDelivery === 'unknown')).toBe(
      true,
    );
  });

test('reviewed assurance cannot be transplanted from another source, artifact or workflow role', () => {
  for (const change of [
    (build) => {
      build.producerAssurance.reviewedSource = { ...source, tree: 'f'.repeat(40) };
    },
    (build) => {
      build.producerAssurance.evidenceDigest = `sha256:${'f'.repeat(64)}`;
    },
    (build) => {
      build.producerAssurance.github = { ...build.origin.github, job: 'Unreviewed producer' };
    },
  ]) {
    const input = decisionFixture();
    change(input.observation.authenticated[0]);
    expect(() => compareNativePreVersionDelivery(input)).toThrow();
  }
});

async function fixture(run) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-delivered-members-'));
  const catalog = loadPublicationCatalog('native final-member fixture', { products: ids });
  const artifactRows = expectedProductArtifactRows(catalog.products).filter((row) =>
    ['native-runtime', 'native-tools'].includes(row.kind),
  );
  const roots = [];
  const files = [];
  for (const row of artifactRows) {
    const output = `bazel-out/fixture/bin/${row.product}/${row.target}/public_payload`;
    const directory = path.join(executionRoot, output);
    const executable =
      row.kind === 'native-runtime'
        ? requiredRuntimeMemberPaths(row.target, 'runtime/bin')
        : requiredToolsMemberPaths(row.target, 'runtime/bin');
    for (const name of [...executable, 'lib/public-interface.bin', 'THIRD_PARTY_NOTICES.md']) {
      const file = path.join(directory, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${row.product} ${name} exact bytes`);
      // Physical Bazel file permissions deliberately differ from public modes.
      chmodSync(file, 0o555);
    }
    const artifact = allArtifactTargets({ product: row.product, surface: 'github-release' }).find(
      (artifact) => artifact.kind === row.kind && artifact.target === row.target,
    )!;
    const archiveOutput = `bazel-out/fixture/bin/${row.product}/${row.target}/release-assets/${row.name}`;
    const archive = path.join(executionRoot, archiveOutput);
    const pack = () =>
      packageEnvelope({
        phase: 'github',
        artifact,
        version: row.version,
        carriers: [],
        payload: directory,
        sources: {},
        legal: {},
        output: archive,
      });
    await pack();
    roots.push(
      {
        label: `//fixture/${row.product}:payload_${row.target}`,
        package: {
          product: row.product,
          version: row.version,
          ecosystem: 'internal',
          name: `${row.product}-public-payload`,
          configuration: row.target,
          role: 'construction',
          outputs: [{ path: output, owner: `//fixture/${row.product}:payload` }],
        },
      },
      {
        label: `//fixture/${row.product}:github_${row.target}`,
        package: {
          product: row.product,
          version: row.version,
          ecosystem: 'github',
          name: row.name,
          configuration: row.target,
          role: row.role,
          outputs: [{ path: archiveOutput, owner: `//fixture/${row.product}:archive` }],
        },
      },
    );
    files.push({ row, directory, archive, pack });
  }
  const cohort: NativePayloadCohort = {
    source,
    executionRoot,
    roots,
    get aquery() {
      throw new Error('physical archive binding must not infer execution');
    },
  };
  const capture = () =>
    captureNativePreEnvelopePayloads([cohort], { source, products: catalog.products });
  const bind = () => bindNativeArchiveDelivery(capture().payloads, [cohort], artifactRows);
  try {
    await run({ cohort, catalog, files, capture, bind, executionRoot, artifactRows });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
}

function completedFixture(product, files) {
  // Synthetic transport responses test the genuine default API contract. They
  // do not authenticate these fixture bytes as a real published release.
  const publication: CompletedPublication = {
    product: product.id,
    version: product.version,
    tagName: `${product.id}-v${product.version}`,
    publicationSha: source.commit,
    publicationTree: source.tree,
    releaseSha: '3'.repeat(40),
  };
  const release = {
    id: 123,
    tag_name: publication.tagName,
    target_commitish: source.commit,
    draft: false,
    prerelease: false,
  };
  const assets = files.map(({ row, archive }, index) => ({
    id: index + 1,
    name: row.name,
    size: readFileSync(archive).length,
    digest: `sha256:${hash(archive)}`,
    state: 'uploaded',
    url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 1}`,
  }));
  const requests = [];
  const options = {
    assertCompletedPublication: async (requested) => {
      requests.push(['completion', requested]);
      return publication;
    },
    readJson: async (endpoint) => {
      expect(endpoint).toBe(`repos/f0rr0/oliphaunt/releases/tags/${publication.tagName}`);
      return release;
    },
    readPages: async (endpoint) => {
      expect(endpoint).toBe('repos/f0rr0/oliphaunt/releases/123/assets');
      return assets;
    },
    proveAsset: async () => {
      throw new Error('API asset digest should bind fixture bytes');
    },
  };
  const input = {
    publication,
    files: files.map(({ row, archive }) => ({ target: row.target, file: archive })),
  };
  return { input, options, publication, release, assets, requests };
}

test('actual GitHub envelope writer binds both native family member/mode contracts without granting qualification', async () => {
  await fixture(({ bind, capture }) => {
    const current = bind();
    expect(current.scope).toBe('construction');
    expect(
      current.products.every(
        ({ completeConfiguredArchiveInventory }) => completeConfiguredArchiveInventory,
      ),
    ).toBe(true);
    expect(current.products.every(({ physicalDelivery }) => physicalDelivery)).toBe(true);
    expect(current.unverified).toContain('native qualification workflow proof');
    const raw = capture().payloads.products[0].roots[0].outputs[0].members;
    expect(raw.filter(({ type }) => type === 'file').every(({ mode }) => mode === 0o555)).toBe(
      true,
    );
    const delivered = current.products[0].physicalDelivery!.deliveredPayloads[0].outputs[0].members;
    expect(delivered.find(({ path }) => path === 'THIRD_PARTY_NOTICES.md')!.mode).toBe(0o644);
    expect(delivered.find(({ path }) => path.startsWith('runtime/bin/'))!.mode).toBe(0o755);
  });
});

test('completed public member origin compares exact delivery while release necessity remains unverified', async () => {
  await fixture(async ({ bind, catalog, files }) => {
    const origins = [];
    for (const product of catalog.products) {
      const completed = completedFixture(
        product,
        files.filter(({ row }) => row.product === product.id),
      );
      origins.push(await captureCompletedNativeArchiveDelivery(completed.input, completed.options));
      expect(completed.requests).toEqual([['completion', completed.publication]]);
    }
    const before = compareCompletedNativeArchiveDelivery(bind(), origins);
    expect(before.releaseDecision).toBe('unverified');
    expect(before.products.map(({ deliveryStatus }) => deliveryStatus)).toEqual([
      'identical',
      'identical',
    ]);
    const changed = files.find(({ row }) => row.product === 'postgres-tools-native')!;
    chmodSync(path.join(changed.directory, 'THIRD_PARTY_NOTICES.md'), 0o644);
    writeFileSync(
      path.join(changed.directory, 'THIRD_PARTY_NOTICES.md'),
      'actual changed public legal bytes',
    );
    await changed.pack();
    expect(compareCompletedNativeArchiveDelivery(bind(), origins).products).toEqual([
      { product: 'liboliphaunt-native', deliveryStatus: 'identical' },
      { product: 'postgres-tools-native', deliveryStatus: 'different' },
    ]);
    expect(
      compareCompletedNativeArchiveDelivery(bind(), []).products.every(
        ({ deliveryStatus }) => deliveryStatus === 'unknown',
      ),
    ).toBe(true);
  });
});

test('archive wrapper root changes preserve the actual retained installed-tree contract', async () => {
  await fixture(async ({ bind, catalog, files, executionRoot }) => {
    const product = catalog.products[0];
    const published = completedFixture(
      product,
      files.filter(({ row }) => row.product === product.id),
    );
    const origin = await captureCompletedNativeArchiveDelivery(published.input, published.options);
    const file = files.find(
      ({ row }) => row.product === product.id && row.name.endsWith('.tar.gz'),
    );
    if (!file) throw new Error('fixture has no native TAR archive');
    const originalHash = hash(file.archive);
    const inner = [...readPortableArchiveEntries(file.archive).values()].map((entry) => ({
      name: entry.name + (entry.isDirectory ? '/' : ''),
      type: entry.isDirectory ? '5' : '0',
      mode: entry.mode,
      data: entry.isFile ? entry.data() : Buffer.alloc(0),
    }));
    for (const [index, root] of [[{ name: './', type: '5', mode: 0o700 }], []].entries()) {
      writeFileSync(file.archive, tarArchive([...root, ...inner]));
      expect(hash(file.archive)).not.toBe(originalHash);
      const destination = path.join(executionRoot, `installed-root-${index}`);
      extractPortableArchiveTree(file.archive, destination);
      expect(statSync(destination).mode & 0o777).toBe(0o755);
      const current = bind();
      expect(
        current.products[0].archives.find(({ target }) => target === file.row.target)?.sha256,
      ).toBe(hash(file.archive));
      expect(
        compareCompletedNativeArchiveDelivery(current, [origin]).products[0].deliveryStatus,
      ).toBe('identical');
    }
  });
});

test('observed configured tests cannot bind a substituted archive envelope or source', async () => {
  await fixture(async ({ bind, catalog, files }) => {
    const origins = [];
    for (const product of catalog.products) {
      const published = completedFixture(
        product,
        files.filter(({ row }) => row.product === product.id),
      );
      origins.push(await captureCompletedNativeArchiveDelivery(published.input, published.options));
    }
    const archives = compareCompletedNativeArchiveDelivery(bind(), origins);
    // Transport-shaped fixtures exercise only this comparison binding; they
    // cannot authenticate a job, admit its contract or produce a release verdict.
    const observation: any = {
      coverage: { completeProductInventory: true },
      authenticated: [
        {
          evidence: { source },
          qualification: {
            source,
            testQualification: 'passed',
            requiredTests: [{ label: '//fixture:test', configuration: 'a'.repeat(64) }],
            unverified: ['fixture origin is unverified'],
          },
        },
      ],
      products: catalog.products.map((product) => ({
        product,
        carriers: [],
        productArtifacts: archives.currentArchives.filter((row) => row.product === product.id),
      })),
    };
    expect(
      compareNativePreVersionDelivery({
        source,
        products: ids,
        archives,
        observation,
      }).products.every(({ necessaryDelivery }) => necessaryDelivery === 'unknown'),
    ).toBe(true);
    observation.products[0].productArtifacts[0] = {
      ...observation.products[0].productArtifacts[0],
      sha256: 'f'.repeat(64),
    };
    expect(() =>
      compareNativePreVersionDelivery({ source, products: ids, archives, observation }),
    ).toThrow(/qualified physical envelope/);
    observation.authenticated[0].evidence.source = { ...source, commit: 'f'.repeat(40) };
    expect(() =>
      compareNativePreVersionDelivery({ source, products: ids, archives, observation }),
    ).toThrow(/source\/configured tests/);
  });
});

test('seeded physical scenarios separate affected checks from zero, few and many archive changes', async () => {
  await fixture(async ({ bind, catalog, files, executionRoot }) => {
    const selected = catalog.products.map((product) => {
      const file = files.find(({ row }) => row.product === product.id);
      if (!file) throw new Error('fixture product has no public archive');
      return file;
    });
    for (const file of selected) {
      writeFileSync(
        path.join(file.directory, 'consumed-compatibility.json'),
        '{"nativeRuntime":"=0.3.2"}\n',
      );
      await file.pack();
    }
    const origins = [];
    for (const product of catalog.products) {
      const published = completedFixture(
        product,
        files.filter(({ row }) => row.product === product.id),
      );
      origins.push(await captureCompletedNativeArchiveDelivery(published.input, published.options));
    }
    let seed = 0x29493c80;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const witnessed = new Set<number>();
    for (let scenario = 0; scenario < 24; scenario++) {
      const expected = new Map<string, string>();
      const affected = [];
      for (const [index, file] of selected.entries()) {
        const variant = scenario < 8 ? (scenario + index) % 8 : random() % 8;
        witnessed.add(variant);
        if (random() & 1) affected.push(file.row.product);
        const publicFile = path.join(file.directory, 'lib/public-interface.bin');
        const renamed = path.join(file.directory, 'lib/renamed-interface.bin');
        rmSync(renamed, { force: true });
        rmSync(publicFile, { force: true });
        writeFileSync(publicFile, `${file.row.product} lib/public-interface.bin exact bytes`);
        chmodSync(path.join(file.directory, 'THIRD_PARTY_NOTICES.md'), 0o644);
        writeFileSync(
          path.join(file.directory, 'THIRD_PARTY_NOTICES.md'),
          `${file.row.product} THIRD_PARTY_NOTICES.md exact bytes`,
        );
        writeFileSync(
          path.join(file.directory, 'consumed-compatibility.json'),
          '{"nativeRuntime":"=0.3.2"}\n',
        );
        if (variant === 1 || variant === 2) {
          // Changed compiler source/action helper or controller stamp can request
          // checks while the actual existing envelope writer delivers equal bytes.
          writeFileSync(
            path.join(executionRoot, 'changed-input.txt'),
            `source/helper change ${random()}\n`,
          );
          writeFileSync(
            path.join(executionRoot, 'controller-version.json'),
            `{"version":"${scenario}.0.0"}\n`,
          );
          if (!affected.includes(file.row.product)) affected.push(file.row.product);
        } else if (variant === 3) {
          writeFileSync(
            path.join(file.directory, 'THIRD_PARTY_NOTICES.md'),
            'actual changed legal bytes',
          );
        } else if (variant === 4) {
          writeFileSync(publicFile, 'actual compiled public version/interface changed');
        } else if (variant === 5) {
          writeFileSync(renamed, readFileSync(publicFile));
          rmSync(publicFile);
        } else if (variant === 7) {
          writeFileSync(
            path.join(file.directory, 'consumed-compatibility.json'),
            '{"nativeRuntime":"=0.3.3"}\n',
          );
        }
        if (variant !== 5) chmodSync(publicFile, variant === 6 ? 0o444 : 0o555);
        await file.pack();
        expected.set(file.row.product, [3, 4, 5, 7].includes(variant) ? 'different' : 'identical');
      }
      const archives = compareCompletedNativeArchiveDelivery(bind(), origins);
      expect(archives.products.map((product) => [product.product, product.deliveryStatus])).toEqual(
        catalog.products.map((product) => [product.id, expected.get(product.id)]),
      );
      const result = compareNativePreVersionDelivery({
        source,
        products: ids,
        archives,
        affectedProducts: affected,
      });
      expect(result.releaseDecision).toBe('unverified');
      for (const product of result.products) {
        expect(product.affectedBuild).toBe(
          affected.includes(product.product) ? 'required' : 'not-required',
        );
        expect(product.archiveDeliveryStatus).toBe(expected.get(product.product));
        // Registry parts/facades/contrib and mandatory qualification are not
        // proved by the complete GitHub archive family, even when bytes match.
        expect(product.deliveryStatus).toBe('unknown');
        expect(product.necessaryDelivery).toBe('unknown');
      }
    }
    expect([...witnessed].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

test('pre-version comparison fails closed for absent seed mapping, origin, inventory and source substitution', () => {
  const products = ['oliphaunt-query', 'database-resources'];
  const missing = compareNativePreVersionDelivery({ source, products, affectedProducts: [] });
  expect(
    missing.products.every(
      (product) => product.deliveryStatus === 'unknown' && product.necessaryDelivery === 'unknown',
    ),
  ).toBe(true);
  expect(missing.products.every((product) => product.affectedBuild === 'not-required')).toBe(true);
  expect(() =>
    compareNativePreVersionDelivery({ source, products: [products[0], products[0]] }),
  ).toThrow(/unique/);
  expect(() =>
    compareNativePreVersionDelivery({
      source,
      products: [products[0]],
      archives: {
        scope: 'construction',
        source: { ...source, tree: 'f'.repeat(40) },
        currentArchives: [],
        releaseDecision: 'unverified',
        products: [],
      },
    }),
  ).toThrow(/captured source/);
  expect(() =>
    compareNativePreVersionDelivery({
      source,
      products: [products[0]],
      archives: {
        scope: 'construction',
        source,
        currentArchives: [],
        releaseDecision: 'unverified',
        products: [{ product: 'database-resources', deliveryStatus: 'identical' }],
      },
    }),
  ).toThrow(/explicit product inventory/);
  expect(() =>
    compareNativePreVersionDelivery({
      source,
      products,
      observation: { authenticated: [], coverage: { completeProductInventory: false } } as any,
    }),
  ).toThrow(/incomplete frozen inventory/);
});

test('missing root/final archive or configured coverage remains unknown; substitutions fail', async () => {
  await fixture(({ cohort, capture, artifactRows }) => {
    const payloads = capture().payloads;
    const incomplete = Object.assign(Object.create(cohort), { roots: cohort.roots.slice(2) });
    const report = bindNativeArchiveDelivery(payloads, [incomplete], artifactRows);
    expect(report.products[0].physicalDelivery).toBeUndefined();
    expect(report.products[0].completeConfiguredArchiveInventory).toBe(false);
    expect(() =>
      bindNativeArchiveDelivery(
        payloads,
        [Object.assign(Object.create(cohort), { source: { ...source, tree: '4'.repeat(40) } })],
        artifactRows,
      ),
    ).toThrow('captured payload source');
    const root = cohort.roots.find(({ package: pkg }) => pkg.ecosystem === 'github')!;
    root.package.version = '99.0.0';
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'different version',
    );
  });
});

test('actual extra, missing or changed archive members cannot masquerade as captured payloads', async () => {
  await fixture(async ({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    writeFileSync(path.join(files[0].directory, 'undeclared-member'), 'extra delivery');
    await files[0].pack();
    rmSync(path.join(files[0].directory, 'undeclared-member'));
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'exactly deliver',
    );
  });
});

test('a raw payload changed after capture cannot bind an unchanged final archive', async () => {
  await fixture(({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    const changed = path.join(files[0].directory, 'lib/public-interface.bin');
    chmodSync(changed, 0o644);
    writeFileSync(changed, 'new unbound raw payload bytes');
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'captured physical members',
    );
  });
});

test('same file bytes with an incorrect final executable mode do not satisfy the public contract', async () => {
  await fixture(async ({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    const value = files[0];
    const executable =
      value.row.kind === 'native-runtime'
        ? requiredRuntimeMemberPaths(value.row.target, 'runtime/bin')
        : requiredToolsMemberPaths(value.row.target, 'runtime/bin');
    await archiveDirectory(value.directory, value.archive, {
      modes: {
        ...Object.fromEntries(executable.map((name) => [name, 0o755])),
        'lib/public-interface.bin': 0o755,
        'THIRD_PARTY_NOTICES.md': 0o644,
      },
    });
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'exactly deliver',
    );
  });
});

test('digest-less public assets use the retained streaming proof and partial origins stay unknown', async () => {
  await fixture(async ({ catalog, files, bind }) => {
    const product = catalog.products[0];
    const one = files.filter(({ row }) => row.product === product.id).slice(0, 1);
    const completed = completedFixture(product, one);
    delete completed.assets[0].digest;
    let downloads = 0;
    const proveAsset = async (url, name, size) => {
      expect(url).toBe(completed.assets[0].url);
      expect(name).toBe(one[0].row.name);
      expect(size).toBe(readFileSync(one[0].archive).length);
      downloads++;
      return { bytes: size, sha256: hash(one[0].archive) };
    };
    const origin = await captureCompletedNativeArchiveDelivery(completed.input, {
      ...completed.options,
      proveAsset,
    });
    expect(downloads).toBe(1);
    expect(
      compareCompletedNativeArchiveDelivery(bind(), [origin]).products.every(
        ({ deliveryStatus }) => deliveryStatus === 'unknown',
      ),
    ).toBe(true);
    await expect(
      captureCompletedNativeArchiveDelivery(completed.input, {
        ...completed.options,
        proveAsset: async () => ({ bytes: 1, sha256: hash(one[0].archive) }),
      }),
    ).rejects.toThrow('authenticated public asset');
  });
});

test('completed origin binds actual release/source/asset identity, downloaded bytes and safe physical archive', async () => {
  await fixture(async ({ catalog, files, executionRoot }) => {
    const product = catalog.products[0];
    const completed = completedFixture(
      product,
      files.filter(({ row }) => row.product === product.id),
    );
    const call = () => captureCompletedNativeArchiveDelivery(completed.input, completed.options);
    completed.release.target_commitish = '4'.repeat(40);
    await expect(call()).rejects.toThrow('completed source');
    completed.release.target_commitish = source.commit;
    completed.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    await expect(call()).rejects.toThrow('authenticated public asset');
    completed.assets[0].digest = `sha256:${hash(completed.input.files[0].file)}`;
    const archive = completed.input.files[0].file;
    const backup = path.join(executionRoot, 'backup.tar.gz');
    copyFileSync(archive, backup);
    rmSync(archive);
    symlinkSync(backup, archive);
    await expect(call()).rejects.toThrow();
  });
});

test('qualified descriptor comparison classifies core-only resource hold and explicit admitted-consumer adoption before versioning', () => {
  const catalog = loadPublicationCatalog('WASIX resource admission fixture');
  const resource = catalog.products.find((row) => row.id === 'database-resources')!;
  const core = catalog.products.find((row) => row.id === 'liboliphaunt-wasix')!;
  const input = decisionFixture();
  const rows = expectedProductArtifactRows([resource])
    .filter((row) => ['native-seeds', 'wasix-seeds'].includes(row.kind))
    .map((row) => ({ ...row, sha256: 'f'.repeat(64), size: 1, path: 'target/' + row.name }));
  input.observation.products.find((row) => row.product.id === resource.id).productArtifacts = rows;
  const completedResource = input.completed.products.find((row) => row.product === resource.id);
  completedResource.productArtifacts = rows;
  const completedCore = input.completed.products.find((row) => row.product === core.id);
  completedCore.deliveryStatus = 'different';
  completedCore.comparisons = [
    { id: 'fixture-core', kind: 'wasix-runtime', differentMembers: ['oliphaunt/bin/postgres'] },
  ];
  const hold = compareNativePreVersionDelivery({
    ...input,
    affectedProducts: [core.id, resource.id],
  });
  expect(hold.selectedProducts).toEqual([core.id]);
  expect(hold.products.find((row) => row.product === resource.id).necessaryDelivery).toBe(
    'not-needed',
  );
  const descriptor = rows.find((row) => row.kind === 'wasix-seeds' && row.name.endsWith('.json'))!;
  completedResource.deliveryStatus = 'different';
  completedResource.comparisons = rows.map((row) => ({
    id: row.id,
    currentId: row.id,
    kind: row.kind,
    differentMembers: row.id === descriptor.id ? ['runtime.version', 'runtime.consumerSha256'] : [],
  }));
  const adopt = compareNativePreVersionDelivery({ ...input, affectedProducts: [resource.id] });
  expect(adopt.selectedProducts).toEqual([resource.id, core.id].sort());
  expect(adopt.products.find((row) => row.product === resource.id).necessaryDelivery).toBe(
    'needed',
  );
  expect(
    input.observation.products.find((row) => row.product.id === resource.id).productArtifacts,
  ).toEqual(rows);
});
