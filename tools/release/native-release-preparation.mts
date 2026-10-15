/** The actual pre-version controller composes existing authentication and delivery readers. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sourceManifest } from '../../build_defs/languages/source-package.mts';
import {
  SEED_CONSTRUCTION_RECEIPT_SUFFIX,
  selectCompletedSeed,
  validateSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import { wasixSeedConsumerDeclaration } from '../../src/database-resources/seeds/wasix/consumer-contract.mts';
import {
  cargoDependencyMinimum,
  resolveCargoWorkspaceInheritance,
} from '../packaging/cargo-manifest.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  removeOwnedDirectory,
  requireSafeDirectoryChain,
} from '../packaging/release-directory-safety.mts';
import { nativeCargoArtifactRows } from '../packaging/rust-native-targets.mts';
import {
  acquireAuthenticatedNativeBuildEvidence,
  assertAuthenticatedNativeBuildOrigin,
  createNativeBuildEvidenceAcquirer,
  reviewedNativeProducerArtifacts,
  validateReviewedNativeProducerAssurance,
} from './authenticate-native-build-evidence.mts';
import {
  loadReleaseMetadata,
  nativePublicationInputProjection,
  type ReleaseMetadata,
} from './bazel-release-metadata.mts';
import { selectObservedShippingChanges } from './bazel-shipping-inputs.mts';
import { cargoCompatibilityDependency } from './compatibility-version-parser.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import { captureCompletedSwiftSourceTag } from './completed-swift-source-delivery.mts';
import { consumerHostTarget } from './frozen-consumer.mts';
import {
  matchesGithubWorkflowRef,
  requestGithubPages,
  requestGithubRepositoryJson,
} from './github-read.mts';
import {
  assertNativeSwiftShippingPhase,
  type NativeBuildSource,
  nativeShippingRootsHaveQualification,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import {
  type CompletedDeliveryBaseline,
  captureCompletedNativePublicArtifacts,
  captureCompletedNativeRegistryCarriers,
  captureCompletedNativeSwiftSourceSuppliers,
  compareNativeCompletedPhysicalDelivery,
  readCompletedNativeDeliveryInventory,
} from './native-completed-delivery.mts';
import { fileIdentity } from './native-file-identity.mts';
import { compareNativePreVersionDelivery } from './native-publication-delivery.mts';
import {
  acquireCompletedNativeMetadataBaseline,
  type assertAuthenticatedNativePublicBaseline,
  readCompletedNativePublicBaseline,
} from './native-publication-metadata.mts';
import {
  type NativePublicationBuild,
  observeNativePublicationConstruction,
} from './native-publication-observation.mts';
import {
  type NativeSeedConstructionBaseline,
  proposeSeedConstructionAnchor,
  readDeclaredSeedConstructionAnchor,
  writeSeedConstructionAnchorProposal,
} from './native-seed-baseline.mts';
import { type NativeSeedInputControl, projectNativeSeedInputs } from './native-seed-inputs.mts';
import { projectNativeBuildBoundSuppliers } from './native-shipping-suppliers.mts';
import {
  type NativeSupplierArtifact,
  validateNativeSupplierArtifacts,
} from './native-supplier-artifacts.mts';
import {
  assertNativeVersionSourceTransition,
  type NativeVersionSourceBridge,
} from './native-version-source.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  buildPublicationCandidate,
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  lockedPublicationFiles,
  sourceIdentity,
  validateCargoPayloadPartSets,
} from './publication-lock.mts';
import { constructionNativeFinalInputs } from './qualified-native-extension-final-inputs.mts';
import { materializeRegistryCarrierIntegrity } from './registry-integrity.mts';
import { DESKTOP_TARGETS } from './release-artifact-targets.mts';
import {
  compatibilityVersionEntries,
  compatibilityVersionFromText,
  loadProducts,
  productCompatibilityVersion,
  ROOT,
} from './release-graph.mts';
import { requestReleaseAssetProof } from './verify_github_release_attestations.mts';

/** Actual SDK declarations request exact internal source floors for installed qualification. */
export function nativeCargoMinimumBindings(
  catalog: ReturnType<typeof loadPublicationCatalog>,
  consumerProducts: string[],
  readText: (file: string) => string,
) {
  const requests = new Map<
    string,
    {
      consumer: string;
      producer: string;
      producerVersion: string;
      requestedCarrier: string;
    }
  >();
  const consumers = ['oliphaunt-rust', 'oliphaunt-broker'].filter((id) =>
    consumerProducts.includes(id),
  );
  if (!consumers.length) return [];
  const workspace = Bun.TOML.parse(readText('Cargo.toml')).workspace ?? {};
  for (const id of consumers) {
    const consumer = catalog.products.find((product) => product.id === id);
    assert(consumer, 'installed minimum needs its canonical source owner');
    const manifest = resolveCargoWorkspaceInheritance(
      Bun.TOML.parse(readText(path.posix.join(consumer.path, 'Cargo.toml'))),
      workspace,
    );
    const dependencies = new Map<
      string,
      { carrier: (typeof catalog.carriers)[number]; requirements: string[] }
    >();
    for (const table of [manifest, ...Object.values(manifest.target ?? {})] as any[])
      for (const section of ['dependencies', 'build-dependencies'])
        for (const [alias, declaration] of Object.entries(table[section] ?? {})) {
          const dependency =
            typeof declaration === 'string' ? { version: declaration } : (declaration as any);
          const carrier = catalog.carriers.find(
            (row) =>
              row.ecosystem === 'cargo' &&
              row.target === null &&
              row.name === (dependency.package ?? alias),
          );
          if (!carrier) continue;
          assert.equal(
            typeof dependency.version,
            'string',
            `Internal Cargo minimum needs its authored requirement: ${alias}`,
          );
          const group = dependencies.get(carrier.name) ?? { carrier, requirements: [] };
          group.requirements.push(dependency.version);
          dependencies.set(carrier.name, group);
        }
    for (const { carrier, requirements } of dependencies.values()) {
      const producerVersion = cargoDependencyMinimum(requirements);
      // An initial same-source dependency has no publication to acquire. Its
      // final qualification still requires the exact prepared selected File.
      if (producerVersion === '0.0.0' && carrier.version === '0.0.0') continue;
      const request = {
        consumer: consumer.id,
        producer: carrier.product,
        producerVersion,
        requestedCarrier: carrier.id,
      };
      requests.set(`${consumer.id}/${carrier.id}@${producerVersion}`, request);
    }
  }
  return [...requests.values()];
}

/** Request the payload identities written into the public source package. */
export function nativeCargoPayloadBindings(
  catalog: ReturnType<typeof loadPublicationCatalog>,
  consumerProducts: string[],
  readText: (file: string) => string,
  products = loadProducts(),
) {
  const requests: {
    consumer: string;
    producer: string;
    producerVersion: string;
    requestedCarrier: string;
  }[] = [];
  for (const id of ['oliphaunt-rust', 'oliphaunt-wasix-rust'].filter((id) =>
    consumerProducts.includes(id),
  )) {
    const consumer = catalog.products.find((row) => row.id === id);
    assert(consumer, 'Source payload request needs its canonical consumer');
    const compatibility: Record<string, string> = {};
    for (const entry of compatibilityVersionEntries(products, { requireSourceProduct: true })) {
      if (entry.product !== id) continue;
      const text = readText(entry.path);
      const dependency = cargoCompatibilityDependency(entry, text);
      if (dependency?.path !== undefined) continue;
      const carrier =
        dependency &&
        catalog.carriers.find(
          (row) =>
            row.product === entry.sourceProduct &&
            row.ecosystem === 'cargo' &&
            row.name === dependency.packageName,
        );
      if (
        carrier?.target === null &&
        catalog.carriers.some(
          (row) =>
            row.product === entry.sourceProduct && row.ecosystem === 'cargo' && row.target !== null,
        )
      )
        continue;
      const version = compatibilityVersionFromText(entry, text);
      assert(
        !compatibility[entry.sourceProduct] || compatibility[entry.sourceProduct] === version,
        'Source payload compatibility versions conflict',
      );
      compatibility[entry.sourceProduct] = version;
    }
    const artifacts = (producer: string) =>
      nativeCargoArtifactRows(
        producer,
        products[producer].artifact_targets.targets,
        products[producer].registry_packages,
      );
    const manifest = sourceManifest(
      readText(path.posix.join(consumer.path, 'Cargo.toml')),
      readText('Cargo.toml'),
      {
        product: id,
        version: consumer.version,
        compatibility,
        dependencyOwners: Object.fromEntries(
          catalog.carriers
            .filter((row) => row.ecosystem === 'cargo')
            .map((row) => [row.name, row.product]),
        ),
        ...(id === 'oliphaunt-rust'
          ? {
              nativeArtifacts: artifacts('liboliphaunt-native'),
              brokerArtifacts: artifacts('oliphaunt-broker'),
            }
          : {}),
      },
    );
    for (const { carrier, version: producerVersion } of cargoPayloadRequests(
      manifest,
      catalog,
      products,
    )) {
      if (producerVersion === '0.0.0' && carrier.version === '0.0.0') continue;
      requests.push({
        consumer: id,
        producer: carrier.product,
        producerVersion,
        requestedCarrier: carrier.id,
      });
    }
  }
  return requests;
}

function isCargoPayloadCarrier(carrier, products) {
  return (
    carrier.ecosystem === 'cargo' &&
    (carrier.product === 'liboliphaunt-native' || carrier.product === 'oliphaunt-broker'
      ? carrier.target !== null &&
        products[carrier.product].registry_packages.includes(`crates:${carrier.name}`)
      : (['liboliphaunt-wasix', 'postgres-tools-wasix'].includes(carrier.product) &&
          products[carrier.product].registry_packages.includes(`crates:${carrier.name}`)) ||
        (carrier.product === 'database-resources' && carrier.name === 'oliphaunt-icu'))
  );
}

function exactCargoPayloadVersion(requirement: string) {
  const exact =
    typeof requirement === 'string' &&
    /^=\s*(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/u.exec(requirement.trim());
  assert(exact, 'Cargo payload requires its exact authored version');
  return exact[1];
}

function cargoPayloadRequests(manifest, catalog, products) {
  const requests = new Map();
  for (const table of [manifest, ...Object.values(manifest.target ?? {})] as any[])
    for (const section of ['dependencies', 'build-dependencies'])
      for (const [alias, declaration] of Object.entries(table[section] ?? {}) as [string, any][]) {
        const carrier = catalog.carriers.find(
          (row) => row.ecosystem === 'cargo' && row.name === (declaration.package ?? alias),
        );
        if (!carrier || !isCargoPayloadCarrier(carrier, products)) continue;
        const version = exactCargoPayloadVersion(
          typeof declaration === 'string' ? declaration : declaration.version,
        );
        const prior = requests.get(carrier.id);
        assert(!prior || prior.version === version, 'Cargo payload versions conflict');
        requests.set(carrier.id, { carrier, version });
      }
  return [...requests.values()];
}

/** Construct the existing importer snapshot only from authenticated acquisition.
 * Old public seeds are explicit adoptions; they supply no historical recipe.
 */
export async function acquireNativePublicationInputs(
  {
    source,
    directory,
    consumerProducts = ['database-resources'],
    metadataOrigin,
  }: {
    source: NativeBuildSource;
    directory: string;
    consumerProducts?: string[];
    metadataOrigin?: { publisherSha: string; bundlePaths: string[] };
  },
  {
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    readBaseline = readCompletedNativePublicBaseline,
    readSeedAnchor = readDeclaredSeedConstructionAnchor,
    materialize = materializeRegistryCarrierIntegrity,
    captureSwiftSource = captureCompletedSwiftSourceTag,
    inventory = readCompletedNativeDeliveryInventory,
    assertCompleted = undefined as ReturnType<typeof createCompletedPublicationChecker> | undefined,
  } = {},
) {
  const repository = 'f0rr0/oliphaunt';
  const reads = new Map<string, Promise<any>>();
  const paged = new Map<string, Promise<any[]>>();
  const read = (endpoint: string) => {
    let result = reads.get(endpoint);
    if (!result) {
      result = Promise.resolve(readJson(endpoint));
      reads.set(endpoint, result);
    }
    return result;
  };
  const pages = (endpoint: string) => {
    let result = paged.get(endpoint);
    if (!result) {
      result = Promise.resolve(readPages(endpoint));
      paged.set(endpoint, result);
    }
    return result;
  };
  const complete =
    assertCompleted ??
    createCompletedPublicationChecker({
      repository,
      readJson: read,
      readPages: pages,
    });
  const catalog = loadPublicationCatalog('native publication input acquisition');
  assert.ok(
    Array.isArray(consumerProducts) &&
      new Set(consumerProducts).size === consumerProducts.length &&
      consumerProducts.every((id) => catalog.products.some((product) => product.id === id)),
    'native input requests need unique canonical consumer owners',
  );
  const seedConsumer = wasixSeedConsumerDeclaration(
    Bun.TOML.parse(
      readFileSync(path.join(ROOT, 'src/database-resources/seeds/wasix/Cargo.toml'), 'utf8'),
    ),
    productCompatibilityVersion('database-resources', 'liboliphaunt-wasix'),
    catalog.products.find(({ id }) => id === 'liboliphaunt-wasix')!.version,
  );
  const authoredProducts = loadProducts();
  const conventionalFiles = new Map<string, string>();
  const conventionalText = (file: string) => {
    if (!conventionalFiles.has(file))
      conventionalFiles.set(file, readFileSync(path.join(ROOT, file), 'utf8'));
    return conventionalFiles.get(file)!;
  };
  const payloadBindings = nativeCargoPayloadBindings(
    catalog,
    consumerProducts,
    conventionalText,
    authoredProducts,
  );
  const bindings = [
    ...new Map(
      compatibilityVersionEntries(authoredProducts, { requireSourceProduct: true })
        .filter((entry) => consumerProducts.includes(entry.product))
        .flatMap((entry) => {
          const text = conventionalText(entry.path);
          const dependency = cargoCompatibilityDependency(entry, text);
          if (dependency?.path !== undefined) return [];
          let requestedCarrier = dependency ? `cargo:${dependency.packageName}` : undefined;
          if (entry.product === 'oliphaunt-wasix-ts') {
            if (entry.sourceProduct === 'liboliphaunt-wasix') {
              const names = authoredProducts[entry.sourceProduct].registry_packages.filter((name) =>
                name.startsWith('npm:'),
              );
              assert.equal(names.length, 1, 'WASIX SDK needs its authored runtime npm identity');
              requestedCarrier = names[0];
            } else if (entry.sourceProduct === 'oliphaunt-wasix-napi') {
              const manifest = JSON.parse(text);
              const hosts = catalog.carriers.filter((carrier) => {
                if (
                  carrier.product !== entry.sourceProduct ||
                  carrier.ecosystem !== 'npm' ||
                  !Object.hasOwn(manifest.optionalDependencies ?? {}, carrier.name)
                )
                  return false;
                const target = consumerHostTarget(carrier.target);
                const platform = target && DESKTOP_TARGETS[target];
                return platform?.npmOs === process.platform && platform?.npmCpu === process.arch;
              });
              assert.equal(hosts.length, 1, 'WASIX SDK needs its declared host NAPI npm identity');
              requestedCarrier = hosts[0].id;
            }
          }
          return [
            {
              consumer: entry.product,
              producer: entry.sourceProduct,
              producerVersion: dependency
                ? cargoDependencyMinimum(compatibilityVersionFromText(entry, text))
                : compatibilityVersionFromText(entry, text),
              ...(requestedCarrier ? { requestedCarrier } : {}),
            },
          ];
        })
        .filter(
          (binding) =>
            !(
              seedConsumer.source === 'current' &&
              binding.consumer === 'database-resources' &&
              binding.producer === 'liboliphaunt-wasix'
            ),
        )
        .filter(
          (binding) =>
            !(
              ['oliphaunt-rust', 'oliphaunt-wasix-rust'].includes(binding.consumer) &&
              binding.producerVersion === '0.0.0' &&
              catalog.products.some((row) => row.id === binding.producer && row.version === '0.0.0')
            ) &&
            (binding.requestedCarrier ||
              !payloadBindings.some(
                (payload) =>
                  payload.consumer === binding.consumer &&
                  payload.producer === binding.producer &&
                  payload.producerVersion === binding.producerVersion,
              )),
        )
        .concat(nativeCargoMinimumBindings(catalog, consumerProducts, conventionalText))
        .concat(payloadBindings)
        .map((binding) => [
          `${binding.consumer}/${binding.producer}@${binding.producerVersion}/${binding.requestedCarrier ?? 'installed'}`,
          binding,
        ]),
    ).values(),
  ];
  const supplierRequests = [
    ...new Map(
      bindings.map((binding) => [
        `${binding.producer}@${binding.producerVersion}`,
        { product: binding.producer, version: binding.producerVersion },
      ]),
    ).values(),
  ];
  const resource = catalog.products.find((product) => product.id === 'database-resources');
  assert.ok(resource, 'native publication inputs need the canonical resource owner');
  const publication = async (product: string, version: string) => {
    assert.ok(
      catalog.products.some((row) => row.id === product),
      'unknown native input supplier owner',
    );
    const tagName = `${product}-v${version}`;
    const release = await read(`repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`);
    return complete({ product, version, tagName, publicationSha: release.target_commitish });
  };
  const supplierPublications: CompletedPublication[] = [];
  const supplierArtifacts: NativeSupplierArtifact[] = [];
  let metadataBaseline: Awaited<ReturnType<typeof readCompletedNativePublicBaseline>> | undefined;
  const supplierMetadata = new Map<
    string,
    Awaited<ReturnType<typeof readCompletedNativePublicBaseline>>
  >();
  let metadataFile: string | undefined;
  for (const request of supplierRequests) {
    supplierPublications.push(await publication(request.product, request.version));
  }
  const owned = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(owned), {
    create: true,
    label: 'native publication inputs',
  });
  assert.ok(!existsSync(owned), 'native publication inputs require a new owned directory');
  mkdirSync(owned);
  const completeSupplier = async (product: string, version: string) => {
    const prior = supplierPublications.find(
      (row) => row.product === product && row.version === version,
    );
    if (prior) return prior;
    const completed = await publication(product, version);
    supplierPublications.push(completed);
    return completed;
  };
  const historicalInputs = new Map<string, Promise<Awaited<ReturnType<typeof inventory>>>>();
  const completedInventory = (completed: CompletedPublication) => {
    const key = `${completed.product}@${completed.version}`;
    let result = historicalInputs.get(key);
    if (!result) {
      result = (async () => {
        const release = await read(
          `repos/${repository}/releases/tags/${encodeURIComponent(completed.tagName)}`,
        );
        const assets = await pages(`repos/${repository}/releases/${release.id}/assets`);
        const acquired = await acquireCompletedNativeMetadataBaseline(
          {
            publication: completed,
            directory: path.join(owned, 'metadata', completed.product, completed.version),
            assets,
            metadataOrigin,
          },
          {
            proveAsset,
            readBaseline,
            baselineTransports: {
              repository,
              assertCompleted: complete,
              readJson: read,
              readPages: pages,
            },
          },
        );
        if (acquired) supplierMetadata.set(key, acquired.baseline);
        if (completed.product === resource.id && acquired) {
          metadataBaseline = acquired.baseline;
          metadataFile = acquired.file;
        }
        return inventory(completed, {
          repository,
          assertCompletedPublication: complete,
          readJson: read,
          ...(acquired ? { metadataBaseline: acquired.baseline } : {}),
        });
      })();
      historicalInputs.set(key, result);
    }
    return result;
  };
  const retainCarrier = async (
    completed: CompletedPublication,
    carrier: {
      id: string;
      product: string;
      ecosystem: string;
      name: string;
      declared?: boolean;
      artifacts?: { path: string; size: number; sha256: string }[];
    },
    payloadClosure = isCargoPayloadCarrier(carrier, authoredProducts),
  ): Promise<NativeSupplierArtifact> => {
    assert.ok(
      ['npm', 'cargo'].includes(carrier.ecosystem),
      'supplier source carrier must be npm or Cargo',
    );
    const prior = supplierArtifacts.find(
      (row) =>
        row.artifact === carrier.id &&
        row.publication.product === completed.product &&
        row.publication.version === completed.version,
    );
    if (prior) return prior;
    const retained = await materialize(
      {
        ...carrier,
        version: completed.version,
        artifacts: carrier.artifacts?.map((artifact) => ({
          ...artifact,
          path: path.basename(artifact.path),
        })) ?? [
          {
            path: `${carrier.name.split('/').at(-1)}-${completed.version}.${carrier.ecosystem === 'cargo' ? 'crate' : 'tgz'}`,
          },
        ],
      },
      {
        directory: path.join(
          owned,
          'suppliers',
          completed.product,
          completed.version,
          `registry-${supplierArtifacts.length}`,
        ),
      },
    );
    assert.equal(
      retained.carrier.artifacts.length,
      1,
      'completed supplier carrier must retain one actual registry archive',
    );
    const records =
      carrier.ecosystem === 'cargo'
        ? discoverPublicationArtifacts([retained.carrier.artifacts[0].path])
        : [];
    if (carrier.ecosystem === 'cargo') {
      assert.ok(
        records.length === 1 &&
          records[0].ecosystem === carrier.ecosystem &&
          records[0].name === carrier.name &&
          records[0].version === completed.version,
        'Completed supplier archive differs from its requested identity',
      );
      assert.equal(
        records[0].artifacts[0].sha256,
        retained.carrier.artifacts[0].sha256,
        'Completed supplier archive SHA differs from retained bytes',
      );
      assert.equal(
        records[0].artifacts[0].size,
        retained.carrier.artifacts[0].size,
        'Completed supplier archive size differs from retained bytes',
      );
    }
    const row = {
      publication: completed,
      artifact: carrier.id,
      file: retained.carrier.artifacts[0],
    };
    supplierArtifacts.push(row);
    if (carrier.ecosystem === 'cargo' && carrier.declared) {
      const historical = await completedInventory(completed);
      const parts = [];
      for (const dependency of records[0].dependencies.filter(
        (dependency) =>
          dependency.ecosystem === 'cargo' && dependency.name.startsWith(`${carrier.name}-part-`),
      )) {
        assert.equal(
          exactCargoPayloadVersion(dependency.requirement),
          completed.version,
          'Completed Cargo part version differs from its parent',
        );
        const frozenPart = historical.carriers.find(
          (part) => part.id === `cargo:${dependency.name}`,
        );
        assert(
          !supplierMetadata.has(`${completed.product}@${completed.version}`) || frozenPart,
          'Completed Cargo part is absent from frozen inventory',
        );
        const part =
          frozenPart ?? resolveActualCarrier(historical.catalog, 'cargo', dependency.name);
        const retainedPart = await retainCarrier(completed, part);
        const partRecords = discoverPublicationArtifacts([retainedPart.file.path]);
        parts.push({ ...part, packageDependencies: partRecords[0].dependencies });
      }
      if (parts.length)
        validateCargoPayloadPartSets([
          { ...carrier, packageDependencies: records[0].dependencies },
          ...parts,
        ]);
      if (payloadClosure)
        for (const dependency of records[0].dependencies) {
          if (
            dependency.ecosystem !== 'cargo' ||
            dependency.name.startsWith(`${carrier.name}-part-`)
          )
            continue;
          const internal = historical.carriers.find(
            (entry) =>
              entry.id === `cargo:${dependency.name}` &&
              entry.product === completed.product &&
              entry.version === completed.version &&
              entry.declared,
          );
          if (!internal) continue;
          assert.equal(
            exactCargoPayloadVersion(dependency.requirement),
            completed.version,
            'Completed internal payload version differs from its publication',
          );
          await retainCarrier(completed, internal, true);
        }
    }
    // Server qualification follows the authentic held SDK's payload pins.
    if (carrier.ecosystem === 'cargo' && ['oliphaunt', 'oliphaunt-wasix'].includes(carrier.name)) {
      const manifest = readPortableArchiveEntries(row.file.path).get(
        `${carrier.name}-${completed.version}/Cargo.toml`,
      );
      assert(manifest?.isFile, 'Completed SDK archive needs its conventional manifest');
      for (const { carrier: payload, version } of cargoPayloadRequests(
        Bun.TOML.parse(manifest.data().toString('utf8')),
        catalog,
        authoredProducts,
      )) {
        const origin = await completeSupplier(payload.product, version);
        const original = (await completedInventory(origin)).carriers.find(
          (entry) => entry.id === payload.id,
        );
        assert(original, 'Requested Cargo payload is absent from its completed inventory');
        await retainCarrier(origin, original);
      }
    }
    return row;
  };
  const retainPublicAssets = async (completed: CompletedPublication, expected) => {
    assert.ok(expected.length, 'completed supplier needs canonical public archive rows');
    const release = await read(
      `repos/${repository}/releases/tags/${encodeURIComponent(completed.tagName)}`,
    );
    const assets = await pages(`repos/${repository}/releases/${release.id}/assets`);
    for (const row of expected) {
      if (
        supplierArtifacts.some(
          (existing) =>
            existing.artifact === row.id &&
            existing.publication.product === completed.product &&
            existing.publication.version === completed.version,
        )
      )
        continue;
      const matches = assets.filter((asset) => asset.name === row.name);
      assert.equal(matches.length, 1, 'completed supplier archive is missing or ambiguous');
      const asset = matches[0];
      assert.ok(
        Number.isSafeInteger(asset.id) &&
          asset.id > 0 &&
          asset.state === 'uploaded' &&
          asset.url === `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` &&
          Number.isSafeInteger(asset.size) &&
          asset.size > 0 &&
          (asset.digest == null || /^sha256:[a-f0-9]{64}$/u.test(asset.digest)) &&
          (row.size === undefined || row.size === asset.size) &&
          (row.sha256 === undefined ||
            asset.digest == null ||
            asset.digest === `sha256:${row.sha256}`),
        'completed supplier asset identity differs',
      );
      const file = path.join(owned, 'suppliers', completed.product, completed.version, row.name);
      const proof = await proveAsset(asset.url, row.name, asset.size, {
        retainedPath: file,
        ...(row.sha256 || asset.digest
          ? { expectedSha256: row.sha256 ?? asset.digest.slice(7) }
          : {}),
      });
      const actual = fileIdentity(file);
      assert.deepEqual(
        { size: actual.size, sha256: actual.sha256 },
        { size: proof.bytes, sha256: proof.sha256 },
        'completed supplier File differs',
      );
      supplierArtifacts.push({
        publication: completed,
        artifact: row.id,
        file: { path: file, size: actual.size, sha256: actual.sha256 },
      });
    }
  };
  const finish = (seedControls: NativeSeedInputControl[], completed?: CompletedPublication) => {
    projectNativeSeedInputs(seedControls, source);
    const snapshot = {
      source: structuredClone(source),
      seedControls,
      supplierPublications,
      ...(supplierArtifacts.length
        ? { supplierArtifacts: validateNativeSupplierArtifacts(supplierArtifacts) }
        : {}),
    };
    const file = path.join(owned, 'native-publication-inputs.json');
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    return {
      file,
      snapshot,
      publication: completed,
      supplierMetadata,
      ...(metadataBaseline ? { metadataBaseline } : {}),
    };
  };
  try {
    // Conventional requests identify retained source carriers; configured File origins decide actual consumption.
    for (const binding of bindings) {
      const completed = await completeSupplier(binding.producer, binding.producerVersion);
      const historical = await completedInventory(completed);
      if (binding.requestedCarrier) {
        const carrier = historical.carriers.find(
          (row) => row.product === binding.producer && row.id === binding.requestedCarrier,
        );
        assert.ok(carrier, 'requested supplier is absent from its completed inventory');
        await retainCarrier(completed, carrier);
        continue;
      }
      for (const ecosystem of ['cargo', 'npm']) {
        const carriers = historical.carriers.filter(
          (carrier) => carrier.product === binding.producer && carrier.ecosystem === ecosystem,
        );
        if (carriers.length !== 1) continue;
        await retainCarrier(completed, carriers[0]);
      }
    }
    const appleConsumers = new Set(
      expectedProductArtifactRows(
        catalog.products.filter((product) => consumerProducts.includes(product.id)),
      )
        .filter((row) => row.target.includes('ios') || row.target.startsWith('apple-'))
        .map((row) => row.product),
    );
    for (const binding of bindings.filter(
      (binding) =>
        !binding.requestedCarrier &&
        binding.producer === 'liboliphaunt-native' &&
        appleConsumers.has(binding.consumer),
    )) {
      const completed = await completeSupplier(binding.producer, binding.producerVersion);
      const rows = (await completedInventory(completed)).publicRows.filter(
        (row) =>
          row.kind === 'apple-swiftpm-binary' ||
          (row.kind === 'runtime-resources' && row.target === 'ios-datum64'),
      );
      assert.equal(rows.length, 2);
      await retainPublicAssets(completed, rows);
    }
    for (const binding of bindings.filter(
      (binding) =>
        !binding.requestedCarrier &&
        binding.consumer === 'database-resources' &&
        binding.producer === 'liboliphaunt-wasix',
    )) {
      const completed = await completeSupplier(binding.producer, binding.producerVersion);
      const rows = (await completedInventory(completed)).publicRows.filter(
        (row) => row.kind === 'wasix-runtime' && row.target === 'portable',
      );
      assert.equal(rows.length, 1, 'WASIX seed consumer needs one canonical portable archive');
      await retainPublicAssets(completed, rows);
    }
    for (const binding of bindings.filter(
      (binding) => !binding.requestedCarrier && binding.producer === 'oliphaunt-broker',
    )) {
      const completed = await completeSupplier(binding.producer, binding.producerVersion);
      const rows = (await completedInventory(completed)).publicRows.filter(
        (row) => row.kind === 'broker-helper',
      );
      await retainPublicAssets(completed, rows);
    }
    for (const request of [
      ...new Map(
        bindings
          .filter((binding) => !binding.requestedCarrier && binding.producer === 'oliphaunt-swift')
          .map((binding) => [binding.producerVersion, binding]),
      ).values(),
    ]) {
      const completed = await completeSupplier(request.producer, request.producerVersion);
      const historical = await completedInventory(completed);
      const rows = historical.publicRows.filter((row) => row.kind === 'swift-bindings');
      assert.equal(
        rows.length,
        1,
        'completed Swift source needs its actual owned bindings archive',
      );
      await retainPublicAssets(completed, rows);
      const bindings = supplierArtifacts.find(
        (row) =>
          row.publication.product === completed.product &&
          row.publication.version === completed.version &&
          row.artifact === rows[0].id,
      )!;
      const retained = await captureSwiftSource(
        {
          publication: completed,
          descriptor: historical.descriptor,
          bindings: { name: rows[0].name, sha256: bindings.file.sha256 },
          retainedArchive: path.join(
            owned,
            'suppliers',
            completed.product,
            completed.version,
            `swift-source-tag-${completed.version}.tar.gz`,
          ),
        },
        { assertCompletedPublication: complete, readJson: read, readPages: pages },
      );
      assert.ok(
        retained.file,
        'completed Swift source must retain its authenticated Git delivery bytes',
      );
      supplierArtifacts.push({
        publication: completed,
        artifact: `swift-source-tag:${completed.version}`,
        source: retained.source,
        file: retained.file,
      });
    }
    if (consumerProducts.includes('oliphaunt-wasix-ts')) {
      const facade = catalog.products.find((product) => product.id === 'oliphaunt-wasix-ts')!;
      const facadePublication = await completeSupplier(facade.id, facade.version);
      const historicalFacade = await completedInventory(facadePublication);
      const carriers = historicalFacade.carriers.filter(
        (carrier) => carrier.product === facade.id && carrier.ecosystem === 'npm',
      );
      assert.equal(carriers.length, 1);
      const retained = await retainCarrier(facadePublication, carriers[0]);
      const entries = readPortableArchiveEntries(retained.file.path);
      const manifest = entries.get('package/package.json');
      assert.ok(manifest?.isFile, 'completed WASIX facade needs its actual packed package.json');
      const declared = JSON.parse(manifest.data().toString('utf8'));
      assert.equal(declared.name, carriers[0].name);
      assert.equal(declared.version, facade.version);
      const hosts: { publication: CompletedPublication; carrier: any }[] = [];
      for (const version of new Set(Object.values(declared.optionalDependencies ?? {}))) {
        assert.match(
          version as string,
          /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u,
          'completed WASIX facade must pin its actual host NAPI version',
        );
        const hostPublication = await completeSupplier('oliphaunt-wasix-napi', version as string);
        const historicalHost = await completedInventory(hostPublication);
        for (const carrier of historicalHost.carriers.filter(
          (row) => row.ecosystem === 'npm' && declared.optionalDependencies[row.name] === version,
        )) {
          const target = consumerHostTarget(carrier.target);
          const platform = target && DESKTOP_TARGETS[target];
          if (platform?.npmOs === process.platform && platform?.npmCpu === process.arch)
            hosts.push({ publication: hostPublication, carrier });
        }
      }
      assert.equal(hosts.length, 1, 'WASIX facade acquisition needs one exact historical host');
      await retainCarrier(hosts[0].publication, hosts[0].carrier);
    }
    if (!consumerProducts.includes(resource.id)) return finish([]);
    const completed = await publication(resource.id, resource.version);
    const release = await read(
      `repos/${repository}/releases/tags/${encodeURIComponent(completed.tagName)}`,
    );
    const assets = await pages(`repos/${repository}/releases/${release.id}/assets`);
    const historical = await completedInventory(completed);
    const rows = historical.publicRows;
    const seedRows = rows.filter((row) => ['native-seeds', 'wasix-seeds'].includes(row.kind));
    const files = new Map<string, { path: string; size: number; sha256: string }>();
    const retain = async (name: string) => {
      const prior = files.get(name);
      if (prior) return prior;
      const matches = assets.filter((asset) => asset.name === name);
      assert.equal(matches.length, 1, 'native seed completed asset is missing or ambiguous');
      const asset = matches[0];
      const row = seedRows.find((row) => row.name === name)!;
      assert.ok(
        Number.isSafeInteger(asset.id) &&
          asset.id > 0 &&
          asset.state === 'uploaded' &&
          asset.url === `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` &&
          Number.isSafeInteger(asset.size) &&
          asset.size > 0 &&
          (asset.digest == null || /^sha256:[a-f0-9]{64}$/u.test(asset.digest)) &&
          (row.size === undefined || row.size === asset.size) &&
          (row.sha256 === undefined ||
            asset.digest == null ||
            asset.digest === `sha256:${row.sha256}`),
        'native seed completed asset identity differs',
      );
      const retainedPath = path.join(owned, 'files', name);
      const proof = await proveAsset(asset.url, name, asset.size, {
        retainedPath,
        ...(row.sha256 || asset.digest
          ? { expectedSha256: row.sha256 ?? asset.digest.slice(7) }
          : {}),
      });
      const file = { path: retainedPath, size: proof.bytes, sha256: proof.sha256 };
      const retained = fileIdentity(retainedPath);
      assert.deepEqual(
        { size: retained.size, sha256: retained.sha256 },
        { size: file.size, sha256: file.sha256 },
        'retained seed File differs from public proof',
      );
      files.set(name, file);
      return file;
    };
    const capturedMetadata = metadataFile ? fileIdentity(metadataFile) : undefined;
    const metadata = capturedMetadata
      ? { path: metadataFile!, size: capturedMetadata.size, sha256: capturedMetadata.sha256 }
      : undefined;
    let anchor: { path: string; size: number; sha256: string } | undefined;
    if (!metadata) {
      const declaration = readSeedAnchor(source);
      if (declaration) {
        assert.deepEqual(
          declaration.anchor.publication,
          completed,
          'seed adoption contract differs from the genuine completed origin',
        );
        const anchorPath = path.join(owned, 'construction-anchor.json');
        copyFileSync(declaration.file.path, anchorPath);
        const captured = fileIdentity(anchorPath);
        assert.deepEqual(
          { size: captured.size, sha256: captured.sha256 },
          { size: declaration.file.size, sha256: declaration.file.sha256 },
          'seed adoption contract changed during input acquisition',
        );
        anchor = { path: anchorPath, size: captured.size, sha256: captured.sha256 };
      }
    }
    const seedControls: NativeSeedInputControl[] = [];
    for (const row of seedRows.filter((row) => row.name.endsWith('.json'))) {
      const manifest = await retain(row.name);
      const descriptor = JSON.parse(readFileSync(manifest.path, 'utf8'));
      const family = row.kind === 'native-seeds' ? ('native' as const) : ('wasix' as const);
      const profile = descriptor.catalogProfile;
      assert.ok(
        ['standard', 'icu'].includes(profile) &&
          descriptor.runtime?.engineFamily === family &&
          descriptor.runtime?.target === row.target,
        'native seed completed descriptor slot differs',
      );
      const archiveRow = seedRows.find(
        (candidate) =>
          candidate.name === descriptor.archive?.path &&
          candidate.target === row.target &&
          candidate.kind === row.kind,
      );
      assert.ok(
        archiveRow?.name.endsWith('.tar.zst'),
        'native seed completed descriptor has no canonical archive',
      );
      const archive = await retain(archiveRow.name);
      const reuse = {
        operation: metadata || anchor ? ('reuse' as const) : ('adopt' as const),
        publication: completed,
        archive,
        manifest,
        ...(metadata ? { metadata } : {}),
        ...(anchor ? { anchor } : {}),
      };
      // This temporary value supplies only the slot required by the existing
      // byte/descriptor validator. It is neither retained nor a recipe claim.
      selectCompletedSeed(
        { family, target: row.target, profile, invocation: {}, inputs: [] },
        { ...reuse, operation: 'adopt' },
      );
      seedControls.push({ family, target: row.target, profile, reuse });
    }
    return finish(seedControls, completed);
  } catch (error) {
    rmSync(owned, { recursive: true, force: true });
    throw error;
  }
}

/** The one migration proposal uses real immutable CI receipts and genuine public PGDATA. */
export async function acquireNativeSeedConstructionAnchor({
  source,
  runId,
  ref,
  directory,
}: {
  source: NativeBuildSource;
  runId: number;
  ref: string;
  directory: string;
}) {
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'seed adoption proposal',
  });
  assert.ok(!existsSync(destination), 'seed adoption proposal needs a new owned directory');
  mkdirSync(destination);
  try {
    const inputs = await acquireNativePublicationInputs({
      source,
      directory: path.join(destination, 'completed'),
      consumerProducts: ['database-resources'],
    });
    const { origins } = await acquireNativePublicationBuilds({
      source,
      runId,
      ref,
      directory: path.join(destination, 'producers'),
    });
    const anchor = proposeSeedConstructionAnchor({
      source,
      origins,
      seedControls: inputs.snapshot.seedControls,
    });
    const file = path.join(destination, 'construction-anchor.json');
    writeSeedConstructionAnchorProposal(file, anchor);
    return file;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Acquire configured construction once through the same finite producer roles.
 * Coverage/admission belong to the observing caller, never this transport.
 */
export async function acquireNativePublicationBuilds(
  {
    source,
    runId,
    directory,
    ref = 'refs/heads/main',
    excludeArtifactNames = [],
    requestedArtifactNames,
  }: {
    source: NativeBuildSource;
    runId: number;
    directory: string;
    ref?: string;
    excludeArtifactNames?: string[];
    requestedArtifactNames?: string[];
  },
  {
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    acquire = acquireAuthenticatedNativeBuildEvidence,
  } = {},
) {
  assert.ok(Number.isSafeInteger(runId) && runId > 0, 'native construction requires an exact run');
  const repository = 'f0rr0/oliphaunt';
  const run = await readJson(`repos/${repository}/actions/runs/${runId}`);
  const contextMatches =
    matchesGithubWorkflowRef(run.event, ref, {
      headBranch: run.head_branch,
      pullRequestNumbers: run.pull_requests?.map((request) => request.number),
    }) &&
    (run.event !== 'push' || run.head_branch === 'main');
  assert.ok(
    run.id === runId &&
      run.head_sha === source.commit &&
      contextMatches &&
      run.path === '.github/workflows/bazel.yml' &&
      run.name === 'Native Bazel qualification' &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'native construction requires exact eligible qualification',
  );
  const allRoles = reviewedNativeProducerArtifacts();
  assert.ok(
    excludeArtifactNames.every((name) =>
      allRoles.some(({ artifactName }) => artifactName === name),
    ) && new Set(excludeArtifactNames).size === excludeArtifactNames.length,
    'native construction exclusions must be finite producer roles',
  );
  assert.ok(
    requestedArtifactNames === undefined ||
      (requestedArtifactNames.length > 0 &&
        new Set(requestedArtifactNames).size === requestedArtifactNames.length &&
        requestedArtifactNames.every(
          (name) =>
            allRoles.some(({ artifactName }) => artifactName === name) &&
            !excludeArtifactNames.includes(name),
        )),
    'native construction requests must use finite producer roles',
  );
  const artifacts = await readPages(`repos/${repository}/actions/runs/${runId}/artifacts`);
  const roles = allRoles.filter(
    ({ artifactName }) =>
      !excludeArtifactNames.includes(artifactName) &&
      (requestedArtifactNames === undefined || requestedArtifactNames.includes(artifactName)) &&
      artifacts.some((artifact) => artifact.name === artifactName && artifact.expired === false),
  );
  assert.ok(roles.length, 'native construction has no retained source producer artifacts');
  if (requestedArtifactNames)
    assert.deepEqual(
      roles.map(({ artifactName }) => artifactName).sort(),
      [...requestedArtifactNames].sort(),
      'requested native constructor producer is not completed and retained',
    );
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native construction acquisition',
  });
  assert.ok(!existsSync(destination), 'native construction requires a new owned directory');
  mkdirSync(destination);
  const origins = new Map<string, Awaited<ReturnType<typeof acquire>>>();
  const builds: NativePublicationBuild[] = [];
  const session =
    acquire === acquireAuthenticatedNativeBuildEvidence
      ? createNativeBuildEvidenceAcquirer()
      : undefined;
  try {
    for (const [index, { job, artifactName }] of roles.entries()) {
      const expected = {
        source,
        github: {
          repository,
          workflow: 'Native Bazel qualification',
          workflowPath: '.github/workflows/bazel.yml',
          runId,
          runAttempt: run.run_attempt,
          job,
        },
        event: run.event as NativePublicationBuild['expected']['event'],
        ref,
        artifactName,
      };
      const evidenceRoot = path.join(destination, String(index));
      const origin = await (session?.acquire ?? acquire)(evidenceRoot, expected);
      assert.ok(origin.finalFiles, `native producer ${artifactName} has no physical transport`);
      origins.set(evidenceRoot, origin);
      builds.push({
        evidenceRoot,
        expected,
        requiredTests: (origin.finalFiles.qualification?.requiredTests ?? []).map(
          ({ label, configuration }) => ({
            label,
            configuration,
          }),
        ),
      });
    }
    return { run, origins, builds };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    session?.dispose();
  }
}

/** Assemble inputs for the once-only source-owned family checksum producer.
 * The workflow may still be running; the existing downloader authenticates
 * each finite, already successful producer job before retaining any File.
 */
export async function acquireNativeReleaseArchives(
  {
    source,
    runId,
    directory,
    ref = 'refs/heads/main',
    publicationInputs,
    consumerProducts,
  }: {
    source: NativeBuildSource;
    runId: number;
    directory: string;
    ref?: string;
    publicationInputs?: string;
    consumerProducts?: string[];
  },
  {
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    acquire = acquireAuthenticatedNativeBuildEvidence,
  } = {},
) {
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native archive assembly',
  });
  assert.ok(!existsSync(destination), 'native archive assembly requires a new owned directory');
  const inputs = `${destination}.producers`;
  assert.ok(!existsSync(inputs), 'native archive assembly requires new owned producer captures');
  try {
    const construction = await acquireNativePublicationBuilds(
      {
        source,
        runId,
        directory: inputs,
        ref,
        excludeArtifactNames: [
          'native-build-evidence-release-families',
          'native-build-evidence-react-native-macos-arm64',
        ],
        ...(consumerProducts === undefined
          ? {}
          : {
              requestedArtifactNames: nativeConstructorProducerArtifacts(consumerProducts),
            }),
      },
      { readJson, readPages, acquire },
    );
    const { origins } = construction;
    const families = stageNativeReleaseArchives(origins, source, destination);
    assert.ok(families.length, 'native archive assembly has no canonical public assets');
    const snapshot =
      publicationInputs === undefined
        ? undefined
        : writeNativeConstructionInputSnapshot({
            source,
            file: publicationInputs,
            directory: `${destination}.inputs`,
            finalInputs: nativeArchiveConstructionFinalInputs(construction, source),
          });
    return {
      ...construction,
      directory: destination,
      families,
      ...(snapshot ? { publicationInputs: snapshot } : {}),
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    rmSync(inputs, { recursive: true, force: true });
    rmSync(`${destination}.inputs`, { recursive: true, force: true });
    throw error;
  }
}

/** Existing Apple producer composition owns the tuple used by the RN factory.
 * This narrows construction acquisition, never release necessity or admission. */
export function nativeConstructorProducerArtifacts(consumerProducts: string[]) {
  assert.deepEqual(
    consumerProducts,
    ['oliphaunt-react-native'],
    'native constructor bootstrap requires the canonical RN consumer',
  );
  const roles = reviewedNativeProducerArtifacts().filter(
    ({ artifactName }) => artifactName === 'native-build-evidence-mobile-ios',
  );
  assert.equal(roles.length, 1, 'source-owned Apple constructor role is absent');
  return roles.map(({ artifactName }) => artifactName);
}

/** Reuse the actual acquired cohort; construction does not assert reviewed-main discipline. */
export function nativeArchiveConstructionFinalInputs(
  construction: Awaited<ReturnType<typeof acquireNativePublicationBuilds>>,
  source: NativeBuildSource,
  metadata: ReleaseMetadata = loadReleaseMetadata(ROOT),
) {
  assert.equal(
    construction.builds.length,
    construction.origins.size,
    'native construction producer plan differs',
  );
  const seen = new Set<string>();
  const bazelVersion = readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim();
  const authenticated = construction.builds.map((build) => {
    assert.ok(!seen.has(build.evidenceRoot), 'native construction producer repeats');
    seen.add(build.evidenceRoot);
    const origin = assertAuthenticatedNativeBuildOrigin(
      construction.origins.get(build.evidenceRoot),
    );
    assert.deepEqual(build.expected.source, source, 'native constructor input source differs');
    assert.deepEqual(
      origin.github,
      build.expected.github,
      'native constructor producer context differs',
    );
    assert.equal(
      origin.artifact.name,
      build.expected.artifactName,
      'native constructor artifact role differs',
    );
    const qualification = origin.finalFiles?.qualification;
    assert.ok(qualification, 'native constructor requires acquired physical qualification');
    const producingBazelVersion = origin.evidence.cohorts[0].buildEvents.find(
      (event) => event.started !== undefined,
    )?.started?.buildToolVersion;
    assert.equal(producingBazelVersion, bazelVersion, 'native constructor Bazel pin differs');
    assert.deepEqual(
      qualification.source,
      source,
      'native constructor qualification source differs',
    );
    assert.deepEqual(qualification.github, build.expected.github);
    assert.equal(qualification.testQualification, 'passed');
    assert.equal(qualification.shippingAnalysis, 'bound');
    assert.equal(qualification.qualificationPolicy, 'bound');
    assert.ok(
      qualification.requiredTests.length,
      'native constructor imports need mandatory configured tests',
    );
    return { origin, evidence: origin.evidence, qualification };
  });
  return constructionNativeFinalInputs(
    { observation: { authenticated }, origins: construction.origins },
    metadata,
  );
}

/** Replace constructor facts with this source's actual fresh envelopes.
 * Source/selection/public completion facts are preserved; this JSON grants no admission. */
export function writeNativeConstructionInputSnapshot(
  {
    source,
    file,
    directory,
    finalInputs,
  }: {
    source: NativeBuildSource;
    file: string;
    directory: string;
    finalInputs: ReturnType<typeof constructionNativeFinalInputs>;
  },
  metadata: ReleaseMetadata = loadReleaseMetadata(ROOT),
) {
  const before = fileIdentity(file);
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(snapshot.source, source, 'native construction snapshot source differs');
  // Validate the inherited input facts before replacing only source-constructor tuples.
  nativePublicationInputProjection(snapshot, metadata);
  const next = { ...snapshot };
  delete next.extensionFinalInputs;
  delete next.nativeAppleBase;
  delete next.nativeSwiftSource;
  delete next.nativeCurrentArtifacts;
  Object.assign(next, finalInputs);
  nativePublicationInputProjection(next, metadata);
  assert.deepEqual(fileIdentity(file), before, 'native construction input snapshot changed');
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native constructor inputs',
  });
  assert.ok(!existsSync(destination), 'native constructor snapshot needs a new owned directory');
  mkdirSync(destination);
  try {
    const output = path.join(destination, 'native-publication-inputs.json');
    writeFileSync(output, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o444 });
    return output;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Stage the complete canonical construction inventory from its original producer Files.
 * This creates no release selection, reviewed-main assurance, or publication admission. */
export function stageNativePublicationConstruction({
  source,
  runId,
  origins,
  builds,
  directory,
}: {
  source: NativeBuildSource;
  runId: number;
  origins: Awaited<ReturnType<typeof acquireNativePublicationBuilds>>['origins'];
  builds: NativePublicationBuild[];
  directory?: string;
}) {
  assert.equal(origins.size, builds.length, 'native construction producer inventory differs');
  assert.ok(builds.length, 'native construction requires original producing builds');
  const catalog = loadPublicationCatalog('native release construction');
  const bazelVersion = readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim();
  const familyParent = requireSafeDirectoryChain(path.join(ROOT, 'target/native-release-family'), {
    create: true,
    label: 'native release families',
  });
  const familyCapture =
    directory === undefined
      ? mkdtempSync(path.join(familyParent, `${runId}-`))
      : path.resolve(directory);
  if (directory !== undefined) {
    const relative = path.relative(ROOT, familyCapture);
    assert.ok(
      relative.startsWith(`target${path.sep}`) && !relative.split(path.sep).includes('..'),
      'native construction staging must remain under target/',
    );
    requireSafeDirectoryChain(path.dirname(familyCapture), {
      create: true,
      label: 'native construction staging',
    });
    assert.ok(
      !existsSync(familyCapture),
      'native construction staging requires a new owned directory',
    );
    mkdirSync(familyCapture);
  }
  try {
    const artifactRoots: string[] = [];
    for (const [index, { evidenceRoot, expected }] of builds.entries()) {
      const origin = origins.get(evidenceRoot);
      assert.ok(origin);
      const qualification = validateNativeBuildEvidence(origin.evidence, {
        source,
        github: expected.github,
        bazelVersion,
        requireShippingAnalysis: true,
      });
      assert.equal(
        qualification.qualificationPolicy,
        'bound',
        `native producer ${expected.artifactName} has incomplete source-owned qualification`,
      );
      assertNativeSwiftShippingPhase(qualification, 'pre-version');
      assert.ok(
        origin.finalFiles && 'stage' in origin.finalFiles,
        `native producer ${expected.artifactName} has no physical transport`,
      );
      artifactRoots.push(
        ...origin.finalFiles.stage({
          excludeRoles: ['github-release-asset', 'github-release-metadata'],
          artifactPhase: 'pre-version',
          stageDirectory: path
            .relative(ROOT, path.join(familyCapture, 'registry', String(index)))
            .split(path.sep)
            .join('/'),
        }),
      );
    }
    const products = catalog.products.map(({ id }) => id);
    const publicFamilies = stageNativeReleaseFamilies(
      origins,
      source,
      path.join(familyCapture, 'products'),
    );
    // The conventional envelope reader enforces actual complete carrier/artifact inventory.
    const candidate = {
      ...buildPublicationCandidate({
        products,
        artifactRoots: [...artifactRoots, ...publicFamilies],
        headRef: source.commit,
        artifactPhase: 'pre-version',
      }),
      scope: 'construction' as const,
    };
    return { candidate, products, bazelVersion };
  } catch (error) {
    removeOwnedDirectory(familyCapture);
    throw error;
  }
}

/** Acquire the historical contract once; current names and payload-part counts are separate facts. */
export async function acquireCompletedNativeDeliveryBaseline(
  {
    publication,
    directory,
    metadataBaseline,
  }: {
    publication: CompletedPublication;
    directory: string;
    metadataBaseline?: CompletedDeliveryBaseline['metadataBaseline'];
  },
  {
    inventory = readCompletedNativeDeliveryInventory,
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    assertCompleted = createCompletedPublicationChecker({ repository: 'f0rr0/oliphaunt' }),
    materialize = materializeRegistryCarrierIntegrity,
    proveAsset = requestReleaseAssetProof,
  } = {},
) {
  const historical = await inventory(publication, {
    repository: 'f0rr0/oliphaunt',
    assertCompletedPublication: assertCompleted,
    readJson,
    metadataBaseline,
  });
  const carriers: Record<string, string[]> = {};
  const retained = [];
  const published = [];
  const pending = [...(historical.carriers ?? historical.catalog.carriers)];
  for (const [index, carrier] of pending.entries()) {
    assert.ok(!Object.hasOwn(carriers, carrier.id), 'historical carrier is duplicated');
    const artifacts =
      carrier.artifacts?.map(({ path: file, size, sha256 }) => ({
        path: path.basename(file),
        size,
        sha256,
      })) ??
      (carrier.ecosystem === 'maven'
        ? []
        : [
            {
              path:
                carrier.ecosystem === 'cargo'
                  ? `${carrier.name}-${publication.version}.crate`
                  : `${carrier.name.split('/').at(-1)}-${publication.version}.tgz`,
            },
          ]);
    const acquired = await materialize(
      { ...carrier, artifacts },
      { directory: path.join(directory, `registry-${index}`) },
    );
    const files = acquired.carrier.artifacts.map(({ path: file }) => file);
    carriers[carrier.id] = files;
    retained.push(acquired);
    const records = discoverPublicationArtifacts(files);
    assert.ok(
      records.length === 1 &&
        records[0].ecosystem === carrier.ecosystem &&
        records[0].name === carrier.name &&
        records[0].version === publication.version,
      'historical registry archive differs from its declared identity',
    );
    published.push({ ...carrier, packageDependencies: records[0].dependencies });
    if (carrier.ecosystem === 'cargo' && carrier.declared)
      for (const dependency of records[0].dependencies.filter(
        (row) => row.ecosystem === 'cargo' && row.name.startsWith(`${carrier.name}-part-`),
      )) {
        const frozenPart =
          metadataBaseline &&
          historical.carriers.find((row) => row.id === `cargo:${dependency.name}`);
        assert.ok(
          !metadataBaseline || frozenPart,
          'completed Cargo part is absent from frozen inventory',
        );
        const part =
          frozenPart ?? resolveActualCarrier(historical.catalog, 'cargo', dependency.name);
        if (!pending.some((row) => row.id === part.id)) pending.push(part);
      }
  }
  validateCargoPayloadPartSets(published);
  const release = await readJson(
    `repos/f0rr0/oliphaunt/releases/tags/${encodeURIComponent(publication.tagName)}`,
  );
  const assets = await readPages(`repos/f0rr0/oliphaunt/releases/${release.id}/assets`);
  const productArtifacts: Record<string, string> = {};
  for (const row of historical.publicRows) {
    const matches = assets.filter((asset) => asset.name === row.name);
    assert.equal(
      matches.length,
      1,
      `completed native artifact ${row.name} is missing or ambiguous`,
    );
    const asset = matches[0];
    if (row.size !== undefined)
      assert.equal(asset.size, row.size, 'completed asset differs from its frozen size');
    if (row.sha256 && typeof asset.digest === 'string')
      assert.equal(
        asset.digest,
        `sha256:${row.sha256}`,
        'completed asset differs from its frozen digest',
      );
    const retainedPath = path.join(directory, 'public', row.name);
    await proveAsset(asset.url, row.name, asset.size, {
      retainedPath,
      ...(row.sha256 || typeof asset.digest === 'string'
        ? { expectedSha256: row.sha256 ?? asset.digest.replace(/^sha256:/u, '') }
        : {}),
    });
    productArtifacts[row.id] = retainedPath;
  }
  return {
    baseline: {
      publication,
      carriers,
      productArtifacts,
      ...(metadataBaseline ? { metadataBaseline } : {}),
    },
    historical,
    retained,
    assets,
  };
}

/** A declared initial version and complete public tag inventory distinguish first publication from lost history. */
export async function assertNeverPublishedNativeProducts(
  products: { id: string; version: string }[],
  { readPages = requestGithubPages } = {},
) {
  if (!products.length) return;
  assert.ok(
    new Set(products.map(({ id }) => id)).size === products.length &&
      products.every(({ id, version }) => /^[a-z][a-z0-9-]*$/u.test(id) && version === '0.0.0'),
    'first publication requires unique canonical initial products',
  );
  const [tags, releases] = await Promise.all([
    readPages('repos/f0rr0/oliphaunt/tags'),
    readPages('repos/f0rr0/oliphaunt/releases'),
  ]);
  assert.ok(
    Array.isArray(tags) &&
      tags.every((tag) => typeof tag.name === 'string' && tag.name) &&
      Array.isArray(releases) &&
      releases.every((release) => typeof release.tag_name === 'string' && release.tag_name),
    'first publication has no complete public version inventory',
  );
  for (const product of products)
    assert.ok(
      !tags.some((tag) => tag.name.startsWith(`${product.id}-v`)) &&
        !releases.some((release) => release.tag_name.startsWith(`${product.id}-v`)),
      `initial product ${product.id} already has published version history`,
    );
}

export async function prepareNativeReleaseDelivery(
  {
    source,
    runId,
    completedVersions,
    directory,
  }: {
    source: NativeBuildSource;
    runId: number;
    completedVersions: Record<string, string>;
    directory: string;
  },
  {
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    acquire = acquireAuthenticatedNativeBuildEvidence,
    materialize = materializeRegistryCarrierIntegrity,
    proveAsset = requestReleaseAssetProof,
  } = {},
) {
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0,
    'native preparation requires an exact qualification run',
  );
  const repository = 'f0rr0/oliphaunt';
  const reads = new Map<string, Promise<any>>();
  const pageReads = new Map<string, Promise<any[]>>();
  const read = (endpoint: string) => {
    if (!reads.has(endpoint)) reads.set(endpoint, Promise.resolve(readJson(endpoint)));
    return reads.get(endpoint)!;
  };
  const pages = (endpoint: string) => {
    if (!pageReads.has(endpoint)) pageReads.set(endpoint, Promise.resolve(readPages(endpoint)));
    return pageReads.get(endpoint)!;
  };
  const run = await read(`repos/${repository}/actions/runs/${runId}`);
  assert.ok(
    run.id === runId &&
      run.head_sha === source.commit &&
      run.head_branch === 'main' &&
      run.path === '.github/workflows/bazel.yml' &&
      run.name === 'Native Bazel qualification' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'native preparation requires successful exact reviewed-main qualification',
  );
  const retained = await pages(`repos/${repository}/actions/runs/${runId}/artifacts`);
  assert.ok(
    reviewedNativeProducerArtifacts().some(({ artifactName }) =>
      retained.some((artifact) => artifact.name === artifactName && artifact.expired === false),
    ),
    'native preparation has no retained reviewed producer artifacts',
  );
  const catalog = loadPublicationCatalog('native release preparation');
  for (const product of catalog.products)
    assert.equal(
      completedVersions[product.id],
      product.version,
      `native pre-version ${product.id} must retain its completed conventional version`,
    );
  mkdirSync(directory, { recursive: true });
  const bazelVersion = readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim();
  const { origins, builds } = await acquireNativePublicationBuilds(
    { source, runId, directory: path.join(directory, 'producers') },
    { readJson: read, readPages: pages, acquire },
  );
  const { candidate, products } = stageNativePublicationConstruction({
    source,
    runId,
    origins,
    builds,
  });
  const authenticate = async (
    evidenceRoot: string,
    expected: NativePublicationBuild['expected'],
  ) => {
    const origin = origins.get(evidenceRoot);
    const build = builds.find((build) => build.evidenceRoot === evidenceRoot);
    assert.ok(origin && build, 'native preparation cannot import an unacquired producer');
    assert.deepEqual(
      expected,
      build.expected,
      'native preparation cached producer constraints differ',
    );
    origin.finalFiles?.assertUnchanged?.();
    return origin;
  };
  const observation = await observeNativePublicationConstruction(
    {
      envelope: candidate,
      files: lockedPublicationFiles(candidate),
      repository,
      bazelVersion,
      builds,
      reviewedSource: source,
    },
    { authenticate },
  );
  const assertCompleted = createCompletedPublicationChecker({
    repository,
    readJson: read,
    readPages: pages,
  });
  const baselines: CompletedDeliveryBaseline[] = [];
  const registryReceipts = new Map();
  const retainedRegistry = new Map<
    string,
    Awaited<ReturnType<typeof materializeRegistryCarrierIntegrity>>
  >();
  const publicProofs = new Map<string, { sha256: string; bytes: number }>();
  const retainedPublic = new Map<
    string,
    { path: string; name: string; size: number; sha256: string }
  >();
  const retainPublic: typeof requestReleaseAssetProof = async (url, name, size, options = {}) => {
    const prior = retainedPublic.get(url);
    if (prior) {
      assert.equal(prior.name, name);
      assert.equal(prior.size, size);
      const actual = fileIdentity(prior.path);
      assert.deepEqual(
        { size: actual.size, sha256: actual.sha256 },
        { size: prior.size, sha256: prior.sha256 },
        'cached completed public File changed',
      );
      if (options.expectedSha256) assert.equal(options.expectedSha256, prior.sha256);
      if (options.retainedPath && path.resolve(options.retainedPath) !== path.resolve(prior.path)) {
        requireSafeDirectoryChain(path.dirname(options.retainedPath), {
          create: true,
          label: 'retained public input',
        });
        assert.ok(
          !existsSync(options.retainedPath),
          'retained public input destination already exists',
        );
        copyFileSync(prior.path, options.retainedPath);
      }
      return {
        bytes: prior.size,
        sha256: prior.sha256,
        ...(options.retainedPath ? { path: options.retainedPath } : {}),
      };
    }
    const proof = await proveAsset(url, name, size, options);
    if (options.retainedPath)
      retainedPublic.set(url, {
        path: options.retainedPath,
        name,
        size: proof.bytes,
        sha256: proof.sha256,
      });
    publicProofs.set(url, { bytes: proof.bytes, sha256: proof.sha256 });
    return proof;
  };
  let signedSeedBaseline: NativeSeedConstructionBaseline | undefined;
  const shippingBaselines: Record<
    string,
    ReturnType<typeof assertAuthenticatedNativePublicBaseline>['metadata']
  > = {};
  const unreleased = candidate.products.filter(({ version }) => version === '0.0.0');
  await assertNeverPublishedNativeProducts(unreleased, { readPages: pages });
  for (const product of candidate.products) {
    if (product.version === '0.0.0') continue;
    const tagName = `${product.id}-v${completedVersions[product.id]}`;
    const release = await read(`repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`);
    const publication = await assertCompleted({
      product: product.id,
      version: completedVersions[product.id],
      tagName,
      publicationSha: release.target_commitish,
    });
    const assets = await pages(`repos/${repository}/releases/${release.id}/assets`);
    const metadataBaseline = (
      await acquireCompletedNativeMetadataBaseline(
        { publication, directory: path.join(directory, 'completed', product.id, 'public'), assets },
        { proveAsset: retainPublic },
      )
    )?.baseline;
    const historical = await acquireCompletedNativeDeliveryBaseline(
      { publication, directory: path.join(directory, 'completed', product.id), metadataBaseline },
      { readJson: read, readPages: pages, assertCompleted, materialize, proveAsset: retainPublic },
    );
    for (const retained of historical.retained) {
      registryReceipts.set(retained.carrier.id, retained.receipt);
      retainedRegistry.set(
        `${publication.product}@${publication.version}/${retained.carrier.id}`,
        retained,
      );
    }
    baselines.push(historical.baseline);
    if (metadataBaseline) {
      // Authentication preserves historical facts. A construction diagnostic
      // cannot prove an unchanged qualified footprint or authorize held CI.
      if (
        metadataBaseline.metadata.publicationQualification &&
        metadataBaseline.metadata.construction.every(
          (view) =>
            view.shippingAnalysis === 'bound' &&
            metadataBaseline.metadata.builds.some(
              (build) => build.evidenceDigest === view.evidenceDigest && build.producerAssurance,
            ) &&
            nativeShippingRootsHaveQualification(view.qualificationPolicy, view.roots),
        )
      )
        shippingBaselines[product.id] = metadataBaseline.metadata;
      if (product.id === 'database-resources')
        signedSeedBaseline = {
          metadata: metadataBaseline,
          files: historical.baseline.productArtifacts,
        };
    }
  }
  const completed = await compareNativeCompletedPhysicalDelivery(candidate, baselines, {
    repository,
    assertCompletedPublication: assertCompleted,
    readJson: read,
    readPages: pages,
    proveAsset: async (url, name, size) => {
      const proof = publicProofs.get(url);
      assert.ok(
        proof && proof.bytes === size,
        `native comparison cannot acquire an unretained public asset ${name}`,
      );
      return proof;
    },
    registryOptions: { cachedReceipts: registryReceipts },
    unreleasedProducts: unreleased.map(({ id }) => id),
  });
  const seedConstructionBaseline = signedSeedBaseline ?? readDeclaredSeedConstructionAnchor(source);
  assert.ok(
    seedConstructionBaseline,
    'native release preparation requires authenticated completed constructor metadata or the immutable reviewed seed adoption contract',
  );
  const shippingChanges = selectObservedShippingChanges(
    observation.products,
    shippingBaselines,
    completed.products,
  );
  const decision = compareNativePreVersionDelivery({
    source,
    products,
    completed,
    affectedProducts: shippingChanges.affectedProducts,
    observation,
    seedConstructionBaseline,
  });
  const publicationInputs = await acquireNativePublicationInputs(
    { source, directory: path.join(directory, 'publication-inputs'), consumerProducts: products },
    {
      readJson: read,
      readPages: pages,
      assertCompleted,
      proveAsset: retainPublic,
      materialize: async (carrier, options) => {
        const key = `${carrier.product}@${carrier.version}/${carrier.id}`;
        const prior = retainedRegistry.get(key);
        if (prior) {
          for (const file of prior.carrier.artifacts) {
            const actual = fileIdentity(file.path);
            assert.deepEqual(
              { size: actual.size, sha256: actual.sha256 },
              { size: file.size, sha256: file.sha256 },
              'cached completed registry File changed',
            );
          }
          return prior;
        }
        const retained = await materialize(carrier, options);
        retainedRegistry.set(key, retained);
        return retained;
      },
    },
  );
  const supplierBaselines: ((typeof baselines)[number] & {
    sourceTags?: NativeSupplierArtifact[];
  })[] = baselines.map((baseline) => ({
    ...baseline,
    carriers: { ...baseline.carriers },
    productArtifacts: { ...baseline.productArtifacts },
  }));
  for (const row of publicationInputs.snapshot.supplierArtifacts ?? []) {
    let baseline = supplierBaselines.find(
      (baseline) =>
        baseline.publication.product === row.publication.product &&
        baseline.publication.version === row.publication.version,
    );
    if (!baseline) {
      const metadataBaseline = publicationInputs.supplierMetadata.get(
        `${row.publication.product}@${row.publication.version}`,
      );
      baseline = {
        publication: row.publication,
        carriers: {},
        productArtifacts: {},
        ...(metadataBaseline ? { metadataBaseline } : {}),
      };
      supplierBaselines.push(baseline);
    }
    assert.deepEqual(
      baseline.publication,
      row.publication,
      'retained supplier completed source differs',
    );
    if (row.source) {
      baseline.sourceTags ??= [];
      baseline.sourceTags.push(row);
    } else if (row.artifact.startsWith('github-release:'))
      baseline.productArtifacts[row.artifact] = row.file.path;
    else baseline.carriers[row.artifact] = [row.file.path];
  }
  const supplierTransports = {
    repository,
    assertCompletedPublication: assertCompleted,
    readJson: read,
    readPages: pages,
    proveAsset: async (url, _name, size) => {
      const proof = publicProofs.get(url);
      assert.ok(proof && proof.bytes === size, 'native supplier lacks its retained public proof');
      return proof;
    },
    registryOptions: { cachedReceipts: registryReceipts },
  };
  const suppliers = await projectNativeBuildBoundSuppliers(
    {
      products: Object.fromEntries(
        candidate.products.map((product) => [product.id, { version: product.version }]),
      ),
      source,
      observation,
      completed: supplierBaselines.map((baseline) => ({
        publication: baseline.publication,
        files: baseline.productArtifacts ?? {},
        carriers: baseline.carriers,
        ...(baseline.metadataBaseline ? { metadataBaseline: baseline.metadataBaseline } : {}),
        ...(baseline.sourceTags ? { sourceTags: baseline.sourceTags } : {}),
      })),
    },
    {
      authenticateCompleted: async (input) => {
        assert.ok(
          'files' in input && !Array.isArray(input.files) && 'carriers' in input,
          'native preparation supplier origin must come from its retained completed baseline',
        );
        if ('sourceTags' in input)
          return captureCompletedNativeSwiftSourceSuppliers(input, {
            ...supplierTransports,
            registryOptions: {
              cachedReceipts: new Map(
                [...retainedRegistry]
                  .filter(([key]) =>
                    key.startsWith(`${input.publication.product}@${input.publication.version}/`),
                  )
                  .map(([, retained]) => [retained.carrier.id, retained.receipt]),
              ),
            },
          });
        const publicOrigin = await captureCompletedNativePublicArtifacts(
          {
            publication: input.publication,
            files: input.files,
            metadataBaseline: input.metadataBaseline,
          },
          supplierTransports,
        );
        const registryOrigin = await captureCompletedNativeRegistryCarriers(
          {
            publication: input.publication,
            carriers: input.carriers,
            metadataBaseline: input.metadataBaseline,
          },
          {
            ...supplierTransports,
            registryOptions: {
              cachedReceipts: new Map(
                [...retainedRegistry]
                  .filter(([key]) =>
                    key.startsWith(`${input.publication.product}@${input.publication.version}/`),
                  )
                  .map(([, retained]) => [retained.carrier.id, retained.receipt]),
              ),
            },
          },
        );
        return {
          ...publicOrigin,
          archives: [...publicOrigin.archives, ...registryOrigin.archives],
          unknowns: [...publicOrigin.unknowns, ...registryOrigin.unknowns],
        };
      },
    },
  );
  // Partial diagnostics cannot become an authority for Release Please.
  assert.equal(
    decision.releaseDecision,
    'qualified',
    `native release decision is incomplete: ${decision.products
      .filter((product) => product.necessaryDelivery === 'unknown')
      .map((product) => product.product)
      .join(', ')}`,
  );
  assert.ok(
    suppliers.buildBound && !suppliers.unknowns.length,
    'native release compatibility projection is incomplete',
  );
  return {
    candidate,
    observation,
    shippingBaselines,
    completed,
    shippingChanges,
    decision,
    suppliers,
    baselines,
    builds,
    origins,
    publicationInputs,
    // Retain the existing one-pass public byte proofs for exact held inputs
    // discovered after RP freezes independent producer/consumer scope.
    completedPublicFiles: [...retainedPublic.values()].map((file) =>
      Object.freeze(structuredClone(file)),
    ),
  };
}

export function stageNativeReleaseArchives(
  origins: Map<string, Awaited<ReturnType<typeof acquireAuthenticatedNativeBuildEvidence>>>,
  source: NativeBuildSource,
  directory: string,
) {
  return collateNativeReleaseFiles(origins, source, directory, false);
}

/** Conventional readers require host assets and separate checksum outputs together. */
export function stageNativeReleaseFamilies(
  origins: Map<string, Awaited<ReturnType<typeof acquireAuthenticatedNativeBuildEvidence>>>,
  source: NativeBuildSource,
  directory: string,
  products?: readonly string[],
) {
  return collateNativeReleaseFiles(origins, source, directory, true, products);
}

function collateNativeReleaseFiles(
  origins: Map<string, Awaited<ReturnType<typeof acquireAuthenticatedNativeBuildEvidence>>>,
  source: NativeBuildSource,
  directory: string,
  finalFamily: boolean,
  products?: readonly string[],
) {
  const destination = path.resolve(directory);
  if (finalFamily)
    assert.ok(
      path.relative(ROOT, destination).startsWith(`target${path.sep}`),
      'native release families must remain under target/',
    );
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native release files',
  });
  assert.ok(!existsSync(destination), 'native release files require a new owned directory');
  const catalog = loadPublicationCatalog('native release files');
  assert.ok(
    products === undefined ||
      (Array.isArray(products) &&
        products.length > 0 &&
        new Set(products).size === products.length &&
        products.every((id) => catalog.products.some((product) => product.id === id))),
    'native release family selection requires unique canonical product IDs',
  );
  const expected = expectedProductArtifactRows(catalog.products);
  const copied = new Set<string>();
  const families = new Set<string>();
  mkdirSync(destination);
  try {
    for (const [evidenceRoot, origin] of origins) {
      const evidence = origin.evidence as any;
      assert.deepEqual(evidence.source, source, 'native family producer source differs');
      assert.ok(origin.finalFiles, 'native family needs retained authenticated Files');
      origin.finalFiles.assertUnchanged?.();
      for (const [cohort, value] of evidence.cohorts.entries())
        for (const root of value.roots.filter(
          (root) =>
            (products === undefined || products.includes(root.package.product)) &&
            root.package.ecosystem === 'github' &&
            ['github-release-asset', ...(finalFamily ? ['github-release-metadata'] : [])].includes(
              root.package.role,
            ),
        )) {
          const outputPaths = new Set(root.package.outputs.map((output) => output.path));
          for (const output of value.outputs.filter((output) => outputPaths.has(output.path)))
            for (const member of output.members.filter((member) => member.type === 'file')) {
              const name = path.posix.basename(member.path || output.path);
              assert.equal(
                expected.filter((row) => row.product === root.package.product && row.name === name)
                  .length,
                1,
                `native family ${name} has no unique canonical public owner`,
              );
              const key = `${root.package.product}/${name}`;
              assert.ok(!copied.has(key), `native family repeats an observed public File ${key}`);
              copied.add(key);
              const file = member.path ? `${output.path}/${member.path}` : output.path;
              assert.equal(
                origin.finalFiles.files.filter(
                  (captured) => captured.cohort === cohort && captured.path === file,
                ).length,
                1,
                'native family File is absent from authenticated transport',
              );
              const family = path.join(
                destination,
                root.package.product,
                ...(finalFamily ? ['release-assets'] : []),
              );
              requireSafeDirectoryChain(family, { create: true, label: 'native release family' });
              const target = path.join(family, name);
              copyFileSync(path.join(evidenceRoot, 'files', String(cohort), file), target);
              assert.ok(
                (member.mode & 0o400) !== 0 &&
                  (member.mode & 0o002) === 0 &&
                  !((member.mode & 0o111) !== 0 && (member.mode & 0o020) !== 0),
                'native family File has an unsafe captured mode',
              );
              chmodSync(target, member.mode);
              const identity = fileIdentity(target);
              assert.deepEqual(
                { size: identity.size, sha256: identity.sha256 },
                { size: member.size, sha256: member.sha256 },
                'native family File changed during relocation',
              );
              families.add(family);
            }
        }
      origin.finalFiles.assertUnchanged?.();
    }
    return [...families].sort();
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Freeze genuine pre-version constructor Files for final-runtime qualification. */
export function qualifiedNativeSeedControls(
  preparation: Pick<
    Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>,
    'observation' | 'origins'
  >,
  bridge: NativeVersionSourceBridge,
  finalSource: NativeBuildSource,
  directory = ROOT,
) {
  const transition = assertNativeVersionSourceTransition(bridge, finalSource, directory);
  const controls: NativeSeedInputControl[] = [];
  for (const [evidenceRoot, origin] of preparation.origins) {
    const build = preparation.observation.authenticated.find(
      (build) =>
        build.origin.evidenceDigest === origin.evidenceDigest &&
        build.origin.artifact.id === origin.artifact.id,
    );
    assert.ok(
      build?.producerAssurance && origin.finalFiles,
      'seed promotion requires a retained authenticated reviewed producer',
    );
    validateReviewedNativeProducerAssurance(build.producerAssurance, {
      source: bridge.source,
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      requiredTests: build.qualification.requiredTests,
    });
    const finalFiles = origin.finalFiles;
    finalFiles.assertUnchanged?.();
    for (const [cohort, evidence] of build.evidence.cohorts.entries()) {
      for (const row of evidence.seedConstructions ?? []) {
        const receipt = validateSeedConstructionReceipt(JSON.parse(row.contents));
        const frozenPath = `${row.path.slice(0, -SEED_CONSTRUCTION_RECEIPT_SUFFIX.length)}.tar`;
        const file = (name: string) => {
          const captured = finalFiles.files.filter(
            (file) => file.cohort === cohort && file.path === name,
          );
          assert.equal(
            captured.length,
            1,
            'seed promotion needs its exact authenticated supporting File',
          );
          return {
            path: path.join(evidenceRoot, 'files', String(cohort), name),
            size: captured[0].size,
            sha256: captured[0].sha256,
          };
        };
        const frozen = file(frozenPath);
        assert.deepEqual(
          { size: frozen.size, sha256: frozen.sha256 },
          receipt.frozen,
          'seed promotion original constructor TAR differs',
        );
        controls.push({
          family: receipt.intent.family,
          target: receipt.intent.target,
          profile: receipt.intent.profile,
          promotion: {
            source: structuredClone(bridge.source),
            evidenceDigest: origin.evidenceDigest,
            invocationId: build.qualification.cohorts[cohort].invocationId,
            frozen,
            receipt: file(row.path),
            transition,
          },
        });
      }
    }
  }
  // The existing importer validates exact File bytes and source-bound slots.
  projectNativeSeedInputs(controls, finalSource);
  return controls;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'stage-release-archives': { type: 'boolean' },
      'publication-inputs': { type: 'boolean' },
      'seed-adoption-anchor': { type: 'boolean' },
      'consumer-products-json': { type: 'string' },
      'metadata-publisher-sha': { type: 'string' },
      'metadata-bundles-json': { type: 'string' },
      'run-id': { type: 'string' },
      ref: { type: 'string' },
      'output-directory': { type: 'string' },
    },
    strict: true,
  });
  if (
    [
      values['stage-release-archives'],
      values['publication-inputs'],
      values['seed-adoption-anchor'],
    ].filter(Boolean).length !== 1 ||
    !values['output-directory'] ||
    (values['stage-release-archives'] &&
      (!values['run-id'] || !/^[1-9][0-9]*$/u.test(values['run-id']))) ||
    (values['seed-adoption-anchor'] &&
      (!values['run-id'] || !/^[1-9][0-9]*$/u.test(values['run-id']) || !values.ref)) ||
    (values['publication-inputs'] &&
      (values['run-id'] !== undefined || values.ref !== undefined)) ||
    Boolean(values['metadata-publisher-sha']) !== Boolean(values['metadata-bundles-json'])
  )
    throw new Error(
      'usage: native-release-preparation.mts (--stage-release-archives --run-id ID [--ref REF] | --publication-inputs [--consumer-products-json FILE]) --output-directory DIR',
    );
  try {
    if (values['publication-inputs']) {
      const result = await acquireNativePublicationInputs({
        source: sourceIdentity('HEAD'),
        directory: values['output-directory'],
        ...(values['consumer-products-json']
          ? { consumerProducts: JSON.parse(readFileSync(values['consumer-products-json'], 'utf8')) }
          : { consumerProducts: Object.keys(loadProducts()) }),
        ...(values['metadata-publisher-sha']
          ? {
              metadataOrigin: {
                publisherSha: values['metadata-publisher-sha'],
                bundlePaths: JSON.parse(readFileSync(values['metadata-bundles-json']!, 'utf8')),
              },
            }
          : {}),
      });
      console.log(result.file);
    } else if (values['seed-adoption-anchor']) {
      console.log(
        await acquireNativeSeedConstructionAnchor({
          source: sourceIdentity('HEAD'),
          runId: Number(values['run-id']),
          ref: values.ref!,
          directory: values['output-directory'],
        }),
      );
    } else {
      assert.ok(
        process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS,
        'native family construction requires the source-bound input snapshot',
      );
      const result = await acquireNativeReleaseArchives({
        source: sourceIdentity('HEAD'),
        publicationInputs: process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS,
        ...(values['consumer-products-json']
          ? { consumerProducts: JSON.parse(readFileSync(values['consumer-products-json'], 'utf8')) }
          : {}),
        runId: Number(values['run-id']),
        directory: values['output-directory'],
        ref: values.ref,
      });
      if (result.publicationInputs && process.env.GITHUB_ENV)
        appendFileSync(
          process.env.GITHUB_ENV,
          `OLIPHAUNT_NATIVE_PUBLICATION_INPUTS=${result.publicationInputs}\n`,
        );
      console.log(result.directory);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
