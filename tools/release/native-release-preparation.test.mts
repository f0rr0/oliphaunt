import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceManifest } from '../../build_defs/languages/source-package.mts';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { renderCargoToml } from '../packaging/cargo-manifest.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import {
  loadReleaseMetadata,
  nativePublicationInputProjection,
} from './bazel-release-metadata.mts';
import { requestGithubPages } from './github-read.mts';
import { fileIdentity } from './native-file-identity.mts';
import { nativePublicationMetadataArtifactRow } from './native-publication-metadata-contract.mts';
import {
  acquireCompletedNativeDeliveryBaseline,
  acquireNativePublicationBuilds,
  acquireNativePublicationInputs,
  acquireNativeReleaseArchives,
  assertNeverPublishedNativeProducts,
  nativeCargoMinimumBindings,
  nativeCargoPayloadBindings,
  prepareNativeReleaseDelivery,
  stageNativeReleaseFamilies,
} from './native-release-preparation.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { discoverProductArtifacts, expectedProductArtifactRows } from './publication-lock.mts';
import { allArtifactTargets, contribCarrierDescriptor } from './release-artifact-targets.mts';
import { loadProducts, ROOT } from './release-graph.mts';
import { fixtureCompletedNativeInventory } from './testdata/prepare-release-candidate-fixtures.mts';
import {
  extensionGithubReleaseFixture,
  githubReleaseFixture,
} from './testdata/publication-artifact-fixtures.mts';

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };

const sourceText = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

test('source payload requests preserve held pins and request an explicitly newer published native pin', () => {
  const catalog = loadPublicationCatalog('payload request fixture');
  const held = nativeCargoPayloadBindings(catalog, ['oliphaunt-rust'], sourceText);
  const nativeVersion = Bun.TOML.parse(sourceText('src/native/sdks/rust/Cargo.toml')).package
    .metadata.oliphaunt['native-version'];
  expect(held).toHaveLength(8);
  expect(
    held.filter((row) => row.producer === 'liboliphaunt-native').map((row) => row.producerVersion),
  ).toEqual(Array(4).fill(nativeVersion));
  expect(
    held.some(
      (row) =>
        row.requestedCarrier.includes('extension-') ||
        row.requestedCarrier === 'cargo:oliphaunt-broker',
    ),
  ).toBe(false);
  const next = '0.3.3';
  const newerCheckout = structuredClone(catalog);
  for (const carrier of newerCheckout.carriers)
    if (carrier.product === 'liboliphaunt-native') carrier.version = '9.2.1';
  const directory = mkdtempSync(path.join(tmpdir(), 'published-payload-pin-'));
  try {
    const original = sourceText('src/native/sdks/rust/Cargo.toml');
    const file = path.join(directory, 'Cargo.toml');
    writeFileSync(
      file,
      original.replace(`native-version = "${nativeVersion}"`, `native-version = "${next}"`),
    );
    const changed = nativeCargoPayloadBindings(newerCheckout, ['oliphaunt-rust'], (name) =>
      name === 'src/native/sdks/rust/Cargo.toml' ? readFileSync(file, 'utf8') : sourceText(name),
    );
    expect(
      changed
        .filter((row) => row.producer === 'liboliphaunt-native')
        .map((row) => row.producerVersion),
    ).toEqual(Array(4).fill(next));
    expect(changed.filter((row) => row.producer === 'oliphaunt-broker')).toEqual(
      held.filter((row) => row.producer === 'oliphaunt-broker'),
    );
    expect(sourceText('src/native/sdks/rust/Cargo.toml')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('WASIX source payload requests include optional and foreign carriers without registry acquisition for the local server SDK', () => {
  const catalog = loadPublicationCatalog('WASIX payload request fixture');
  const requests = nativeCargoPayloadBindings(catalog, ['oliphaunt-wasix-rust'], sourceText);
  expect(requests.filter((row) => row.producer === 'liboliphaunt-wasix')).toHaveLength(5);
  expect(requests.filter((row) => row.producer === 'postgres-tools-wasix')).toHaveLength(5);
  expect(requests.filter((row) => row.producer === 'database-resources')).toHaveLength(1);
  expect(nativeCargoPayloadBindings(catalog, ['oliphaunt-pgwire-server'], sourceText)).toEqual([]);
  expect(
    nativeCargoPayloadBindings(
      catalog,
      ['oliphaunt-pgwire-server', 'oliphaunt-wasix-rust'],
      sourceText,
    ),
  ).toEqual(requests);
  const original = sourceText('src/wasix/sdks/rust/Cargo.toml');
  expect(() =>
    nativeCargoPayloadBindings(catalog, ['oliphaunt-wasix-rust'], (name) =>
      name === 'src/wasix/sdks/rust/Cargo.toml'
        ? original.replace(
            'liboliphaunt-wasix-portable = { version = "*", path = "../../runtime/crates/assets" }',
            'liboliphaunt-wasix-portable = { version = "0.3.2" }',
          )
        : sourceText(name),
    ),
  ).toThrow('exact authored version');
  const initial = structuredClone(catalog);
  for (const product of initial.products)
    if (product.id === 'liboliphaunt-native') product.version = '0.0.0';
  for (const carrier of initial.carriers)
    if (carrier.product === 'liboliphaunt-native') carrier.version = '0.0.0';
  const initialSource = sourceText('src/native/sdks/rust/Cargo.toml').replace(
    /native-version = "[^"]+"/u,
    'native-version = "0.0.0"',
  );
  expect(
    nativeCargoPayloadBindings(initial, ['oliphaunt-rust'], (name) =>
      name === 'src/native/sdks/rust/Cargo.toml' ? initialSource : sourceText(name),
    ).some((row) => row.producer === 'liboliphaunt-native'),
  ).toBe(false);
});

function payloadAcquisitionTransport({ failure = '', heldRuntime = '' } = {}) {
  const catalog = loadPublicationCatalog('retained payload fixture');
  const metadata = loadReleaseMetadata(ROOT);
  const requests: string[] = [];
  const transport = {
    inventory: async (publication) => {
      const original = await fixtureCompletedNativeInventory(publication);
      return {
        ...original,
        carriers: original.carriers.map((carrier) => ({
          ...carrier,
          version: publication.version,
        })),
      };
    },
    readPages: async () => [],
    readJson: async (endpoint) => ({
      id: 7,
      target_commitish: 'c'.repeat(40),
      tag_name: decodeURIComponent(endpoint.split('/').at(-1) ?? ''),
    }),
    assertCompleted: async (request) => ({
      ...request,
      publicationTree: 'd'.repeat(40),
      releaseSha: request.publicationSha,
    }),
    materialize: async (carrier, options) => {
      expect(carrier.ecosystem).toBe('cargo');
      const key = `${carrier.id}@${carrier.version}`;
      requests.push(key);
      if (failure === 'missing' && carrier.name.endsWith('-part-001'))
        throw new Error('missing actual part');
      mkdirSync(options.directory, { recursive: true });
      const file = path.join(options.directory, carrier.artifacts[0].path);
      let manifest: any = { package: { name: carrier.name, version: carrier.version } };
      if (carrier.name === 'liboliphaunt-wasix-portable') {
        const context = JSON.parse(
          sourceText('build_defs/languages/installed/wasix/sdk/registry-index.json'),
        );
        const original = context.indexes
          .flatMap((index) => index.records)
          .find((row) => row.name === carrier.name);
        manifest.dependencies = Object.fromEntries(
          original.deps
            .filter((dependency) =>
              catalog.carriers.some(
                (row) => row.id === `cargo:${dependency.name}` && row.product === carrier.product,
              ),
            )
            .map((dependency) => [dependency.name, `=${carrier.version}`]),
        );
      }
      if (carrier.product === 'liboliphaunt-native' && carrier.declared)
        manifest['build-dependencies'] = Object.fromEntries(
          [1, 2].map((part) => [
            `${carrier.name}-part-${String(part).padStart(3, '0')}`,
            `=${failure === 'requirement' ? '0.0.9' : carrier.version}`,
          ]),
        );
      if (carrier.name === 'oliphaunt-wasix') {
        const owner = metadata.products['oliphaunt-wasix-rust'];
        const original = sourceText(`${owner.path}/Cargo.toml`);
        const heldSource = heldRuntime
          ? original.replace(/runtime-version = "[^"]+"/u, `runtime-version = "${heldRuntime}"`)
          : original;
        manifest = sourceManifest(heldSource, sourceText('Cargo.toml'), {
          product: owner.id,
          version: owner.version,
          compatibility: {
            ...owner.compatibility_versions,
            ...(heldRuntime ? { 'liboliphaunt-wasix': heldRuntime } : {}),
          },
          dependencyOwners: Object.fromEntries(
            catalog.carriers
              .filter((row) => row.ecosystem === 'cargo')
              .map((row) => [row.name, row.product]),
          ),
        });
        manifest.package.version = carrier.version;
      }
      if (failure === 'version' && carrier.name.endsWith('-part-001'))
        manifest.package.version = '0.0.9';
      writeFileSync(
        file,
        tarArchive([
          {
            name: `${carrier.name}-${carrier.version}/Cargo.toml`,
            data: renderCargoToml(manifest),
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
  return { requests, transport };
}

test('source payload acquisition retains actual native parts once through the existing snapshot', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'actual-native-payload-inputs-'));
  try {
    const fixture = payloadAcquisitionTransport();
    const acquired = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'owned'), consumerProducts: ['oliphaunt-rust'] },
      fixture.transport,
    );
    const rows = acquired.snapshot.supplierArtifacts ?? [];
    expect(rows.filter((row) => row.publication.product === 'liboliphaunt-native')).toHaveLength(
      12,
    );
    expect(rows.filter((row) => row.artifact.startsWith('cargo:oliphaunt-broker-'))).toHaveLength(
      4,
    );
    expect(rows.every((row) => row.artifact.startsWith('cargo:'))).toBe(true);
    expect(new Set(fixture.requests).size).toBe(fixture.requests.length);
    for (const row of rows) expect(fileIdentity(row.file.path).sha256).toBe(row.file.sha256);
    expect(acquired.snapshot.seedControls).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('completed payload acquisition rejects missing, wrong-version and wrong-requirement parts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bad-native-payload-inputs-'));
  try {
    for (const failure of ['missing', 'version', 'requirement', 'frozen-missing']) {
      const fixture = payloadAcquisitionTransport({ failure });
      const nativeVersion = Bun.TOML.parse(sourceText('src/native/sdks/rust/Cargo.toml')).package
        .metadata.oliphaunt['native-version'];
      const metadata = nativePublicationMetadataArtifactRow({
        id: 'liboliphaunt-native',
        version: nativeVersion,
      });
      const transport =
        failure !== 'frozen-missing'
          ? fixture.transport
          : {
              ...fixture.transport,
              readPages: async () => [
                {
                  id: 1,
                  name: metadata.name,
                  state: 'uploaded',
                  size: 2,
                  url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
                },
              ],
              readBaseline: async () => ({ controlledFrozenInventory: true }) as any,
              proveAsset: async (_url, _name, _size, options) => {
                mkdirSync(path.dirname(options.retainedPath), { recursive: true });
                writeFileSync(options.retainedPath, '{}');
                const actual = fileIdentity(options.retainedPath);
                return { bytes: actual.size, sha256: actual.sha256 };
              },
            };
      await expect(
        acquireNativePublicationInputs(
          {
            source,
            directory: path.join(directory, failure),
            consumerProducts: ['oliphaunt-rust'],
          },
          transport,
        ),
      ).rejects.toThrow(
        failure === 'missing'
          ? 'missing actual part'
          : failure === 'version'
            ? 'requested identity'
            : failure === 'requirement'
              ? 'differs from its parent'
              : 'absent from frozen inventory',
      );
      expect(existsSync(path.join(directory, failure))).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SDK source payloads deduplicate shared requests while a local server SDK needs no held runtime', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'held-wasix-payload-inputs-'));
  try {
    const fixture = payloadAcquisitionTransport();
    const acquired = await acquireNativePublicationInputs(
      {
        source,
        directory: path.join(directory, 'shared'),
        consumerProducts: ['oliphaunt-pgwire-server', 'oliphaunt-wasix-rust'],
      },
      fixture.transport,
    );
    expect(new Set(fixture.requests).size).toBe(fixture.requests.length);
    const runtimeRows =
      acquired.snapshot.supplierArtifacts?.filter(
        (row) => row.publication.product === 'liboliphaunt-wasix',
      ) ?? [];
    expect(
      runtimeRows.filter((row) => row.artifact.startsWith('cargo:liboliphaunt-wasix-')),
    ).toHaveLength(5);
    expect(
      runtimeRows.filter((row) => row.artifact.startsWith('cargo:oliphaunt-extension-contrib-')),
    ).toHaveLength(5);
    const held = payloadAcquisitionTransport({ heldRuntime: '0.3.1' });
    const heldOnly = await acquireNativePublicationInputs(
      {
        source,
        directory: path.join(directory, 'held'),
        consumerProducts: ['oliphaunt-pgwire-server'],
      },
      held.transport,
    );
    expect(
      heldOnly.snapshot.supplierArtifacts
        ?.filter((row) => row.artifact.startsWith('cargo:liboliphaunt-wasix-'))
        .map((row) => row.publication.version),
    ).toEqual([]);
    expect(held.requests.map((request) => request.split('@')[0])).toEqual([
      'cargo:oliphaunt-query',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('compiled external WASIX hosts retain their exact portable crate without an SDK request', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'external-wasix-host-inputs-'));
  const metadata = loadReleaseMetadata(ROOT);
  const products = loadProducts();
  const consumer = 'oliphaunt-extension-pg-textsearch';
  const floor = metadata.products[consumer].compatibility_versions['liboliphaunt-wasix'];
  expect(typeof metadata.wasixExtensions.pg_textsearch['native-module-file']).toBe('string');
  try {
    for (const consumers of [
      [consumer],
      [consumer, 'oliphaunt-extension-pg-ivm', 'oliphaunt-wasix-rust'],
    ]) {
      const fixture = payloadAcquisitionTransport();
      const nativeFloors = new Set(
        consumers
          .filter((id) => products[id].extension?.class === 'external')
          .map((id) => metadata.products[id].compatibility_versions['liboliphaunt-native']),
      );
      const nativeRows = [...nativeFloors].flatMap((version) =>
        expectedProductArtifactRows([{ ...products['liboliphaunt-native'], version }]).filter(
          (row) =>
            row.kind === 'apple-swiftpm-binary' ||
            (row.kind === 'runtime-resources' && row.target === 'ios-datum64'),
        ),
      );
      const publicFiles = new Map(
        nativeRows.map((row, index) => [
          row.name,
          {
            id: index + 100,
            row,
            bytes: Buffer.from(`controlled held native archive ${row.name}`),
          },
        ]),
      );
      const acquired = await acquireNativePublicationInputs(
        {
          source,
          directory: path.join(directory, String(consumers.length)),
          consumerProducts: consumers,
        },
        {
          ...fixture.transport,
          readPages: async () =>
            [...publicFiles.values()].map(({ id, row, bytes }) => ({
              id,
              name: row.name,
              state: 'uploaded',
              size: bytes.length,
              digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${id}`,
            })),
          proveAsset: async (url, name, size, options) => {
            const retained = publicFiles.get(name)!;
            expect(retained).toBeDefined();
            expect(url).toBe(
              `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${retained.id}`,
            );
            expect(size).toBe(retained.bytes.length);
            mkdirSync(path.dirname(options.retainedPath), { recursive: true });
            writeFileSync(options.retainedPath, retained.bytes);
            const identity = fileIdentity(options.retainedPath);
            expect(identity.sha256).toBe(options.expectedSha256);
            return { bytes: identity.size, sha256: identity.sha256 };
          },
        },
      );
      const artifact = 'cargo:liboliphaunt-wasix-portable';
      expect(fixture.requests.filter((request) => request === `${artifact}@${floor}`)).toHaveLength(
        1,
      );
      expect(new Set(fixture.requests).size).toBe(fixture.requests.length);
      expect(fixture.requests.some((request) => request.startsWith('cargo:oliphaunt-wasix@'))).toBe(
        false,
      );
      const rows = (acquired.snapshot.supplierArtifacts ?? []).filter(
        (row) => row.artifact === artifact,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.publication.product).toBe('liboliphaunt-wasix');
      expect(row.publication.version).toBe(floor);
      expect(fileIdentity(row.file.path).sha256).toBe(row.file.sha256);
      expect(
        (acquired.snapshot.supplierArtifacts ?? [])
          .filter((row) => row.publication.product === 'liboliphaunt-native')
          .map((row) => row.artifact)
          .sort(),
      ).toEqual(nativeRows.map((row) => row.id).sort());
      const key = `liboliphaunt-wasix/${floor}/${artifact}`;
      const projected = nativePublicationInputProjection(acquired.snapshot).supplierArtifacts[key];
      expect(projected.publication).toEqual(row.publication);
      expect(projected.file).toEqual({
        ...row.file,
        path: `@oliphaunt_metadata//:supplier-artifacts/liboliphaunt-wasix/${floor}/${row.file.sha256}/${path.basename(row.file.path)}`,
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('first publication requires initial source versions and proves public absence once for all new owners', async () => {
  const calls = [];
  const readPages = async (endpoint) => {
    calls.push(endpoint);
    return [];
  };
  await assertNeverPublishedNativeProducts([], { readPages });
  expect(calls).toEqual([]);
  await assertNeverPublishedNativeProducts(
    [
      { id: 'new-alpha', version: '0.0.0' },
      { id: 'new-beta', version: '0.0.0' },
    ],
    { readPages },
  );
  expect(calls).toEqual(['repos/f0rr0/oliphaunt/tags', 'repos/f0rr0/oliphaunt/releases']);
  for (const historical of ['tag', 'release'])
    await expect(
      assertNeverPublishedNativeProducts([{ id: 'new-alpha', version: '0.0.0' }], {
        readPages: async (endpoint) =>
          endpoint.endsWith(historical === 'tag' ? '/tags' : '/releases')
            ? [
                historical === 'tag'
                  ? { name: 'new-alpha-v0.1.0' }
                  : { tag_name: 'new-alpha-v0.1.0' },
              ]
            : [],
      }),
    ).rejects.toThrow('already has published version history');
  await expect(
    assertNeverPublishedNativeProducts([{ id: 'new-alpha', version: '0.1.0' }], { readPages }),
  ).rejects.toThrow('initial products');
  await expect(
    assertNeverPublishedNativeProducts([{ id: 'new-alpha', version: '0.0.0' }], {
      readPages: async () => {
        throw new Error('history unavailable');
      },
    }),
  ).rejects.toThrow('history unavailable');
});

test('historical acquisition retains retired identities and follows the old parent archive part set once', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-historical-acquisition-'));
  const publication = {
    product: 'liboliphaunt-native',
    version: '1.0.0',
    tagName: 'liboliphaunt-native-v1.0.0',
    publicationSha: 'c'.repeat(40),
    publicationTree: 'd'.repeat(40),
    releaseSha: 'c'.repeat(40),
  };
  const parent = {
    id: 'cargo:oliphaunt-linux-x64-gnu',
    product: publication.product,
    ecosystem: 'cargo',
    name: 'oliphaunt-linux-x64-gnu',
    version: publication.version,
    role: 'platform-leaf',
    target: 'linux-x64-gnu',
    declared: true,
  };
  const npm = {
    id: 'npm:@oliphaunt/retired-native',
    product: publication.product,
    ecosystem: 'npm',
    name: '@oliphaunt/retired-native',
    version: publication.version,
    role: 'platform-leaf',
    target: 'linux-x64-gnu',
    declared: true,
  };
  const requested = [];
  const assets = [
    {
      name: 'retired-native-1.0.0.tar.gz',
      url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
      size: 3,
    },
  ];
  const transport = {
    inventory: async () => ({
      publication,
      catalog: { products: [], carriers: [parent, npm] },
      publicRows: [{ id: 'github-release:retired-native-1.0.0.tar.gz', name: assets[0].name }],
    }),
    readJson: async () => ({ id: 1 }),
    readPages: async () => assets,
    materialize: async (carrier, options) => {
      requested.push(carrier.id);
      mkdirSync(options.directory, { recursive: true });
      const file = path.join(options.directory, carrier.artifacts[0].path);
      writeFileSync(
        file,
        tarArchive(
          carrier.ecosystem === 'npm'
            ? [
                {
                  name: 'package/package.json',
                  data: JSON.stringify({
                    name: carrier.name,
                    version: publication.version,
                    repository: { type: 'git', url: 'git+https://github.com/f0rr0/oliphaunt.git' },
                  }),
                },
              ]
            : [
                {
                  name: `${carrier.name}-${publication.version}/Cargo.toml`,
                  data: `[package]\nname = "${carrier.name}"\nversion = "${publication.version}"\n${carrier.id === parent.id ? `[dependencies]\n${parent.name}-part-001 = "=${publication.version}"\n` : ''}`,
                },
              ],
        ),
      );
      const identity = fileIdentity(file);
      if (carrier.artifacts[0].sha256) {
        expect(carrier.artifacts[0].sha256).toBe(identity.sha256);
        expect(carrier.artifacts[0].size).toBe(identity.size);
      }
      return {
        carrier: {
          ...carrier,
          artifacts: [{ path: file, size: identity.size, sha256: identity.sha256 }],
        },
        receipt: {},
        metadata: {},
      };
    },
    proveAsset: async (_url, _name, _size, options) => {
      requested.push('old-public-target');
      mkdirSync(path.dirname(options.retainedPath), { recursive: true });
      writeFileSync(options.retainedPath, 'old');
      const identity = fileIdentity(options.retainedPath);
      return { bytes: identity.size, sha256: identity.sha256 };
    },
  };
  try {
    const result = await acquireCompletedNativeDeliveryBaseline(
      { publication, directory },
      transport,
    );
    expect(requested).toEqual([
      parent.id,
      npm.id,
      `cargo:${parent.name}-part-001`,
      'old-public-target',
    ]);
    expect(Object.keys(result.baseline.carriers).sort()).toEqual(
      [parent.id, npm.id, `cargo:${parent.name}-part-001`].sort(),
    );
    expect(Object.keys(result.baseline.productArtifacts)).toEqual([
      'github-release:retired-native-1.0.0.tar.gz',
    ]);
    const metadataBaseline = { originalAuthenticatedObject: true } as any;
    requested.length = 0;
    const frozen = await acquireCompletedNativeDeliveryBaseline(
      { publication, directory: path.join(directory, 'frozen'), metadataBaseline },
      {
        ...transport,
        inventory: async (_publication, options) => {
          expect(options.metadataBaseline).toBe(metadataBaseline);
          return {
            publication,
            catalog: result.historical.catalog,
            carriers: result.retained.map(({ carrier }) => carrier),
            publicRows: [
              {
                id: 'github-release:retired-native-1.0.0.tar.gz',
                name: assets[0].name,
                size: 3,
                sha256: createHash('sha256').update('old').digest('hex'),
              },
            ],
          };
        },
      },
    );
    expect(frozen.baseline.metadataBaseline).toBe(metadataBaseline);
    expect(requested).toEqual([
      parent.id,
      npm.id,
      `cargo:${parent.name}-part-001`,
      'old-public-target',
    ]);
    await expect(
      acquireCompletedNativeDeliveryBaseline(
        { publication, directory: path.join(directory, 'missing-frozen-part'), metadataBaseline },
        {
          ...transport,
          inventory: async () => ({
            publication,
            catalog: result.historical.catalog,
            carriers: result.retained
              .map(({ carrier }) => carrier)
              .filter((carrier) => carrier.id !== `cargo:${parent.name}-part-001`),
            publicRows: [],
          }),
        },
      ),
    ).rejects.toThrow('completed Cargo part is absent from frozen inventory');
    await expect(
      acquireCompletedNativeDeliveryBaseline(
        { publication, directory: path.join(directory, 'missing') },
        { ...transport, readPages: async () => [] },
      ),
    ).rejects.toThrow('missing or ambiguous');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('WASIX source SDK and historical facade retain their own exact runtime and host packages once', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-facade-supplier-'));
  const hosts = allArtifactTargets({
    product: 'oliphaunt-wasix-napi',
    surface: 'npm-optional',
  }).filter((row) => row.npm_os === process.platform && row.npm_cpu === process.arch);
  expect(hosts).toHaveLength(1);
  const sourceSdk = JSON.parse(sourceText('src/wasix/sdks/ts/package.json'));
  const sourceHostVersion = sourceSdk.oliphaunt.wasixNapiVersion;
  const coreName = loadProducts()['liboliphaunt-wasix'].registry_packages.find((name) =>
    name.startsWith('npm:'),
  )!;
  let historicalHost = '@oliphaunt/retired-host-native';
  let historicalHostVersion = '0.1.9';
  let missingSourceHost = false;
  expect(sourceHostVersion).not.toBe(historicalHostVersion);
  const facade = loadPublicationCatalog('published facade fixture').products.find(
    (product) => product.id === 'oliphaunt-wasix-ts',
  )!;
  const acquisitions: string[] = [];
  const transport = {
    inventory: async (publication) => {
      const value = await fixtureCompletedNativeInventory(publication);
      if (publication.product === 'liboliphaunt-wasix')
        expect(value.carriers.filter((row) => row.ecosystem === 'npm')).toHaveLength(2);
      if (publication.product !== 'oliphaunt-wasix-napi') return value;
      const host = value.carriers.find((row) => row.name === hosts[0].npm_package)!;
      if (missingSourceHost && publication.version === sourceHostVersion)
        return { ...value, carriers: value.carriers.filter((row) => row.name !== host.name) };
      if (publication.version !== historicalHostVersion) return value;
      return {
        ...value,
        inputContext: undefined,
        carriers: [
          {
            ...host,
            id: `npm:${historicalHost}`,
            name: historicalHost,
            role: 'previous-host-role',
          },
        ],
      };
    },
    readPages: async () => [],
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
                    optionalDependencies: { [historicalHost]: historicalHostVersion },
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
    expect(acquisitions.toSorted()).toEqual(
      [
        'npm:@oliphaunt/ts-query@0.1.1',
        `${coreName}@${sourceSdk.oliphaunt.runtimeVersion}`,
        `npm:${hosts[0].npm_package}@${sourceHostVersion}`,
        `npm:@oliphaunt/wasix-ts@${facade.version}`,
        `npm:${historicalHost}@${historicalHostVersion}`,
      ].sort(),
    );
    expect(result.snapshot.seedControls).toEqual([]);
    expect(
      result.snapshot.supplierArtifacts
        ?.map((row) => [row.artifact, row.publication.version])
        .sort(),
    ).toEqual(
      [
        ['npm:@oliphaunt/ts-query', '0.1.1'],
        [coreName, sourceSdk.oliphaunt.runtimeVersion],
        [`npm:${hosts[0].npm_package}`, sourceHostVersion],
        ['npm:@oliphaunt/wasix-ts', facade.version],
        [`npm:${historicalHost}`, historicalHostVersion],
      ].sort(),
    );
    expect(
      result.snapshot.supplierArtifacts?.every(
        (row) => fileIdentity(row.file.path).sha256 === row.file.sha256,
      ),
    ).toBe(true);
    expect(new Set(acquisitions).size).toBe(acquisitions.length);
    expect(result.snapshot).not.toHaveProperty('ready');
    acquisitions.length = 0;
    historicalHost = hosts[0].npm_package;
    historicalHostVersion = sourceHostVersion;
    const shared = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'shared'), consumerProducts: [facade.id] },
      transport,
    );
    expect(acquisitions).toHaveLength(4);
    expect(new Set(acquisitions).size).toBe(acquisitions.length);
    expect(
      shared.snapshot.supplierArtifacts?.filter((row) => row.artifact === `npm:${historicalHost}`),
    ).toHaveLength(1);
    missingSourceHost = true;
    await expect(
      acquireNativePublicationInputs(
        {
          source,
          directory: path.join(directory, 'missing-source-host'),
          consumerProducts: [facade.id],
        },
        transport,
      ),
    ).rejects.toThrow('requested supplier is absent from its completed inventory');
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
        inventory: fixtureCompletedNativeInventory,
        readPages: async () => [],
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
    expect(retained.sort()).toEqual(['cargo:oliphaunt-query']);
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
            readPages: (endpoint, options) =>
              requestGithubPages(endpoint, {
                ...options,
                environment: {},
                fetchImpl: async (url) => {
                  expect(url).toBe(
                    'https://api.github.com/repos/f0rr0/oliphaunt/actions/runs/77/artifacts?per_page=100&page=1',
                  );
                  return Response.json({ total_count: artifacts.length, artifacts });
                },
              }),
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
  content: string | Uint8Array,
  mode?: number,
) {
  const output = `bazel-out/k8-opt/bin/${row.product}/${row.name}`;
  const file = path.join(directory, 'files/0', output);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
  const identity = fileIdentity(file);
  return {
    file,
    origin: {
      github: {
        repository: 'f0rr0/oliphaunt',
        workflow: 'Native Bazel qualification',
        workflowPath: '.github/workflows/bazel.yml',
        runId: 77,
        runAttempt: 1,
        job: 'Linux runtime (x86_64)',
      },
      evidence: {
        source,
        cohorts: [
          {
            executionRoot: '/fixture/execroot',
            roots: [
              {
                label: `//${row.product}:shipping`,
                package: {
                  product: row.product,
                  version: row.version,
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
                    mode: identity.mode,
                  },
                ],
              },
            ],
          },
        ],
      },
      finalFiles: {
        files: [{ cohort: 0, path: output, size: identity.size, sha256: identity.sha256 }],
        file(cohort: number, declaredPath: string) {
          expect(cohort).toBe(0);
          expect(declaredPath).toBe(output);
          expect(fileIdentity(file)).toEqual(identity);
          return file;
        },
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
      (row) =>
        row.product === asset.product &&
        row.role === 'github-release-asset' &&
        row.kind === 'checksums',
    )!;
    const origins = new Map<string, any>();
    for (const [index, row] of [asset, checksum].entries()) {
      const evidenceRoot = path.join(directory, `producer-${index}`);
      origins.set(evidenceRoot, producer(evidenceRoot, row, `qualified ${row.name}`).origin);
    }
    const original = structuredClone([...origins.values()].map((origin) => origin.evidence));
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
    expect(() =>
      stageNativeReleaseFamilies(origins, source, path.join(directory, 'outside-target')),
    ).toThrow('must remain under target/');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(finalDirectory, { recursive: true, force: true });
  }
});

test('family staging preserves complete runtime, contrib and external publication layouts', {
  timeout: 30_000,
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-publication-families-'));
  const destination = path.join(ROOT, 'target', path.basename(directory));
  const fixtureRoot = path.join(directory, 'original-layouts');
  const catalog = loadPublicationCatalog('family publication reader test', {
    products: ['liboliphaunt-native', 'liboliphaunt-wasix', 'oliphaunt-extension-vector'],
  });
  const expected = expectedProductArtifactRows(catalog.products);
  const contrib = contribCarrierDescriptor('family publication reader test');
  const origins = new Map<string, any>();
  const familyInputs: { owner: string; key: string }[] = [];
  const fixedNames = new Map<string, string[]>();
  const publicFiles = new Map<string, { key: string; file: string }>();
  let sequence = 0;
  const retain = (row, file: string) => {
    const key = path.join(directory, 'packets', String(sequence++));
    const retained = producer(key, row, readFileSync(file), statSync(file).mode & 0o777);
    origins.set(key, retained.origin);
    return { key, ...retained };
  };
  const retainPublic = (owner: string, assetDirectory: string) => {
    for (const entry of readdirSync(assetDirectory, { withFileTypes: true })) {
      expect(entry.isFile()).toBe(true);
      const row = expected.find((row) => row.product === owner && row.name === entry.name);
      expect(row).toBeDefined();
      const retained = retain(row, path.join(assetDirectory, entry.name));
      publicFiles.set(`${owner}/${entry.name}`, retained);
    }
  };
  const retainFamily = (product, options = {}) => {
    const family = extensionGithubReleaseFixture(fixtureRoot, product, options);
    retainPublic(product.id, family.directory);
    const row = expected.find((row) => row.product === product.id)!;
    const input = retain(
      { ...row, name: 'extension-artifacts.json', role: 'extension-release-family-input' },
      family.manifestPath,
    );
    const root = input.origin.evidence.cohorts[0].roots[0];
    root.package.ecosystem = 'internal';
    root.package.name = `${product.id}-${familyInputs.length}-release-family`;
    root.package.configuration = 'portable';
    familyInputs.push({ owner: product.id, key: input.key });
    return family;
  };
  const selectedProducts = (ids: readonly string[]) =>
    catalog.products.filter((product) => ids.includes(product.id));
  const discover = (roots: string[], ids: readonly string[]) => {
    const products = selectedProducts(ids);
    const rows = discoverProductArtifacts(roots, products);
    const versions = new Map(products.map(({ id, version }) => [id, version]));
    expect(
      rows.map(({ product, id, role, kind, target, identity, name }) => ({
        product,
        version: versions.get(product),
        id,
        role,
        kind,
        target,
        identity,
        name,
      })),
    ).toEqual(expectedProductArtifactRows(products));
    for (const row of rows) {
      expect(path.resolve(ROOT, row.path).startsWith(`${destination}${path.sep}`)).toBe(true);
      const retained = publicFiles.get(`${row.product}/${row.name}`)!;
      expect(statSync(path.resolve(ROOT, row.path)).mode & 0o777).toBe(
        statSync(retained.file).mode & 0o777,
      );
    }
    return rows;
  };
  try {
    for (const product of catalog.products) {
      if (![contrib.nativeOwner, contrib.wasixOwner].includes(product.id)) continue;
      const fixed = githubReleaseFixture(fixtureRoot, product);
      fixedNames.set(product.id, fixed.rows.map(({ name }) => name).sort());
      retainPublic(product.id, fixed.directory);
    }
    const native = catalog.products.find(({ id }) => id === contrib.nativeOwner)!;
    const wasix = catalog.products.find(({ id }) => id === contrib.wasixOwner)!;
    const external = catalog.products.find(({ id }) => id === 'oliphaunt-extension-vector')!;
    const nativeFamily = retainFamily(native, {
      artifactProduct: contrib.artifactProduct,
      family: 'native',
    });
    retainFamily(wasix, { artifactProduct: contrib.artifactProduct, family: 'wasix' });
    retainFamily(external);
    const original = structuredClone([...origins.values()].map(({ evidence }) => evidence));
    // Raw manifest paths now point at deleted originals; retained Files must supply every byte.
    rmSync(fixtureRoot, { recursive: true, force: true });
    const ids = catalog.products.map(({ id }) => id);
    const staged = stageNativeReleaseFamilies(origins, source, destination, ids);
    const published = discover(staged, ids);
    const contribChecksums = published.filter(
      (row) =>
        [native.id, wasix.id].includes(row.product) &&
        row.role === 'github-release-metadata' &&
        row.kind === 'checksums',
    );
    expect(contribChecksums).toHaveLength(2);
    expect(new Set(contribChecksums.map(({ path: file }) => path.dirname(file))).size).toBe(2);
    for (const row of contribChecksums) {
      const version = catalog.products.find(({ id }) => id === row.product)!.version;
      expect(row.name).toBe(`${contrib.artifactProduct}-${version}-release-assets.sha256`);
    }
    for (const [owner, names] of fixedNames)
      expect(readdirSync(path.join(destination, owner, 'release-assets')).sort()).toEqual(names);
    expect([...origins.values()].map(({ evidence }) => evidence)).toEqual(original);
    for (const product of catalog.products) {
      const selected = path.join(destination, `selected-${product.id}`);
      const roots = stageNativeReleaseFamilies(origins, source, selected, [product.id]);
      const rows = discover(roots, [product.id]);
      expect(new Set(rows.map(({ product: owner }) => owner))).toEqual(new Set([product.id]));
    }
    const nativeAsset = publicFiles.get(`${native.id}/${nativeFamily.assets[0].name}`)!;
    const fixedChecksum = expected.find(
      (row) =>
        row.product === native.id &&
        row.role === 'github-release-asset' &&
        row.kind === 'checksums',
    )!;
    const checksum = publicFiles.get(`${native.id}/${fixedChecksum.name}`)!;
    for (const [fault, message] of [
      ['missing-family', /lacks its complete aggregate manifest/u],
      ['missing-asset', /lacks its declared public File/u],
      ['foreign-file', /canonical public owner/u],
      ['checksum', /checksum/u],
    ] as const) {
      const changed = new Map(origins);
      if (fault === 'missing-family')
        changed.delete(familyInputs.find(({ owner }) => owner === native.id)!.key);
      if (fault === 'missing-asset') changed.delete(nativeAsset.key);
      if (fault === 'foreign-file' || fault === 'checksum') {
        const row =
          fault === 'foreign-file'
            ? { ...fixedChecksum, name: 'foreign-public.bin' }
            : fixedChecksum;
        const content =
          fault === 'foreign-file'
            ? 'foreign public bytes'
            : readFileSync(checksum.file, 'utf8').replace(/^[0-9a-f]{64}/u, '0'.repeat(64));
        const key = path.join(directory, 'packets', fault);
        changed.set(key, producer(key, row, content).origin);
        if (fault === 'checksum') changed.delete(checksum.key);
      }
      const invalid = path.join(destination, fault);
      expect(() => {
        const roots = stageNativeReleaseFamilies(changed, source, invalid, [native.id]);
        discoverProductArtifacts(roots, [native]);
      }).toThrow(message);
    }
    for (const origin of origins.values()) origin.finalFiles.assertUnchanged();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('family staging projects Windows loose modes while retaining POSIX safety and original evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-family-modes-'));
  const finalDirectory = path.join(ROOT, 'target', path.basename(directory));
  try {
    const rows = expectedProductArtifactRows(
      loadPublicationCatalog('family transport modes').products,
    );
    const asset = rows.find(
      (row) =>
        row.product === 'liboliphaunt-native' &&
        row.role === 'github-release-asset' &&
        row.target.includes('windows'),
    )!;
    expect(asset).toBeDefined();
    const checksum = rows.find(
      (row) =>
        row.product === asset.product &&
        row.role === 'github-release-asset' &&
        row.kind === 'checksums',
    )!;
    for (const scenario of [
      {
        name: 'windows-drive',
        executionRoot: 'C:\\b\\execroot\\_main',
        mode: 0o666,
        expected: 0o644,
      },
      {
        name: 'windows-slashes',
        executionRoot: 'D:/b/execroot/_main',
        mode: 0o444,
        expected: 0o644,
      },
      {
        name: 'windows-unc',
        executionRoot: '\\\\runner\\share\\execroot\\_main',
        mode: 0o666,
        expected: 0o644,
      },
      {
        name: 'posix-read-only',
        executionRoot: '/windows-target/execroot',
        mode: 0o444,
        expected: 0o444,
      },
      {
        name: 'posix-executable',
        executionRoot: '/windows-target/execroot',
        mode: 0o555,
        expected: 0o555,
      },
      { name: 'posix-world-writable', executionRoot: '/windows-target/execroot', mode: 0o666 },
      { name: 'posix-writable-executable', executionRoot: '/windows-target/execroot', mode: 0o775 },
      { name: 'posix-unreadable', executionRoot: '/windows-target/execroot', mode: 0o222 },
    ]) {
      const originals = [asset, checksum].map((row, index) => {
        const evidenceRoot = path.join(directory, scenario.name, String(index));
        const captured = producer(evidenceRoot, row, `qualified ${row.name}`);
        const cohort = captured.origin.evidence.cohorts[0];
        cohort.executionRoot = scenario.executionRoot;
        cohort.outputs[0].members[0].mode = scenario.mode;
        return { ...captured, evidenceRoot };
      });
      const origins = new Map(originals.map(({ evidenceRoot, origin }) => [evidenceRoot, origin]));
      const evidence = structuredClone(originals.map(({ origin }) => origin.evidence));
      const identities = originals.map(({ file }) => fileIdentity(file));
      const destination = path.join(finalDirectory, scenario.name);
      if (scenario.expected === undefined) {
        expect(() => stageNativeReleaseFamilies(origins, source, destination)).toThrow(
          'unsafe captured mode',
        );
        expect(existsSync(destination)).toBe(false);
      } else {
        const staged = stageNativeReleaseFamilies(origins, source, destination);
        for (const row of [asset, checksum]) {
          const file = path.join(staged[0], row.name);
          expect(readFileSync(file, 'utf8')).toBe(`qualified ${row.name}`);
          expect(statSync(file).mode & 0o777).toBe(scenario.expected);
        }
        if (scenario.name === 'windows-drive') {
          const selected = stageNativeReleaseFamilies(origins, source, `${destination}-selected`, [
            asset.product,
          ]);
          expect(readFileSync(path.join(selected[0], asset.name))).toEqual(
            readFileSync(path.join(staged[0], asset.name)),
          );
          expect(statSync(path.join(selected[0], asset.name)).mode & 0o777).toBe(0o644);
        }
      }
      expect(originals.map(({ origin }) => origin.evidence)).toEqual(evidence);
      expect(originals.map(({ file }) => fileIdentity(file))).toEqual(identities);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(finalDirectory, { recursive: true, force: true });
  }
});

test('family staging selects each declared fixed asset from its shared original Tree', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-shared-family-'));
  const finalDirectory = path.join(ROOT, 'target', path.basename(directory));
  try {
    const rows = expectedProductArtifactRows(
      loadPublicationCatalog('shared iOS family staging test').products,
    ).filter(
      (row) =>
        row.product === 'liboliphaunt-native' &&
        (row.kind === 'apple-swiftpm-binary' ||
          (row.kind === 'runtime-resources' && row.target === 'ios-datum64')),
    );
    expect(rows).toHaveLength(2);
    const evidenceRoot = path.join(directory, 'producer');
    const originals = rows.map((row) => producer(evidenceRoot, row, `qualified ${row.name}`));
    const output = path.posix.dirname(originals[0].origin.evidence.cohorts[0].outputs[0].path);
    const members = originals.map((value, index) => ({
      ...value.origin.evidence.cohorts[0].outputs[0].members[0],
      path: rows[index].name,
    }));
    const roots = originals.map((value, index) => ({
      ...value.origin.evidence.cohorts[0].roots[0],
      label: `//fixture:ios_asset_${index}`,
      package: {
        ...value.origin.evidence.cohorts[0].roots[0].package,
        outputs: [{ path: output }],
      },
    }));
    const origin = originals[0].origin;
    origin.evidence.cohorts[0] = {
      executionRoot: '/fixture/execroot',
      roots,
      outputs: [{ path: output, members }],
    };
    origin.finalFiles = {
      files: originals.flatMap((value) => value.origin.finalFiles.files),
      assertUnchanged() {
        for (const [index, value] of originals.entries()) {
          const actual = fileIdentity(value.file);
          expect({ size: actual.size, sha256: actual.sha256 }).toEqual({
            size: members[index].size,
            sha256: members[index].sha256,
          });
        }
      },
    };
    const origins = new Map([[evidenceRoot, origin]]);
    const original = structuredClone(origin.evidence);
    const final = stageNativeReleaseFamilies(origins, source, finalDirectory);
    expect(final).toEqual([path.join(finalDirectory, rows[0].product, 'release-assets')]);
    for (const row of rows)
      for (const family of final)
        expect(readFileSync(path.join(family, row.name), 'utf8')).toBe(`qualified ${row.name}`);
    expect(origin.evidence).toEqual(original);

    for (const [label, change, message] of [
      [
        'missing',
        (value: any) => value.evidence.cohorts[0].outputs[0].members.shift(),
        'exact original regular File',
      ],
      [
        'ambiguous',
        (value: any) =>
          value.evidence.cohorts[0].outputs[0].members.push({
            ...members[0],
            path: `nested/${members[0].path}`,
          }),
        'exact original regular File',
      ],
      [
        'duplicate',
        (value: any) => value.evidence.cohorts[0].roots.push(structuredClone(roots[0])),
        'repeats an observed public File',
      ],
      [
        'owner',
        (value: any) => {
          value.evidence.cohorts[0].roots[0].package.product = 'database-resources';
        },
        'unique canonical public owner',
      ],
      [
        'hash',
        (value: any) => {
          value.evidence.cohorts[0].outputs[0].members[0].sha256 = '0'.repeat(64);
        },
        'changed during relocation',
      ],
    ] as const) {
      const changed = { ...origin, evidence: structuredClone(original) };
      change(changed);
      const destination = path.join(finalDirectory, label);
      expect(() =>
        stageNativeReleaseFamilies(new Map([[evidenceRoot, changed]]), source, destination),
      ).toThrow(message);
      expect(existsSync(destination)).toBe(false);
      expect(origin.evidence).toEqual(original);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(finalDirectory, { recursive: true, force: true });
  }
});

test('native archive acquisition preserves preexisting output directories', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-family-owned-'));
  const destination = path.join(directory, 'input');
  try {
    for (const existing of [destination, `${destination}.inputs`]) {
      mkdirSync(existing);
      const sentinel = path.join(existing, 'sentinel');
      writeFileSync(sentinel, 'retained');
      await expect(
        acquireNativeReleaseArchives(
          { source, runId: 77, directory: destination },
          {
            readJson: async () => {
              throw new Error('preexisting output must reject before acquisition');
            },
          },
        ),
      ).rejects.toThrow('new owned');
      expect(readFileSync(sentinel, 'utf8')).toBe('retained');
      rmSync(existing, { recursive: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
          { name: 'native-build-evidence-react-native-macos-arm64', expired: false },
          { name: 'arbitrary', expired: false },
        ],
        acquire: async (evidenceRoot, expected) => {
          acquired.push(expected);
          return producer(evidenceRoot, row, 'current PR bytes').origin;
        },
      },
    );
    expect(acquired).toHaveLength(1);
    expect(acquired.map((row) => row.artifactName)).toEqual(['native-build-evidence-x86_64']);
    expect(acquired[0].event).toBe('pull_request');
    expect(acquired[0].ref).toBe('refs/pull/295/merge');
    expect(acquired[0].github).not.toHaveProperty('runAttempt');
    expect([...result.origins.values()][0].github.runAttempt).toBe(1);
    expect([...result.origins.keys()]).toEqual([path.join(result.directory, '0')]);
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
      inventory: fixtureCompletedNativeInventory,
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

test('declared held Swift source uses its retired binding name and historical owner path once', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'held-swift-inputs-'));
  const bindings = Buffer.from('controlled owned binding ZIP bytes');
  const expected = 'retired-swift-binding-0.8.2.zip';
  const metadataName = 'oliphaunt-swift-0.8.2-native-baseline.json';
  const metadataBytes = Buffer.from('controlled completed metadata bytes');
  const originalMetadata = { metadata: {}, baselineAdmission: 'unknown' } as any;
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
        inventory: async (publication, options) => {
          const historical = await fixtureCompletedNativeInventory(publication);
          if (publication.product !== 'oliphaunt-swift') return historical;
          expect(options.metadataBaseline).toBe(originalMetadata);
          return {
            ...historical,
            descriptor: { ...historical.descriptor, path: 'retired/swift-source' },
            publicRows: historical.publicRows.map((row) =>
              row.kind === 'swift-bindings'
                ? { ...row, id: `github-release:${expected}`, name: expected }
                : row,
            ),
          };
        },
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
          {
            id: 2,
            name: metadataName,
            state: 'uploaded',
            size: metadataBytes.length,
            url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/2',
            digest: 'sha256:' + createHash('sha256').update(metadataBytes).digest('hex'),
          },
        ],
        readBaseline: async ({ file }) => {
          expect(readFileSync(file)).toEqual(metadataBytes);
          return originalMetadata;
        },
        assertCompleted: async (request) => ({
          ...request,
          publicationTree: 'd'.repeat(40),
          releaseSha: request.publicationSha,
        }),
        proveAsset: async (_url, name, size, options) => {
          acquisitions.push(name);
          mkdirSync(path.dirname(options.retainedPath), { recursive: true });
          const bytes = name === metadataName ? metadataBytes : bindings;
          expect(size).toBe(bytes.length);
          writeFileSync(options.retainedPath, bytes);
          return { bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') };
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
    expect(acquisitions).toEqual([metadataName, expected]);
    expect(result.supplierMetadata.get('oliphaunt-swift@0.8.2')).toBe(originalMetadata);
    expect(readFileSync(result.file, 'utf8')).not.toContain('baselineAdmission');
    expect(captures).toHaveLength(1);
    expect(captures[0].descriptor.path).toBe('retired/swift-source');
    expect(captures[0].bindings.name).toBe(expected);
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
    const artifacts = [
      { name: 'native-build-evidence-mobile-ios', expired: false },
      { name: 'native-build-evidence-native-macos-arm64', expired: false },
      { name: 'native-build-evidence-react-native-macos-arm64', expired: false },
      { name: 'native-build-evidence-release-families', expired: false },
    ];
    const readPages = (endpoint, options) =>
      requestGithubPages(endpoint, {
        ...options,
        environment: {},
        fetchImpl: async (url) => {
          expect(url).toBe(
            'https://api.github.com/repos/f0rr0/oliphaunt/actions/runs/77/artifacts?per_page=100&page=1',
          );
          return Response.json({ total_count: artifacts.length, artifacts });
        },
      });
    const acquire = async (_root: string, expected: any) => {
      requests.push(expected.artifactName);
      return {
        github: { ...expected.github, runAttempt: 1 },
        finalFiles: { qualification: { requiredTests: [] } },
      } as any;
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

test('mixed producer acquisition keeps latest run observation separate from each authenticated role', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-mixed-attempts-'));
  try {
    const requests: any[] = [];
    const attempts = new Map([
      ['native-build-evidence-x86_64', 2],
      ['native-build-evidence-aarch64', 1],
    ]);
    const result = await acquireNativePublicationBuilds(
      { source, runId: 77, directory: path.join(directory, 'producers') },
      {
        readJson: async () => ({ ...eligible, run_attempt: 2 }),
        readPages: async () => [...attempts.keys()].map((name) => ({ name, expired: false })),
        acquire: async (_directory, expected) => {
          requests.push(expected);
          return {
            github: { ...expected.github, runAttempt: attempts.get(expected.artifactName) },
            finalFiles: { qualification: { requiredTests: [] } },
          } as any;
        },
      },
    );
    expect(result.run.run_attempt).toBe(2);
    expect(
      requests.every(
        (request) =>
          !Object.hasOwn(request.github, 'runAttempt') && request.workflowRunAttempt === 2,
      ),
    ).toBe(true);
    expect(result.builds.map((build) => build.expected.github.runAttempt)).toEqual([2, 1]);
    expect([...result.origins.values()].map((origin) => origin.github.runAttempt)).toEqual([2, 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SDK minimum acquisition asks its exact authored internal floors, including the declared helper', () => {
  const catalog = {
    products: [{ id: 'oliphaunt-rust', path: 'sdk', version: '0.3.3' }],
    carriers: [
      {
        id: 'cargo:liboliphaunt-native-bindings',
        name: 'liboliphaunt-native-bindings',
        ecosystem: 'cargo',
        target: null,
        product: 'liboliphaunt-native-bindings',
        version: '0.2.2',
      },
      {
        id: 'cargo:oliphaunt-build',
        name: 'oliphaunt-build',
        ecosystem: 'cargo',
        target: null,
        product: 'oliphaunt-rust',
        version: '0.3.3',
      },
    ],
  } as any;
  const source = `[package]\nname="oliphaunt"\nversion="0.3.3"\n[dependencies]\ncore={package="liboliphaunt-native-bindings",workspace=true}\nserde="1"\n[build-dependencies]\noliphaunt-build="0.3.2"\n`;
  const workspace = `[workspace.dependencies]\ncore={package="liboliphaunt-native-bindings",path="core",version="^0.2.1"}\n`;
  const read = (file: string) => (file === 'Cargo.toml' ? workspace : source);
  expect(nativeCargoMinimumBindings(catalog, [], read)).toEqual([]);
  expect(nativeCargoMinimumBindings(catalog, ['oliphaunt-rust'], read)).toEqual([
    {
      consumer: 'oliphaunt-rust',
      producer: 'liboliphaunt-native-bindings',
      producerVersion: '0.2.1',
      requestedCarrier: 'cargo:liboliphaunt-native-bindings',
    },
    {
      consumer: 'oliphaunt-rust',
      producer: 'oliphaunt-rust',
      producerVersion: '0.3.2',
      requestedCarrier: 'cargo:oliphaunt-build',
    },
  ]);
  for (const floor of ['0.2.1', '^0.2.1', '~0.2.1', '=0.2.1', '>=0.2.1, <0.3.0'])
    expect(
      nativeCargoMinimumBindings(catalog, ['oliphaunt-rust'], (file) =>
        read(file).replace('^0.2.1', floor),
      )[0].producerVersion,
    ).toBe('0.2.1');
  for (const floor of ['0.2', '^0.2', '~0.2', '=0.2', '>=0.2, <0.3'])
    expect(
      nativeCargoMinimumBindings(catalog, ['oliphaunt-rust'], (file) =>
        read(file).replace('^0.2.1', floor),
      )[0].producerVersion,
    ).toBe('0.2.0');
  for (const floor of ['*', '>0.2.1', '>=0.2.1, <0.2.1', '^0.2.1 || ^0.3.0'])
    expect(() =>
      nativeCargoMinimumBindings(catalog, ['oliphaunt-rust'], (file) =>
        read(file).replace('^0.2.1', floor),
      ),
    ).toThrow('Internal Cargo minimum');
  const initial = {
    ...catalog,
    carriers: catalog.carriers.map((row: any) => ({ ...row, version: '0.0.0' })),
  };
  expect(
    nativeCargoMinimumBindings(initial, ['oliphaunt-rust'], (file) =>
      read(file).replaceAll('0.2.1', '0.0.0').replaceAll('0.3.2', '0.0.0'),
    ),
  ).toEqual([]);
});

test('shared SDK supplier acquisition retains exact source floors once as physical pool Files', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-sdk-floor-inputs-'));
  const requests: string[] = [];
  const assets = expectedProductArtifactRows(
    loadPublicationCatalog().products.filter((row) => row.id === 'oliphaunt-broker'),
  )
    .filter((row) => row.kind === 'broker-helper')
    .map((row, index) => ({
      id: index + 1,
      name: row.name,
      size: 3,
      state: 'uploaded',
      url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 1}`,
    }));
  try {
    const result = await acquireNativePublicationInputs(
      { source, directory: path.join(directory, 'owned'), consumerProducts: ['oliphaunt-rust'] },
      {
        inventory: fixtureCompletedNativeInventory,
        readBaseline: async () => undefined,
        readPages: async () => assets,
        readJson: async (endpoint) => ({
          id: 1,
          target_commitish: 'c'.repeat(40),
          tag_name: decodeURIComponent(endpoint.split('/').at(-1)!),
        }),
        assertCompleted: async (request) => ({
          ...request,
          publicationTree: 'd'.repeat(40),
          releaseSha: request.publicationSha,
        }),
        materialize: async (carrier, options) => {
          requests.push(`${carrier.id}@${carrier.version}`);
          mkdirSync(options.directory, { recursive: true });
          const file = path.join(options.directory, carrier.artifacts[0].path);
          writeFileSync(
            file,
            tarArchive([
              {
                name: `${carrier.name}-${carrier.version}/Cargo.toml`,
                data: `[package]\nname="${carrier.name}"\nversion="${carrier.version}"\n`,
              },
            ]),
          );
          const identity = fileIdentity(file);
          return {
            carrier: {
              ...carrier,
              artifacts: [{ path: file, size: identity.size, sha256: identity.sha256 }],
            },
            receipt: {},
            metadata: {},
          };
        },
        proveAsset: async (_url, _name, _size, options) => {
          mkdirSync(path.dirname(options.retainedPath), { recursive: true });
          writeFileSync(options.retainedPath, 'old');
          const identity = fileIdentity(options.retainedPath);
          return { bytes: identity.size, sha256: identity.sha256 };
        },
      },
    );
    const sourceRequests = [
      'cargo:liboliphaunt-native-bindings@0.2.0',
      'cargo:oliphaunt-broker@0.3.1',
      'cargo:oliphaunt-build@0.3.2',
      'cargo:oliphaunt-query@0.1.1',
    ];
    const payloadRequests = [
      'linux-arm64-gnu',
      'linux-x64-gnu',
      'macos-arm64',
      'windows-x64-msvc',
    ].flatMap((target) => [
      `cargo:liboliphaunt-native-${target}@0.3.2`,
      `cargo:oliphaunt-broker-${target}@0.3.1`,
    ]);
    const expected = [...sourceRequests, ...payloadRequests].toSorted();
    expect(requests.toSorted()).toEqual(expected);
    expect(new Set(requests).size).toBe(expected.length);
    const retained =
      result.snapshot.supplierArtifacts?.filter((row) => row.artifact.startsWith('cargo:')) ?? [];
    const identities = retained.map((row) => `${row.artifact}@${row.publication.version}`);
    expect(identities.toSorted()).toEqual(expected);
    const sourceFloors = identities.filter((id) => sourceRequests.includes(id));
    expect(sourceFloors.toSorted()).toEqual(sourceRequests);
    expect(sourceFloors).toHaveLength(4);
    expect(identities.filter((id) => payloadRequests.includes(id))).toHaveLength(8);
    for (const row of retained)
      expect(fileIdentity(row.file.path)).toMatchObject({
        size: row.file.size,
        sha256: row.file.sha256,
      });
    expect(result.snapshot).not.toHaveProperty('qualified');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native floor acquisition groups alias normal/build/target requirements before one exact lookup', () => {
  const catalog = {
    products: [{ id: 'oliphaunt-rust', path: 'sdk', version: '0.3.3' }],
    carriers: [
      {
        id: 'cargo:liboliphaunt-native-bindings',
        name: 'liboliphaunt-native-bindings',
        ecosystem: 'cargo',
        target: null,
        product: 'liboliphaunt-native-bindings',
        version: '0.2.2',
      },
    ],
  } as any;
  const requests = (normal: string, build: string) =>
    nativeCargoMinimumBindings(catalog, ['oliphaunt-rust'], (file) =>
      file === 'Cargo.toml'
        ? '[workspace]\n'
        : `[package]\nname="oliphaunt"\nversion="0.3.3"\n[dependencies]\ncore={package="liboliphaunt-native-bindings",version="${normal}"}\n[build-dependencies]\ncore_build={package="liboliphaunt-native-bindings",version="${build}"}\n[target.'cfg(unix)'.dependencies]\ncore_target={package="liboliphaunt-native-bindings",version="^0.2.0"}\n`,
    );
  const expected = [
    {
      consumer: 'oliphaunt-rust',
      producer: 'liboliphaunt-native-bindings',
      producerVersion: '0.2.1',
      requestedCarrier: 'cargo:liboliphaunt-native-bindings',
    },
  ];
  expect(requests('^0.2.0', '^0.2.1')).toEqual(expected);
  expect(requests('^0.2.1', '^0.2.0')).toEqual(expected);
  expect(requests('0.2', '^0.2.1')).toEqual(expected);
  expect(requests('^0.2.1', '0.2')).toEqual(expected);
  expect(() => requests('=0.2.0', '^0.2.1')).toThrow('requirements conflict');
});
