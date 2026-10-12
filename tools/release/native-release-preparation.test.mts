import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { fileIdentity } from './native-file-identity.mts';
import {
  acquireNativePublicationBuilds,
  acquireNativePublicationInputs,
  acquireNativeReleaseArchives,
  prepareNativeReleaseDelivery,
  stageNativeReleaseArchives,
  stageNativeReleaseFamilies,
} from './native-release-preparation.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { allArtifactTargets } from './release-artifact-targets.mts';
import { ROOT } from './release-graph.mts';

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };

test('WASIX held host lookup uses the actual published facade NAPI pin, independent of its runtime version, once per carrier', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-facade-supplier-'));
  const hosts = allArtifactTargets({
    product: 'oliphaunt-wasix-napi',
    surface: 'npm-optional',
  }).filter((row) => row.npm_os === process.platform && row.npm_cpu === process.arch);
  expect(hosts).toHaveLength(1);
  const facade = loadPublicationCatalog('published facade fixture').products.find(
    (product) => product.id === 'oliphaunt-wasix-ts',
  )!;
  const acquisitions: string[] = [];
  const transport = {
    readJson: async (endpoint: string) => ({
      id: 1,
      target_commitish: 'c'.repeat(40),
      tag_name: decodeURIComponent(endpoint.split('/').at(-1)!),
    }),
    assertCompleted: async (request: any) => ({
      ...request,
      publicationTree: 'd'.repeat(40),
      releaseSha: request.publicationSha,
    }),
    materialize: async (carrier: any, options: any) => {
      acquisitions.push(`${carrier.id}@${carrier.version}`);
      mkdirSync(options.directory, { recursive: true });
      const file = path.join(options.directory, carrier.artifacts[0].path);
      writeFileSync(
        file,
        tarArchive([
          {
            name: 'package/package.json',
            data: JSON.stringify(
              carrier.product === facade.id
                ? {
                    name: carrier.name,
                    version: carrier.version,
                    oliphaunt: { runtimeVersion: '0.3.2' },
                    optionalDependencies: { [hosts[0].npm_package]: '0.2.1' },
                  }
                : { name: carrier.name, version: carrier.version },
            ),
          },
        ]),
      );
      const { size, sha256 } = fileIdentity(file);
      return {
        carrier: { ...carrier, artifacts: [{ path: file, size, sha256 }] },
        receipt: {},
        metadata: {},
      };
    },
  };
  try {
    const result = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'owned'), consumerProducts: [facade.id] },
      transport,
    );
    expect(acquisitions).toEqual([
      'npm:@oliphaunt/ts-query@0.1.1',
      `npm:@oliphaunt/wasix-ts@${facade.version}`,
      `npm:${hosts[0].npm_package}@0.2.1`,
    ]);
    expect(result.snapshot.seedControls).toEqual([]);
    expect(
      result.snapshot.supplierArtifacts?.map((row) => [row.artifact, row.publication.version]),
    ).toEqual([
      ['npm:@oliphaunt/ts-query', '0.1.1'],
      ['npm:@oliphaunt/wasix-ts', facade.version],
      [`npm:${hosts[0].npm_package}`, '0.2.1'],
    ]);
    expect(
      result.snapshot.supplierArtifacts?.every(
        (row) => fileIdentity(row.file.path).sha256 === row.file.sha256,
      ),
    ).toBe(true);
    expect(result.snapshot).not.toHaveProperty('ready');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const eligible = {
  id: 77,
  head_sha: source.commit,
  head_branch: 'main',
  path: '.github/workflows/bazel.yml',
  name: 'Native Bazel qualification',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
};

test('source Cargo requirements retain each canonical completed crate once through the shared snapshot', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-source-cargo-inputs-'));
  const retained: string[] = [];
  try {
    const result = await acquireNativePublicationInputs(
      {
        source,
        directory: path.join(directory, 'owned'),
        consumerProducts: ['oliphaunt-pgwire-server'],
      },
      {
        readJson: async (endpoint) => ({
          id: 7,
          target_commitish: 'c'.repeat(40),
          tag_name: decodeURIComponent(endpoint.split('/').at(-1)!),
        }),
        assertCompleted: async (request) => ({
          ...request,
          publicationTree: 'd'.repeat(40),
          releaseSha: request.publicationSha,
        }),
        materialize: async (carrier, options) => {
          expect(carrier.ecosystem).toBe('cargo');
          expect(carrier.artifacts[0].path).toBe(`${carrier.name}-${carrier.version}.crate`);
          mkdirSync(options.directory, { recursive: true });
          const file = path.join(options.directory, carrier.artifacts[0].path);
          writeFileSync(
            file,
            tarArchive([
              {
                name: `${carrier.name}-${carrier.version}/Cargo.toml`,
                data: `[package]\nname = "${carrier.name}"\nversion = "${carrier.version}"\n`,
              },
            ]),
          );
          const { size, sha256 } = fileIdentity(file);
          retained.push(carrier.id);
          return {
            carrier: { ...carrier, artifacts: [{ path: file, size, sha256 }] },
            receipt: {},
            metadata: {},
          };
        },
      },
    );
    expect(retained.sort()).toEqual(['cargo:oliphaunt-query', 'cargo:oliphaunt-wasix']);
    expect(new Set(retained).size).toBe(retained.length);
    expect(result.snapshot.seedControls).toEqual([]);
    expect(result.snapshot.supplierArtifacts?.map((row) => row.artifact).sort()).toEqual(retained);
    expect(
      result.snapshot.supplierArtifacts?.every(
        (row) => fileIdentity(row.file.path).sha256 === row.file.sha256,
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const fault of [
  'source',
  'branch',
  'workflow',
  'event',
  'pending',
  'failed',
  'attempt',
  'ID',
] as const)
  test(`actual preparation rejects ${fault} before artifacts or package acquisition`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'native-release-preparation-'));
    try {
      const run = { ...eligible };
      if (fault === 'source') run.head_sha = 'f'.repeat(40);
      if (fault === 'branch') run.head_branch = 'feature';
      if (fault === 'workflow') run.path = '.github/workflows/main.yml';
      if (fault === 'event') run.event = 'pull_request';
      if (fault === 'pending') run.status = 'in_progress';
      if (fault === 'failed') run.conclusion = 'failure';
      if (fault === 'attempt') run.run_attempt = 0;
      if (fault === 'ID') run.id = 78;
      let reads = 0;
      await expect(
        prepareNativeReleaseDelivery(
          { source, runId: 77, completedVersions: {}, directory: path.join(root, 'owned') },
          {
            readJson: async () => {
              reads++;
              return run;
            },
            readPages: async () => {
              throw new Error('artifact acquisition must not run');
            },
            acquire: async () => {
              throw new Error('producer acquisition must not run');
            },
            materialize: async () => {
              throw new Error('registry acquisition must not run');
            },
          },
        ),
      ).rejects.toThrow(/successful exact reviewed-main qualification/);
      expect(reads).toBe(1);
      expect(existsSync(path.join(root, 'owned'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const artifacts of [
  [],
  [{ name: 'arbitrary-unreviewed-evidence', expired: false }],
  [{ name: 'native-build-evidence-x86_64', expired: true }],
])
  test('an eligible run without retained canonical producer roles cannot invent a native release set', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'native-release-preparation-'));
    try {
      await expect(
        prepareNativeReleaseDelivery(
          { source, runId: 77, completedVersions: {}, directory: path.join(root, 'owned') },
          {
            readJson: async () => eligible,
            readPages: async () => artifacts,
            acquire: async () => {
              throw new Error('no producer may be acquired');
            },
          },
        ),
      ).rejects.toThrow(/no retained reviewed producer artifacts/);
      expect(existsSync(path.join(root, 'owned'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

function producer(
  directory: string,
  row: ReturnType<typeof expectedProductArtifactRows>[number],
  content: string,
) {
  const output = `bazel-out/k8-opt/bin/${row.product}/${row.name}`;
  const file = path.join(directory, 'files/0', output);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const identity = fileIdentity(file);
  return {
    file,
    origin: {
      evidence: {
        source,
        cohorts: [
          {
            roots: [
              {
                label: `//${row.product}:shipping`,
                package: {
                  product: row.product,
                  version: '0.3.2',
                  ecosystem: 'github',
                  name: row.name,
                  role: row.role,
                  outputs: [{ path: output }],
                },
              },
            ],
            outputs: [
              {
                path: output,
                members: [
                  {
                    path: '',
                    type: 'file',
                    size: identity.size,
                    sha256: identity.sha256,
                    mode: 0o644,
                  },
                ],
              },
            ],
          },
        ],
      },
      finalFiles: {
        files: [{ cohort: 0, path: output, size: identity.size, sha256: identity.sha256 }],
        assertUnchanged() {
          expect(fileIdentity(file)).toEqual(identity);
        },
      },
    } as any,
  };
}

test('family staging joins unique original host assets with a separate checksum File and preserves producer roots', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-family-test-'));
  const finalDirectory = path.join(
    ROOT,
    'target',
    `native-family-test-${path.basename(directory)}`,
  );
  try {
    const rows = expectedProductArtifactRows(
      loadPublicationCatalog('family staging test').products,
    );
    const asset = rows.find(
      (row) => row.product === 'liboliphaunt-native' && row.role === 'github-release-asset',
    )!;
    const checksum = rows.find(
      (row) => row.product === asset.product && row.role === 'github-release-metadata',
    )!;
    const origins = new Map<string, any>();
    for (const [index, row] of [asset, checksum].entries()) {
      const evidenceRoot = path.join(directory, `producer-${index}`);
      origins.set(evidenceRoot, producer(evidenceRoot, row, `qualified ${row.name}`).origin);
    }
    const original = structuredClone([...origins.values()].map((origin) => origin.evidence));
    const inputs = stageNativeReleaseArchives(origins, source, path.join(directory, 'input'));
    expect(inputs).toEqual([path.join(directory, 'input', asset.product)]);
    expect(readFileSync(path.join(inputs[0], asset.name), 'utf8')).toBe(`qualified ${asset.name}`);
    expect(existsSync(path.join(inputs[0], checksum.name))).toBe(false);
    const final = stageNativeReleaseFamilies(origins, source, finalDirectory);
    expect(final).toEqual([path.join(finalDirectory, asset.product, 'release-assets')]);
    for (const row of [asset, checksum])
      expect(readFileSync(path.join(final[0], row.name), 'utf8')).toBe(`qualified ${row.name}`);
    expect([...origins.values()].map((origin) => origin.evidence)).toEqual(original);
    const selectedDirectory = `${finalDirectory}-selected`;
    try {
      expect(
        stageNativeReleaseFamilies(origins, source, selectedDirectory, [asset.product]),
      ).toEqual([path.join(selectedDirectory, asset.product, 'release-assets')]);
      expect(
        readFileSync(path.join(selectedDirectory, asset.product, 'release-assets', asset.name)),
      ).toEqual(readFileSync(path.join(final[0], asset.name)));
    } finally {
      rmSync(selectedDirectory, { recursive: true, force: true });
    }
    expect(() =>
      stageNativeReleaseFamilies(origins, source, `${finalDirectory}-unknown`, ['unknown']),
    ).toThrow(/canonical product/);
    expect(() =>
      stageNativeReleaseFamilies(origins, source, `${finalDirectory}-duplicate`, [
        asset.product,
        asset.product,
      ]),
    ).toThrow(/unique canonical/);
    expect(() => stageNativeReleaseFamilies(origins, source, finalDirectory)).toThrow(
      'new owned directory',
    );
    const duplicate = new Map(origins);
    duplicate.set(path.join(directory, 'duplicate'), origins.values().next().value);
    expect(() =>
      stageNativeReleaseArchives(duplicate, source, path.join(directory, 'duplicate-input')),
    ).toThrow('repeats an observed public File');
    expect(existsSync(path.join(directory, 'duplicate-input'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(finalDirectory, { recursive: true, force: true });
  }
});

test('PR family construction uses finite completed producer transport and never admits release assurance', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-family-pr-'));
  try {
    const rows = expectedProductArtifactRows(
      loadPublicationCatalog('family staging test').products,
    );
    const row = rows.find(
      (row) => row.product === 'liboliphaunt-native' && row.role === 'github-release-asset',
    )!;
    const acquired: any[] = [];
    const result = await acquireNativeReleaseArchives(
      { source, runId: 77, ref: 'refs/pull/295/merge', directory: path.join(directory, 'input') },
      {
        readJson: async () => ({
          ...eligible,
          status: 'in_progress',
          conclusion: null,
          event: 'pull_request',
          head_branch: 'feature',
          pull_requests: [{ number: 295 }],
        }),
        readPages: async () => [
          { name: 'native-build-evidence-x86_64', expired: false },
          { name: 'native-build-evidence-release-families', expired: false },
          { name: 'arbitrary', expired: false },
        ],
        acquire: async (evidenceRoot, expected) => {
          acquired.push(expected);
          return producer(evidenceRoot, row, 'current PR bytes').origin;
        },
      },
    );
    expect(acquired).toHaveLength(1);
    expect(acquired[0].event).toBe('pull_request');
    expect(acquired[0].ref).toBe('refs/pull/295/merge');
    expect(acquired[0].github.runAttempt).toBe(1);
    expect(result.families).toHaveLength(1);
    expect([...result.origins.values()].every((origin) => !('producerAssurance' in origin))).toBe(
      true,
    );
    await expect(
      acquireNativeReleaseArchives(
        { source, runId: 77, ref: 'refs/pull/296/merge', directory: path.join(directory, 'wrong') },
        {
          readJson: async () => ({
            ...eligible,
            event: 'pull_request',
            pull_requests: [{ number: 295 }],
          }),
          readPages: async () => {
            throw new Error('no artifact reads');
          },
        },
      ),
    ).rejects.toThrow('exact eligible qualification');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const event of ['workflow_dispatch', 'merge_group'] as const)
  test(`${event} family construction binds its exact branch while release preparation remains main-only`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'native-family-context-'));
    try {
      const row = expectedProductArtifactRows(
        loadPublicationCatalog('dispatch family test').products,
      ).find((row) => row.product === 'liboliphaunt-native' && row.role === 'github-release-asset');
      if (!row) throw new Error('missing canonical dispatch test asset');
      const run = {
        ...eligible,
        status: 'in_progress',
        conclusion: null,
        event,
        head_branch:
          event === 'merge_group' ? 'gh-readonly-queue/main/pr-295-aabbcc' : 'feature/native',
      };
      const requests: any[] = [];
      await acquireNativeReleaseArchives(
        {
          source,
          runId: 77,
          ref: `refs/heads/${run.head_branch}`,
          directory: path.join(directory, 'input'),
        },
        {
          readJson: async () => run,
          readPages: async () => [{ name: 'native-build-evidence-x86_64', expired: false }],
          acquire: async (evidenceRoot, expected) => {
            requests.push(expected);
            return producer(evidenceRoot, row, 'dispatch construction').origin;
          },
        },
      );
      expect(requests[0].ref).toBe(`refs/heads/${run.head_branch}`);
      expect(requests[0].event).toBe(event);
      await expect(
        acquireNativeReleaseArchives(
          { source, runId: 77, ref: 'refs/heads/main', directory: path.join(directory, 'wrong') },
          {
            readJson: async () => run,
            readPages: async () => {
              throw new Error('no artifact reads');
            },
          },
        ),
      ).rejects.toThrow('exact eligible qualification');
      await expect(
        prepareNativeReleaseDelivery(
          { source, runId: 77, directory: path.join(directory, 'release'), completedVersions: {} },
          {
            readJson: async () => ({ ...run, status: 'completed', conclusion: 'success' }),
            readPages: async () => {
              throw new Error('no artifact reads');
            },
          },
        ),
      ).rejects.toThrow('successful exact reviewed-main');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('producer seed snapshot adopts all genuine completed slots without claiming historical constructor intent', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-seed-baseline-'));
  try {
    const resource = loadPublicationCatalog('seed baseline test').products.find(
      (row) => row.id === 'database-resources',
    );
    if (!resource) throw new Error('missing canonical resource test owner');
    const rows = expectedProductArtifactRows([resource]).filter((row) =>
      ['native-seeds', 'wasix-seeds'].includes(row.kind),
    );
    const bytes = new Map<string, Buffer>();
    for (const row of rows.filter((row) => row.name.endsWith('.tar.zst')))
      bytes.set(row.name, Buffer.from(`fixture public PGDATA archive ${row.name}`));
    for (const row of rows.filter((row) => row.name.endsWith('.json'))) {
      const identity = seedCarrierIdentities().find((identity) =>
        row.name.endsWith(`-seed-${identity.suffix}.json`),
      );
      if (!identity) throw new Error('missing canonical seed slot');
      const name = row.name.replace(/\.json$/u, '.tar.zst');
      const archive = bytes.get(name)!;
      bytes.set(
        row.name,
        Buffer.from(
          JSON.stringify({
            catalogProfile: identity.profile,
            runtime: { engineFamily: identity.family, target: identity.target, postgresMajor: 18 },
            archive: {
              path: name,
              compressedBytes: archive.length,
              sha256: createHash('sha256').update(archive).digest('hex'),
            },
          }),
        ),
      );
    }
    const wasix = loadPublicationCatalog('seed consumer test').products.find(
      (row) => row.id === 'liboliphaunt-wasix',
    )!;
    const admitted = Bun.TOML.parse(
      readFileSync('src/database-resources/seeds/wasix/Cargo.toml', 'utf8'),
    ).package.metadata.oliphaunt['runtime-version'];
    const consumer = expectedProductArtifactRows([{ ...wasix, version: admitted }]).find(
      (row) => row.kind === 'wasix-runtime' && row.target === 'portable',
    )!;
    bytes.set(consumer.name, Buffer.from('retained admitted consumer archive fixture'));
    const assets = [...bytes].map(([name, value], index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      size: value.length,
      url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 1}`,
      digest: `sha256:${createHash('sha256').update(value).digest('hex')}`,
    }));
    const downloads: string[] = [];
    const transport = {
      readSeedAnchor: () => undefined,
      readJson: async (endpoint: string) => ({
        id: 7,
        target_commitish: 'c'.repeat(40),
        tag_name: decodeURIComponent(endpoint.split('/').at(-1)!),
      }),
      readPages: async () => assets,
      assertCompleted: async (request: any) => ({
        ...request,
        publicationTree: 'd'.repeat(40),
        releaseSha: request.publicationSha,
      }),
      proveAsset: async (_url: string, name: string, size: number, options: any) => {
        const data = bytes.get(name)!;
        expect(data.length).toBe(size);
        mkdirSync(path.dirname(options.retainedPath), { recursive: true });
        writeFileSync(options.retainedPath, data);
        downloads.push(name);
        return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      },
    };
    const result = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'owned') },
      transport,
    );
    expect(result.snapshot.seedControls).toHaveLength(rows.length / 2);
    expect(downloads).toHaveLength(rows.length + 1);
    expect(result.snapshot.supplierArtifacts).toHaveLength(1);
    expect(result.snapshot.supplierArtifacts[0].publication.version).toBe(admitted);
    expect(result.snapshot.supplierArtifacts[0].artifact).toBe(consumer.id);
    expect(new Set(downloads).size).toBe(downloads.length);
    expect(
      result.snapshot.seedControls.every(
        (row) => 'reuse' in row && row.reuse.operation === 'adopt' && !row.reuse.metadata,
      ),
    ).toBe(true);
    expect(readFileSync(result.file, 'utf8')).not.toContain('intentSha256');
    expect(
      result.snapshot.supplierPublications.every(
        (publication) => publication.publicationSha === 'c'.repeat(40),
      ),
    ).toBe(true);
    const absent = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'none'), consumerProducts: [] },
      {
        readJson: async () => {
          throw new Error('no unused completion reads');
        },
        readPages: async () => {
          throw new Error('no unused asset reads');
        },
      },
    );
    expect(absent.snapshot.seedControls).toEqual([]);
    expect(absent.snapshot.supplierPublications).toEqual([]);
    const first = assets[0];
    await expect(
      acquireNativePublicationInputs(
        { source, directory: path.join(directory, 'missing') },
        { ...transport, readPages: async () => assets.filter((asset) => asset !== first) },
      ),
    ).rejects.toThrow('missing or ambiguous');
    expect(existsSync(path.join(directory, 'missing'))).toBe(false);
    const metadataName = `database-resources-${resource.version}-native-baseline.json`;
    const metadataBytes = Buffer.from(
      JSON.stringify({
        scope: 'construction',
        source: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
        product: { id: resource.id, version: resource.version },
        construction: [],
      }),
    );
    bytes.set(metadataName, metadataBytes);
    const metadataAsset = {
      ...first,
      id: assets.length + 1,
      name: metadataName,
      size: metadataBytes.length,
      digest: `sha256:${createHash('sha256').update(metadataBytes).digest('hex')}`,
      url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${assets.length + 1}`,
    };
    let metadataReads = 0;
    const described = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'described-history') },
      {
        ...transport,
        readPages: async () => [...assets, metadataAsset],
        readBaseline: async (request) => {
          metadataReads++;
          expect(request.publisherSha).toBeUndefined();
          expect(JSON.parse(readFileSync(request.file, 'utf8')).construction).toEqual([]);
          return {
            scope: 'construction',
            publication: request.publication,
            metadata: {},
            baselineAdmission: 'unknown',
            releaseDecision: 'unverified',
          } as any;
        },
      },
    );
    expect(metadataReads).toBe(1);
    expect(
      described.snapshot.seedControls.every(
        (row) => row.reuse?.operation === 'reuse' && row.reuse.metadata,
      ),
    ).toBe(true);
    expect(described.metadataBaseline?.baselineAdmission).toBe('unknown');
    await expect(
      acquireNativePublicationInputs(
        { source, directory: path.join(directory, 'unauthenticated-history') },
        {
          ...transport,
          readPages: async () => [...assets, metadataAsset],
          readBaseline: async () => {
            throw new Error('metadata lacks authenticated exact attestation subject');
          },
        },
      ),
    ).rejects.toThrow('authenticated exact attestation subject');
    expect(existsSync(path.join(directory, 'unauthenticated-history'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('declared held Swift source and bindings share one completed-origin acquisition and physical snapshot pool', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'held-swift-inputs-'));
  const bindings = Buffer.from('controlled owned binding ZIP bytes');
  const expected = 'oliphaunt-swift-0.8.2-bindings.xcframework.zip';
  const acquisitions: string[] = [];
  const captures: any[] = [];
  try {
    const result = await acquireNativePublicationInputs(
      {
        source,
        directory: path.join(directory, 'owned'),
        consumerProducts: ['oliphaunt-react-native'],
      },
      {
        readJson: async (endpoint) => ({
          id: 82,
          target_commitish: 'c'.repeat(40),
          tag_name: decodeURIComponent(endpoint.split('/').at(-1)!),
        }),
        readPages: async () => [
          {
            id: 1,
            name: expected,
            state: 'uploaded',
            size: bindings.length,
            url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
            digest: 'sha256:' + createHash('sha256').update(bindings).digest('hex'),
          },
        ],
        assertCompleted: async (request) => ({
          ...request,
          publicationTree: 'd'.repeat(40),
          releaseSha: request.publicationSha,
        }),
        proveAsset: async (_url, name, size, options) => {
          acquisitions.push(name);
          mkdirSync(path.dirname(options.retainedPath), { recursive: true });
          writeFileSync(options.retainedPath, bindings);
          return { bytes: size, sha256: createHash('sha256').update(bindings).digest('hex') };
        },
        materialize: async (carrier: any, options: any) => {
          expect(carrier.product).toBe('oliphaunt-query-ts');
          expect(carrier.id).toBe('npm:@oliphaunt/ts-query');
          expect(carrier.version).toBe('0.1.1');
          mkdirSync(options.directory, { recursive: true });
          const file = path.join(options.directory, carrier.artifacts[0].path);
          writeFileSync(
            file,
            tarArchive([
              {
                name: 'package/package.json',
                data: JSON.stringify({ name: carrier.name, version: carrier.version }),
              },
            ]),
          );
          const { size, sha256 } = fileIdentity(file);
          return {
            carrier: { ...carrier, artifacts: [{ path: file, size, sha256 }] },
            receipt: {},
            metadata: {},
          };
        },
        captureSwiftSource: async (input) => {
          captures.push(input);
          writeFileSync(input.retainedArchive, Buffer.from('controlled Git delivery bytes'));
          const { size, sha256 } = fileIdentity(input.retainedArchive);
          return {
            scope: 'construction',
            publication: input.publication,
            nativePublication: input.publication,
            members: [],
            source: {
              commit: 'e'.repeat(40),
              tree: 'f'.repeat(40),
              member: 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
              blob: '1'.repeat(40),
            },
            file: { path: input.retainedArchive, size, sha256 },
          };
        },
      } as any,
    );
    expect(acquisitions).toEqual([expected]);
    expect(captures).toHaveLength(1);
    expect(captures[0].bindings.sha256).toBe(createHash('sha256').update(bindings).digest('hex'));
    expect(result.snapshot.seedControls).toEqual([]);
    expect(result.snapshot.supplierArtifacts!.map((row) => row.artifact)).toEqual([
      'npm:@oliphaunt/ts-query',
      'github-release:' + expected,
      'swift-source-tag:0.8.2',
    ]);
    expect(result.snapshot.supplierArtifacts!.find((row) => row.source)!.source!.commit).not.toBe(
      result.snapshot.supplierArtifacts!.find((row) => row.source)!.publication.publicationSha,
    );
    expect(
      result.snapshot.supplierArtifacts!.every(
        (row) => fileIdentity(row.file.path).sha256 === row.file.sha256,
      ),
    ).toBe(true);
    expect(result.snapshot).not.toHaveProperty('ready');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RN bootstrap acquires only the original Apple role and cannot wait on its own consumer or the checksum job', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-rn-bootstrap-'));
  const requests: string[] = [];
  try {
    const options = {
      source,
      runId: 77,
      directory: path.join(directory, 'producers'),
      requestedArtifactNames: ['native-build-evidence-mobile-ios'],
      excludeArtifactNames: [
        'native-build-evidence-release-families',
        'native-build-evidence-react-native-macos-arm64',
      ],
    };
    const readJson = async () => eligible;
    const readPages = async () => [
      { name: 'native-build-evidence-mobile-ios', expired: false },
      { name: 'native-build-evidence-native-macos-arm64', expired: false },
      { name: 'native-build-evidence-react-native-macos-arm64', expired: false },
      { name: 'native-build-evidence-release-families', expired: false },
    ];
    const acquire = async (_root: string, expected: any) => {
      requests.push(expected.artifactName);
      return { finalFiles: { qualification: { requiredTests: [] } } } as any;
    };
    const result = await acquireNativePublicationBuilds(options, { readJson, readPages, acquire });
    expect(requests).toEqual(['native-build-evidence-mobile-ios']);
    expect(result.builds).toHaveLength(1);
    await expect(
      acquireNativePublicationBuilds(
        { ...options, directory: path.join(directory, 'missing') },
        {
          readJson,
          readPages: async () => [
            { name: 'native-build-evidence-native-macos-arm64', expired: false },
          ],
          acquire,
        },
      ),
    ).rejects.toThrow('no retained source producer');
    expect(requests).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
