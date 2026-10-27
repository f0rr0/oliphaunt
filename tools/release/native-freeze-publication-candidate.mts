/** Freeze post-version native Files. Selection was decided before the version edit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  extensionReleaseConsumerInputs,
  requestedSwiftExtensionCarrierProducts,
} from '../../src/native/sdks/swift/tools/swift-extension-release-consumer-inputs.mts';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { assertAuthenticatedNativeBuildOrigin } from './authenticate-native-build-evidence.mts';
import { validateReleaseConsumerCompatibility } from './consumer-compatibility.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import {
  assertNativeFinalShippingPhase,
  type NativeBuildSource,
} from './native-build-qualification.mts';
import { readCompletedNativeDeliveryInventory } from './native-completed-delivery.mts';
import { fileIdentity } from './native-file-identity.mts';
import {
  acquireCompletedNativeMetadataBaseline,
  observedNativePublicationMetadata,
  writeMetadataRecords,
} from './native-publication-metadata.mts';
import { NATIVE_PUBLICATION_METADATA_KIND } from './native-publication-metadata-contract.mts';
import {
  type NativePublicationBuild,
  observeNativePublicationConstruction,
  projectNativePublicationConstruction,
} from './native-publication-observation.mts';
import { NATIVE_EXTENSION_RELEASE_INPUT_ROLES } from './native-publication-staging.mts';
import {
  acquirePreparedNativeReleaseInputs,
  assertAcquiredPreparedNativeReleaseInputs,
  type NativeReleaseInputRecord,
  parseNativeReleaseInputRecord,
  resolveNativeReleaseInputContext,
} from './native-release-inputs.mts';
import {
  acquireNativePublicationBuilds,
  stageNativeReleaseFamilies,
} from './native-release-preparation.mts';
import { projectNativeBuildBoundSuppliers } from './native-shipping-suppliers.mts';
import {
  type NativeSupplierArtifact,
  validateNativeSupplierArtifacts,
} from './native-supplier-artifacts.mts';
import { loadPublicationCatalog, publicationCatalogDigest } from './publication-catalog.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import {
  buildPublicationCandidate,
  expectedProductArtifactRows,
  freezeNativePublicationCandidate,
  lockedPublicationFiles,
  sourceIdentity,
  validatePublicationCandidate,
} from './publication-lock.mts';
import { materializeRegistryCarrierIntegrity } from './registry-integrity.mts';
import { ROOT } from './release-graph.mts';
import { requestReleaseAssetProof } from './verify_github_release_attestations.mts';
import { releaseProductsFromManifests } from './verify-release-commit.mts';

type Candidate = ReturnType<typeof buildPublicationCandidate>;
type Acquisition = Awaited<ReturnType<typeof acquireNativePublicationBuilds>>;
type Observation = Awaited<ReturnType<typeof observeNativePublicationConstruction>>;
type Prepared = Awaited<ReturnType<typeof acquirePreparedNativeReleaseInputs>>;
type Origin = Acquisition['origins'] extends Map<string, infer Value> ? Value : never;
type CompletedInputs = NonNullable<
  Parameters<typeof projectNativeBuildBoundSuppliers>[0]['completed']
>;
const repository = 'f0rr0/oliphaunt';
const admitted = new WeakMap<
  object,
  {
    digest: string;
    prepared: Prepared;
    origins: readonly Origin[];
  }
>();
const reviewedObservations = new WeakMap<
  object,
  { complete: string; run: string; observation: string }
>();
const equal = (actual: unknown, expected: unknown, message: string) =>
  assert.equal(consumerDigest(actual), consumerDigest(expected), message);

/** The controller reads requirements from retained original Files, not a newer
 * checkout's pins. Construction and authentication are separate obligations.
 */
export function nativeSwiftFixtureRequest(
  complete: Candidate,
  selectedProducts: readonly string[],
) {
  if (!selectedProducts.includes('oliphaunt-swift')) return [];
  const source = complete.productArtifacts.filter(
    (artifact) =>
      artifact.product === 'oliphaunt-swift' && artifact.kind === 'swiftpm-ios-carrier-manifest',
  );
  assert.equal(source.length, 1, 'Swift fixture request needs the original source carrier');
  const read = (artifact) => JSON.parse(readFileSync(path.resolve(ROOT, artifact.path), 'utf8'));
  const carriers = complete.productArtifacts
    .filter(
      (artifact) =>
        artifact.kind === 'swift-extension-carrier' && selectedProducts.includes(artifact.product),
    )
    .map((artifact) => {
      const document = read(artifact);
      assert.equal(
        document.release?.product,
        artifact.product,
        'Swift fixture carrier owner differs',
      );
      assert.equal(
        document.release?.version,
        complete.products.find(({ id }) => id === artifact.product)?.version,
        'Swift fixture carrier version differs',
      );
      return document;
    });
  return requestedSwiftExtensionCarrierProducts({
    selectedProducts,
    sourceBase: read(source[0]).base,
    carriers,
  });
}

function assertNativeSwiftFixture(
  candidate: Candidate,
  complete: Candidate,
  selectedProducts: readonly string[],
  nativeBaseArchiveInputs = undefined,
) {
  const requested = nativeSwiftFixtureRequest(complete, selectedProducts);
  const fixtures = candidate.productArtifacts.filter(
    ({ kind }) => kind === 'swiftpm-extension-consumer-fixture',
  );
  assert.equal(
    fixtures.length,
    requested.length ? 1 : 0,
    'Swift fixture differs from the source-bound requested tuple',
  );
  if (!requested.length) return;
  const source = complete.productArtifacts.find(
    (artifact) =>
      artifact.product === 'oliphaunt-swift' && artifact.kind === 'swiftpm-ios-carrier-manifest',
  );
  assert.ok(source);
  const controls = complete.productArtifacts.filter(
    (artifact) =>
      artifact.kind === 'swift-extension-carrier' && requested.includes(artifact.product),
  );
  const plan = extensionReleaseConsumerInputs({
    sourceCarrierFile: path.resolve(ROOT, source.path),
    extensionCarrierFiles: controls.map((artifact) => path.resolve(ROOT, artifact.path)),
    nativeBaseArchiveInputs,
  });
  const document = JSON.parse(
    readFileSync(path.resolve(ROOT, fixtures[0].path, 'extension-products.json'), 'utf8'),
  );
  equal(
    document.selected.map(({ sqlName }) => sqlName).sort(),
    plan.extensions,
    'Swift fixture SQL closure differs',
  );
  equal(
    document.nativeRuntime,
    { product: plan.finalLink.runtimeProduct, version: plan.finalLink.runtimeVersion },
    'Swift fixture native requirement differs',
  );
  assert.equal(
    document.basePackage?.version,
    candidate.products.find(({ id }) => id === 'oliphaunt-swift')?.version,
    'Swift fixture source version differs',
  );
  const expected = controls
    .map(({ product }) => ({
      product,
      version: complete.products.find(({ id }) => id === product)?.version,
    }))
    .sort((a, b) => a.product.localeCompare(b.product));
  const actual = [
    ...new Map(
      document.selected.map(({ releaseProduct, version }) => [
        releaseProduct,
        { product: releaseProduct, version },
      ]),
    ).values(),
  ].sort((a: any, b: any) => a.product.localeCompare(b.product));
  equal(actual, expected, 'Swift fixture selected carrier identities differ');
}

function publicationQualification(
  prepared: Prepared,
  acquisition: Acquisition,
  complete: Candidate,
) {
  assertAcquiredPreparedNativeReleaseInputs(prepared);
  assertSuccessfulNativePublicationRun(acquisition.run, complete.source);
  const origin = prepared.origin;
  return {
    source: complete.source,
    prepare: {
      runId: origin.runId,
      runAttempt: origin.runAttempt,
      artifact: {
        id: origin.artifact.id,
        name: origin.artifact.name,
        digest: origin.artifact.digest,
        size: origin.artifact.size_in_bytes,
      },
      codeSource: origin.codeSource,
      preparedSource: origin.preparedSource,
    },
    bridge: prepared.record.bridge,
    selectedProducts: prepared.record.selectedProducts,
    producer: {
      runId: acquisition.run.id,
      runAttempt: acquisition.run.run_attempt,
      event: acquisition.run.event,
      ref: 'refs/heads/main',
      workflowPath: acquisition.run.path,
    },
    inventory: {
      products: complete.products.map(({ id }) => id).sort(),
      artifactPhase: complete.artifactPhase,
      packageEnvelopeDigest: complete.packageEnvelopeDigest,
    },
  };
}

/** This checks run facts; authenticated per-job artifacts remain separately mandatory. */
export function assertSuccessfulNativePublicationRun(run: any, source: NativeBuildSource) {
  assert.ok(
    Number.isSafeInteger(run?.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.head_sha === source.commit &&
      run.head_branch === 'main' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.path === '.github/workflows/bazel.yml' &&
      run.name === 'Native Bazel qualification' &&
      run.status === 'completed' &&
      run.conclusion === 'success',
    'native publication requires successful exact post-version main qualification',
  );
}

/** Selection projection is structural. It cannot authenticate producers or authorize freeze. */
export function assertSelectedNativeEnvelope(
  candidate: Candidate,
  complete: Candidate,
  selectedProducts: readonly string[],
  { nativeBaseArchiveInputs = undefined } = {},
) {
  assert.ok(
    selectedProducts.length > 0 && new Set(selectedProducts).size === selectedProducts.length,
    'native publication selection must be nonempty and unique',
  );
  const selected = new Set(selectedProducts);
  equal(candidate.source, complete.source, 'selected native source differs');
  equal(
    candidate.products,
    complete.products.filter(({ id }) => selected.has(id)),
    'selected native products differ from the authenticated release scope',
  );
  equal(
    candidate.products.map(({ id }) => id).sort(),
    [...selected].sort(),
    'native publication cannot add an unchanged or omit a selected product',
  );
  assert.equal(
    candidate.artifactPhase ?? 'final',
    'final',
    'selected native envelope must be final',
  );
  const artifactIdentity = ({ path: _path, ...row }) => row;
  const carrier = ({ dependencies: _dependencies, publishOrder: _publishOrder, ...row }) => ({
    ...row,
    artifacts: row.artifacts.map(artifactIdentity),
  });
  const carriers = (rows: any[]) => rows.map(carrier).sort((a, b) => a.id.localeCompare(b.id));
  equal(
    carriers(candidate.carriers),
    carriers(complete.carriers.filter((row) => selected.has(row.product))),
    'selected native carrier bytes or manifest requirements changed',
  );
  assertNativeSwiftFixture(candidate, complete, selectedProducts, nativeBaseArchiveInputs);
  for (const artifact of candidate.productArtifacts) {
    if (artifact.kind === NATIVE_PUBLICATION_METADATA_KIND) continue;
    if (artifact.kind === 'swiftpm-extension-consumer-fixture') {
      assert.ok(
        expectedProductArtifactRows(candidate.products, { swiftExtensionFixture: true }).some(
          (row) => row.product === artifact.product && row.id === artifact.id,
        ),
        'unselected Swift fixture cannot enter a native publication',
      );
      // The final observation independently binds this selection-specific File.
      continue;
    }
    const original = complete.productArtifacts.find(
      (row) => row.product === artifact.product && row.id === artifact.id,
    );
    assert.ok(original, 'selected native public artifact was not observed');
    equal(
      artifactIdentity(artifact),
      artifactIdentity(original),
      'selected native public artifact changed after observation',
    );
  }
}

function assertCompleteInventory(complete: Candidate) {
  validatePublicationCandidate(complete);
  const catalog = loadPublicationCatalog('native publication complete inventory');
  equal(complete.products, catalog.products, 'native publication requires every canonical product');
  assert.equal(
    complete.catalogDigest,
    publicationCatalogDigest(catalog),
    'native publication catalog differs',
  );
  assert.deepEqual(complete.missing, [], 'native publication is missing final carriers');
  assert.equal(
    complete.artifactPhase,
    'pre-version',
    'complete inventory must exclude only the selection-conditional final fixture',
  );
}

async function observeAuthenticated(
  complete: Candidate,
  acquisition: Acquisition,
  bazelVersion: string,
) {
  assertSuccessfulNativePublicationRun(acquisition.run, complete.source);
  assert.equal(
    acquisition.origins.size,
    acquisition.builds.length,
    'native producer inventory differs',
  );
  const authenticate = async (
    evidenceRoot: string,
    expected: NativePublicationBuild['expected'],
  ) => {
    const build = acquisition.builds.find((row) => row.evidenceRoot === evidenceRoot);
    assert.ok(build, 'native publication cannot import an unacquired producer');
    equal(expected, build.expected, 'cached native producer constraints changed');
    assert.equal(expected.github.runId, acquisition.run.id, 'native producer run differs');
    assert.ok(
      Number.isSafeInteger(expected.github.runAttempt) &&
        expected.github.runAttempt > 0 &&
        expected.github.runAttempt <= acquisition.run.run_attempt,
      'native producer attempt is newer than the observation',
    );
    assert.equal(expected.ref, 'refs/heads/main', 'native publication producer must be main');
    assert.equal(expected.event, acquisition.run.event, 'native producer event differs');
    return assertAuthenticatedNativeBuildOrigin(acquisition.origins.get(evidenceRoot));
  };
  const observation = await observeNativePublicationConstruction(
    {
      envelope: complete,
      files: lockedPublicationFiles(complete),
      repository,
      bazelVersion,
      builds: acquisition.builds,
      reviewedSource: complete.source,
    },
    { authenticate },
  );
  assert.equal(
    observation.coverage.completeProductInventory,
    true,
    'native publication requires complete coverage',
  );
  assert.equal(
    observation.coverage.releaseInputsRequired,
    true,
    'native publication requires construction inputs',
  );
  for (const build of observation.authenticated) {
    assert.ok(build.producerAssurance, 'native publication requires reviewed producer assurance');
    assert.equal(
      build.qualification.shippingAnalysis,
      'bound',
      'native publication requires producing analysis',
    );
    assert.equal(
      build.qualification.qualificationPolicy,
      'bound',
      "native publication requires each shipping root's mandatory successful configured tests",
    );
  }
  reviewedObservations.set(observation, {
    complete: consumerDigest(complete),
    run: consumerDigest(acquisition.run),
    observation: consumerDigest(observation),
  });
  return observation;
}

/** Acquire only held Files actually declared by the authenticated configured producers.
 * Existing completion/registry/public-asset readers reauthenticate these contexts. */
export async function acquireObservedCompletedSuppliers(
  observation: Observation,
  directory: string,
  retainedArtifacts: unknown = [],
  {
    inventory = readCompletedNativeDeliveryInventory,
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    materialize = materializeRegistryCarrierIntegrity,
    proveAsset = requestReleaseAssetProof,
    acquireMetadata = acquireCompletedNativeMetadataBaseline,
  } = {},
): Promise<CompletedInputs> {
  const retained = validateNativeSupplierArtifacts(retainedArtifacts);
  const retainedFile = (publication, artifact: string) => {
    const matches = retained.filter(
      (row) =>
        consumerDigest(row.publication) === consumerDigest(publication) &&
        row.artifact === artifact,
    );
    assert.ok(matches.length <= 1, 'retained completed supplier artifact repeats');
    const row = matches[0];
    if (row) {
      const physical = fileIdentity(row.file.path);
      equal(
        { size: physical.size, sha256: physical.sha256 },
        { size: row.file.size, sha256: row.file.sha256 },
        'retained completed supplier File changed',
      );
    }
    return row;
  };
  const groups = new Map<string, { publication: any; artifacts: Set<string> }>();
  for (const { evidence } of observation.authenticated)
    for (const cohort of evidence.cohorts)
      for (const root of cohort.roots)
        for (const supplier of root.package.supplierInputs ?? []) {
          if (supplier.origin.kind !== 'completed-publication') continue;
          const publication = supplier.origin.publication;
          const key = consumerDigest(publication);
          let group = groups.get(key);
          if (!group) {
            group = { publication, artifacts: new Set() };
            groups.set(key, group);
          }
          group.artifacts.add(supplier.origin.artifact);
        }
  const inputs: CompletedInputs = [];
  for (const [index, { publication, artifacts }] of [...groups.values()].entries()) {
    const release = await readJson(
      `repos/${repository}/releases/tags/${encodeURIComponent(publication.tagName)}`,
    );
    const assets = await readPages(`repos/${repository}/releases/${release.id}/assets`);
    const metadataBaseline = (
      await acquireMetadata(
        { publication, directory: path.join(directory, String(index), 'metadata'), assets },
        { proveAsset },
      )
    )?.baseline;
    const historical = await inventory(publication, { metadataBaseline, readJson });
    const carriers: Record<string, string[]> = {};
    const files: Record<string, string> = {};
    const sourceTags: NativeSupplierArtifact[] = [];
    for (const [item, identity] of [...artifacts].sort().entries()) {
      if (identity.startsWith('swift-source-tag:')) {
        const retainedSource = retainedFile(publication, identity);
        assert.ok(
          retainedSource?.source,
          'completed Git source supplier is absent from the acquired Prepare inputs',
        );
        const bindings = historical.publicRows.filter(
          ({ kind, role }) => kind === 'swift-bindings' && role === 'github-release-asset',
        );
        assert.equal(
          bindings.length,
          1,
          'completed source supplier needs one canonical binding archive',
        );
        const binding = retainedFile(publication, bindings[0].id);
        assert.ok(
          binding && !binding.source,
          'completed source supplier requires its retained same-publication binding archive',
        );
        files[bindings[0].id] = binding.file.path;
        sourceTags.push(retainedSource);
        continue;
      }
      const separator = identity.indexOf(':');
      const ecosystem = identity.slice(0, separator);
      if (['cargo', 'npm'].includes(ecosystem)) {
        const matching = historical.carriers.filter((row) => row.id === identity);
        assert.equal(
          matching.length,
          1,
          'held registry supplier is absent from its historical inventory',
        );
        const carrier = matching[0];
        assert.equal(carrier.product, publication.product, 'held registry supplier owner differs');
        const captured = retainedFile(publication, identity);
        if (captured) {
          carriers[identity] = [captured.file.path];
          continue;
        }
        const retained = await materialize(
          {
            ...carrier,
            version: publication.version,
            artifacts: carrier.artifacts?.map((artifact) => ({
              ...artifact,
              path: path.basename(artifact.path),
            })) ?? [
              {
                path:
                  ecosystem === 'cargo'
                    ? `${carrier.name}-${publication.version}.crate`
                    : `${carrier.name.replace(/[^a-zA-Z0-9.-]/gu, '-')}-${publication.version}.tgz`,
              },
            ],
          },
          { directory: path.join(directory, String(index), String(item)) },
        );
        carriers[identity] = retained.carrier.artifacts.map(({ path: file }) => file);
      } else {
        const rows = historical.publicRows;
        const matching = rows.filter((row) => row.id === identity || row.name === identity);
        assert.equal(
          matching.length,
          1,
          'held supplier requires an exact canonical public artifact',
        );
        const row = matching[0];
        const captured = retainedFile(publication, row.id);
        if (captured) {
          files[row.id] = captured.file.path;
          continue;
        }
        const matches = assets.filter((asset) => asset.name === row.name);
        assert.equal(matches.length, 1, 'held supplier public asset is absent or ambiguous');
        const asset = matches[0];
        assert.ok(
          asset.state === 'uploaded' &&
            Number.isSafeInteger(asset.id) &&
            asset.id > 0 &&
            asset.url ===
              `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` &&
            Number.isSafeInteger(asset.size) &&
            asset.size > 0 &&
            (asset.digest == null || /^sha256:[a-f0-9]{64}$/u.test(asset.digest)) &&
            (row.size === undefined || row.size === asset.size) &&
            (row.sha256 === undefined ||
              asset.digest == null ||
              asset.digest === `sha256:${row.sha256}`),
          'held supplier public asset identity differs',
        );
        const retainedPath = path.join(directory, String(index), String(item), row.name);
        await proveAsset(asset.url, row.name, asset.size, {
          retainedPath,
          ...(row.sha256 || asset.digest
            ? { expectedSha256: row.sha256 ?? asset.digest.slice(7) }
            : {}),
        });
        files[row.id] = retainedPath;
      }
    }
    const context = { publication, ...(metadataBaseline ? { metadataBaseline } : {}) };
    if (sourceTags.length) inputs.push({ ...context, files, carriers, sourceTags });
    else {
      if (Object.keys(carriers).length) inputs.push({ ...context, carriers });
      if (Object.keys(files).length) inputs.push({ ...context, files });
    }
  }
  return inputs;
}

/** Only this fixed, authenticated entry point can mint a fresh native freeze capability. */
export async function admitNativePublicationCandidate({
  candidate,
  complete,
  prepared,
  acquisition,
  observation,
  completed,
}: {
  candidate: Candidate;
  complete: Candidate;
  prepared: Prepared;
  acquisition: Acquisition;
  observation: Observation;
  completed: CompletedInputs;
}) {
  assertAcquiredPreparedNativeReleaseInputs(prepared);
  assertCompleteInventory(complete);
  assertSuccessfulNativePublicationRun(acquisition.run, candidate.source);
  equal(
    candidate.source.tree,
    prepared.record.preparedSource.tree,
    'native publication source differs from prepared tree',
  );
  const sourceCarrier = complete.productArtifacts.find(
    (artifact) =>
      artifact.product === 'oliphaunt-swift' && artifact.kind === 'swiftpm-ios-carrier-manifest',
  );
  let nativeBaseArchiveInputs;
  if (sourceCarrier && prepared.record.selectedProducts.includes('oliphaunt-swift')) {
    const sourceBase = JSON.parse(
      readFileSync(path.resolve(ROOT, sourceCarrier.path), 'utf8'),
    ).base;
    const snapshot = JSON.parse(readFileSync(prepared.snapshotFile, 'utf8'));
    const archives = Object.fromEntries(
      sourceBase.assets.flatMap((asset) => {
        const rows = (snapshot.supplierArtifacts ?? []).filter(
          (row) =>
            row.publication.product === sourceBase.product &&
            row.publication.version === sourceBase.version &&
            row.artifact === `github-release:${asset.name}`,
        );
        assert.ok(rows.length <= 1, 'Swift fixture source base archive repeats');
        return rows.length ? [[asset.role, rows[0].file]] : [];
      }),
    );
    if (Object.keys(archives).length) {
      assert.equal(
        Object.keys(archives).length,
        2,
        'Swift fixture source base archive tuple is incomplete',
      );
      nativeBaseArchiveInputs = archives;
    }
  }
  assertSelectedNativeEnvelope(candidate, complete, prepared.record.selectedProducts, {
    nativeBaseArchiveInputs,
  });
  validatePublicationCandidate(candidate);
  assert.deepEqual(candidate.missing, [], 'native selected publication is incomplete');
  const reviewed = reviewedObservations.get(observation);
  assert.ok(
    reviewed,
    'native publication observation was not checked against actual acquired producers',
  );
  equal(
    reviewed.complete,
    consumerDigest(complete),
    'native complete envelope changed after observation',
  );
  equal(
    reviewed.run,
    consumerDigest(acquisition.run),
    'native qualifying run changed after observation',
  );
  equal(
    reviewed.observation,
    consumerDigest(observation),
    'native physical observation changed after validation',
  );
  // The observer must be the already checked actual origins, never supplied JSON.
  equal(
    observation.authenticated.map(({ origin }) => origin.evidenceDigest).sort(),
    [...acquisition.origins.values()]
      .map((origin) => assertAuthenticatedNativeBuildOrigin(origin).evidenceDigest)
      .sort(),
    'native observation is not the acquired producer set',
  );
  for (const { origin } of observation.authenticated) assertAuthenticatedNativeBuildOrigin(origin);
  const metadata = candidate.productArtifacts.filter(
    (artifact) => artifact.kind === NATIVE_PUBLICATION_METADATA_KIND,
  );
  const withoutMetadata = {
    ...candidate,
    productArtifacts: candidate.productArtifacts.filter(
      (artifact) => artifact.kind !== NATIVE_PUBLICATION_METADATA_KIND,
    ),
  };
  const selectedFiles = lockedPublicationFiles(candidate).filter(
    (file) => !metadata.some((artifact) => file.path === artifact.path),
  );
  const selectedObservation = projectNativePublicationConstruction(
    { envelope: withoutMetadata, files: selectedFiles },
    observation.authenticated,
  );
  for (const build of selectedObservation.authenticated)
    assertNativeFinalShippingPhase(build.qualification, prepared.record.selectedProducts);
  const records = observedNativePublicationMetadata(
    {
      envelope: withoutMetadata,
      files: selectedFiles,
      repository,
      bazelVersion: readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim(),
      builds: acquisition.builds,
      reviewedSource: candidate.source,
    },
    selectedObservation,
    publicationQualification(prepared, acquisition, complete),
  );
  assert.equal(metadata.length, records.length, 'native selected metadata coverage differs');
  for (const record of records) {
    const artifact = metadata.find((row) => row.product === record.product.id);
    assert.ok(artifact, 'native selected product provenance is missing');
    equal(
      JSON.parse(readFileSync(path.resolve(ROOT, artifact.path), 'utf8')),
      record,
      'native publication metadata differs from actual configured observation',
    );
  }
  const suppliers = await projectNativeBuildBoundSuppliers({
    products: Object.fromEntries(complete.products.map((product) => [product.id, product])),
    source: complete.source,
    observation,
    completed,
  });
  assert.deepEqual(
    suppliers.unknowns,
    [],
    'native publication has unknown supplier bytes or origins',
  );
  assert.ok(suppliers.buildBound, 'native publication lacks complete configured suppliers');
  const edges = (map: Map<string, Set<string>>) =>
    [...map]
      .map(([id, rows]) => [id, [...rows].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
  equal(
    edges(suppliers.buildBound),
    edges(prepared.buildBound),
    'post-version supplier adoption differs from prepared selection',
  );
  validateReleaseConsumerCompatibility(prepared.record.selectedProducts, {
    buildBound: suppliers.buildBound,
  });
  lockedPublicationFiles(candidate);
  admitted.set(candidate, {
    digest: consumerDigest(candidate),
    prepared,
    origins: Object.freeze([...acquisition.origins.values()]),
  });
  return suppliers;
}

/** A structural record, clone, edited candidate or missing retained File cannot authorize freeze. */
export function assertAdmittedNativePublicationCandidate(candidate: Candidate) {
  const proof = admitted.get(candidate);
  assert.ok(proof, 'native candidate has not passed authenticated publication admission');
  equal(consumerDigest(candidate), proof.digest, 'native admitted candidate changed');
  assertAcquiredPreparedNativeReleaseInputs(proof.prepared);
  for (const origin of proof.origins) assertAuthenticatedNativeBuildOrigin(origin);
  lockedPublicationFiles(candidate);
}

export async function acquireNativePublicationPreparation({
  source,
  prepareRunId,
  pullNumber,
  directory,
}: {
  source: NativeBuildSource;
  prepareRunId?: number;
  pullNumber?: number;
  directory: string;
}) {
  const context = await resolveNativeReleaseInputContext({ source, pullNumber });
  assert.ok(
    context,
    'native publication requires an authenticated canonical release PR transition',
  );
  if (prepareRunId === undefined) {
    // Reuse the same exact-source workflow selector used by native CI, without
    // accepting any unrelated branch or current main run as preparation.
    const parent = requireSafeDirectoryChain(path.dirname(directory), {
      create: true,
    });
    const result = path.join(parent, 'prepare-run.output');
    execFileSync(
      'bash',
      [
        path.join(ROOT, '.github/scripts/require-workflow-success.sh'),
        'Release',
        context.prepareSourceCommit,
        '900',
        '--event',
        'workflow_dispatch',
        '--job',
        'Prepare release PR',
        '--artifact',
        'native-release-inputs',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, GH_REPO: repository, GITHUB_OUTPUT: result },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    const match = /^run_id=([1-9][0-9]*)$/mu.exec(readFileSync(result, 'utf8'));
    assert.ok(match, 'exact-source Prepare selection did not return a run');
    prepareRunId = Number(match[1]);
  }
  const prepared = await acquirePreparedNativeReleaseInputs({
    runId: prepareRunId,
    pullNumber: context.pullNumber,
    source,
    directory,
  });
  assertAcquiredPreparedNativeReleaseInputs(prepared);
  return { prepared, prepareRunId };
}

/** Project facts only; callers must acquire the actual successful Prepare producer. */
export function projectPreparedNativePublicationPlan(
  record: NativeReleaseInputRecord,
  source: NativeBuildSource,
  directory = ROOT,
) {
  parseNativeReleaseInputRecord(record);
  equal(source.tree, record.preparedSource.tree, 'native plan differs from the prepared tree');
  const read = (commit: string, file: string) =>
    JSON.parse(
      execFileSync('git', ['show', `${commit}:${file}`], {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  const config = read(source.commit, 'release-please-config.json');
  const after = read(source.commit, '.release-please-manifest.json');
  const products = releaseProductsFromManifests(
    config,
    read(record.bridge.source.commit, '.release-please-manifest.json'),
    after,
  );
  equal(products, record.selectedProducts, 'native plan differs from the actual RP scope');
  const versions = Object.fromEntries(
    products.map((id) => {
      const packagePath = Object.entries(config.packages).find(
        ([, entry]: [string, any]) => entry.component === id,
      )?.[0];
      assert.ok(packagePath, 'native publication owner has no conventional manifest path');
      const version = after[packagePath];
      assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
      return [id, version];
    }),
  );
  return {
    mode: 'release-bump',
    publicationSha: source.commit,
    releaseSha: source.commit,
    products,
    versions,
  };
}

export async function planNativePublicationFromPrepare(headRef = 'HEAD') {
  const source = sourceIdentity(headRef);
  const parent = requireSafeDirectoryChain(path.join(ROOT, 'target/native-publication'), {
    create: true,
  });
  const directory = mkdtempSync(path.join(parent, 'plan-'));
  const { prepared } = await acquireNativePublicationPreparation({
    source,
    directory: path.join(directory, 'prepared'),
  });
  return projectPreparedNativePublicationPlan(prepared.record, source);
}

export async function freezeNativePublicationFromRun({
  runId,
  prepareRunId,
  pullNumber,
  products,
  headRef = 'HEAD',
  output,
}: {
  runId: number;
  prepareRunId?: number;
  pullNumber?: number;
  products: string[];
  headRef?: string;
  output: string;
}) {
  const source = sourceIdentity(headRef);
  equal(sourceIdentity('HEAD'), source, 'native publication requires the exact source checkout');
  execFileSync(
    'bash',
    [path.join(ROOT, 'tools/release/qualified-release-replay.sh'), source.commit, source.commit],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const parent = requireSafeDirectoryChain(path.join(ROOT, 'target/native-publication'), {
    create: true,
  });
  const directory = mkdtempSync(path.join(parent, `${runId}-`));
  const preparation = await acquireNativePublicationPreparation({
    source,
    prepareRunId,
    pullNumber,
    directory: path.join(directory, 'prepared'),
  });
  const { prepared } = preparation;
  prepareRunId = preparation.prepareRunId;
  equal(
    [...products].sort(),
    prepared.record.selectedProducts,
    'requested native publication differs from actual RP versions',
  );
  const acquisition = await acquireNativePublicationBuilds({
    source,
    runId,
    directory: path.join(directory, 'producers'),
  });
  assertSuccessfulNativePublicationRun(acquisition.run, source);
  const artifactRoots: string[] = [];
  for (const origin of acquisition.origins.values()) {
    assertAuthenticatedNativeBuildOrigin(origin);
    assert.ok(
      origin.finalFiles && 'stage' in origin.finalFiles,
      'native publication has no retained public File transport',
    );
    artifactRoots.push(
      ...origin.finalFiles.stage({
        excludeRoles: [
          'github-release-asset',
          'github-release-metadata',
          ...NATIVE_EXTENSION_RELEASE_INPUT_ROLES,
        ],
        artifactPhase: 'pre-version',
      }),
    );
  }
  const families = stageNativeReleaseFamilies(
    acquisition.origins,
    source,
    path.join(directory, 'families'),
  );
  const complete = buildPublicationCandidate({
    products: loadPublicationCatalog('native complete publication').products.map(({ id }) => id),
    artifactRoots: [...artifactRoots, ...families],
    headRef: source.commit,
    artifactPhase: 'pre-version',
  });
  assertCompleteInventory(complete);
  const bazelVersion = readFileSync(path.join(ROOT, '.bazelversion'), 'utf8').trim();
  const observation = await observeAuthenticated(complete, acquisition, bazelVersion);
  // Stage only the selected public roots for publication. Full inventory staging
  // above is qualification scratch, never an implicit release selection.
  const selectedRoots: string[] = [];
  for (const origin of acquisition.origins.values()) {
    const observedProducts = new Set(
      origin.evidence.cohorts.flatMap((cohort) => cohort.roots.map((root) => root.package.product)),
    );
    const owned = products.filter((id) => observedProducts.has(id));
    if (!owned.length) continue;
    assert.ok(origin.finalFiles && 'stage' in origin.finalFiles);
    selectedRoots.push(
      ...origin.finalFiles.stage({
        products: owned,
        excludeRoles: [
          'github-release-asset',
          'github-release-metadata',
          ...NATIVE_EXTENSION_RELEASE_INPUT_ROLES,
        ],
      }),
    );
  }
  const selectedFamilies = stageNativeReleaseFamilies(
    acquisition.origins,
    source,
    path.join(directory, 'selected-families'),
    products,
  );
  const selected = buildPublicationCandidate({
    products,
    artifactRoots: [...selectedRoots, ...selectedFamilies],
    headRef: source.commit,
    swiftExtensionFixture: nativeSwiftFixtureRequest(complete, products).length > 0,
  });
  const selectedObservation = projectNativePublicationConstruction(
    { envelope: selected, files: lockedPublicationFiles(selected) },
    observation.authenticated,
  );
  const records = observedNativePublicationMetadata(
    {
      envelope: selected,
      files: lockedPublicationFiles(selected),
      repository,
      bazelVersion,
      builds: acquisition.builds,
      reviewedSource: source,
    },
    selectedObservation,
    publicationQualification(prepared, acquisition, complete),
  );
  await writeMetadataRecords(path.join(directory, 'metadata'), records);
  const candidate = buildPublicationCandidate({
    products,
    artifactRoots: [...selectedRoots, ...selectedFamilies, path.join(directory, 'metadata')],
    headRef: source.commit,
    nativeMetadataProducts: products,
    swiftExtensionFixture: nativeSwiftFixtureRequest(complete, products).length > 0,
  });
  const completed = await acquireObservedCompletedSuppliers(
    observation,
    path.join(directory, 'held'),
    JSON.parse(readFileSync(prepared.snapshotFile, 'utf8')).supplierArtifacts ?? [],
  );
  await admitNativePublicationCandidate({
    candidate,
    complete,
    prepared,
    acquisition,
    observation,
    completed,
  });
  const lock = await freezeNativePublicationCandidate(candidate);
  const destination = path.resolve(output);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native publication lock',
  });
  assert.ok(!existsSync(destination), 'native publication lock output already exists');
  writeFileSync(destination, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { lock, file: destination, runId, prepareRunId };
}

if (import.meta.main) {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      'run-id': { type: 'string' },
      'prepare-run-id': { type: 'string' },
      'pull-number': { type: 'string' },
      'products-json': { type: 'string' },
      'plan-publication': { type: 'boolean' },
      'github-output': { type: 'string' },
      'head-ref': { type: 'string', default: 'HEAD' },
      output: { type: 'string', default: 'target/release/publication-lock.json' },
    },
  });
  if (values['plan-publication']) {
    assert.ok(
      !['run-id', 'prepare-run-id', 'pull-number', 'products-json'].some((name) => values[name]),
      'native publication planning derives its authenticated Prepare scope',
    );
    const plan = await planNativePublicationFromPrepare(values['head-ref']);
    if (values['github-output'])
      appendFileSync(
        values['github-output'],
        [
          `mode=${plan.mode}`,
          `publication_sha=${plan.publicationSha}`,
          `release_sha=${plan.releaseSha}`,
          `products_json=${JSON.stringify(plan.products)}`,
          '',
        ].join('\n'),
      );
    console.log(JSON.stringify(plan));
    process.exit(0);
  }
  const id = (name: string, optional = false) => {
    if (optional && values[name] === undefined) return undefined;
    const value = Number(values[name]);
    assert.ok(Number.isSafeInteger(value) && value > 0, `native publication requires --${name}`);
    return value;
  };
  const products = JSON.parse(values['products-json'] ?? 'null');
  assert.ok(
    Array.isArray(products) &&
      products.length &&
      products.every((value) => typeof value === 'string'),
    'native publication requires --products-json',
  );
  const result = await freezeNativePublicationFromRun({
    runId: id('run-id'),
    prepareRunId: id('prepare-run-id', true),
    pullNumber: id('pull-number', true),
    products,
    headRef: values['head-ref'],
    output: values.output,
  });
  console.log(result.file);
}
