/** Post-publication observations, not release selection or native admission. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { authenticateNativeBuildEvidence } from './authenticate-native-build-evidence.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import {
  assertNativePublicationBuildPlan,
  type NativePublicationBuild,
  type NativePublicationFile,
  observeNativePublicationConstruction,
} from './native-publication-observation.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedPublicationFiles,
  PUBLICATION_LOCK_SCHEMA,
  sourceIdentity,
} from './publication-lock.mts';
import {
  validateLockedRegistryReceipts,
  verifyLockedRegistryIntegrity,
} from './registry-integrity.mts';
import {
  normalizeGithubReleaseSnapshot,
  queryLockedGithubReleases,
  writeImmutableReceipt,
} from './verify_github_release_attestations.mts';

export const COMPLETED_NATIVE_BASELINES_SCHEMA = 'oliphaunt-completed-native-product-baselines-v1';
type Row = Record<string, any>;
type Build = NativePublicationBuild;
type FrozenFile = NativePublicationFile;

function equal(actual: unknown, expected: unknown, context: string) {
  if (consumerDigest(actual) !== consumerDigest(expected)) throw new Error(`${context} mismatch`);
}

/**
 * The lock and concrete file list must already have been validated together at
 * the exact publication checkout/capsule. Do not rehydrate an old catalog from
 * today's checkout. The CLI performs that validation at the publication source.
 * Callbacks replace authenticated transports only in controlled fixture callers.
 */
export async function captureCompletedNativeProductBaselines(
  {
    publicationLock,
    publicationFiles,
    repository,
    bazelVersion,
    builds,
  }: {
    publicationLock: Row;
    publicationFiles: FrozenFile[];
    repository: string;
    bazelVersion: string;
    builds: Build[];
  },
  {
    authenticate = authenticateNativeBuildEvidence,
    assertCompleted = createCompletedPublicationChecker({ repository }),
    verifyRegistry = verifyLockedRegistryIntegrity,
    readGithubReleases = (lock: Row) => queryLockedGithubReleases(lock, { repo: repository }),
  } = {},
) {
  // Snapshot caller inputs before any remote reads; their digests remain those
  // of the approved frozen lock, including independent held requirements.
  const lock = structuredClone(publicationLock);
  const files = structuredClone(publicationFiles);
  const requestedBuilds = structuredClone(builds);
  if (
    lock.schema !== PUBLICATION_LOCK_SCHEMA ||
    lock.scope !== undefined ||
    Object.hasOwn(lock, 'nativePayloads')
  )
    throw new Error('completed native observations require a frozen publication lock');
  const { lockDigest, ...locked } = lock;
  equal(lockDigest, consumerDigest(locked), 'frozen publication lock digest');
  assertNativePublicationBuildPlan(requestedBuilds);
  const publications: CompletedPublication[] = [];
  for (const product of lock.products) {
    const publication = await assertCompleted({
      product: product.id,
      version: product.version,
      tagName: `${product.id}-v${product.version}`,
      publicationSha: lock.source.commit,
    });
    equal(
      {
        product: publication.product,
        version: publication.version,
        tagName: publication.tagName,
        source: { commit: publication.publicationSha, tree: publication.publicationTree },
      },
      {
        product: product.id,
        version: product.version,
        tagName: `${product.id}-v${product.version}`,
        source: lock.source,
      },
      'canonical completed publication',
    );
    publications.push(publication);
  }
  const observation = await observeNativePublicationConstruction(
    {
      envelope: lock,
      files,
      repository,
      bazelVersion,
      builds: requestedBuilds,
    },
    { authenticate },
  );
  const { authenticated, coverage } = observation;
  const products = observation.products.map((product) => ({
    ...product,
    publication: publications.find((publication) => publication.product === product.product.id),
  }));
  // Reuse the publication controller's byte-level registry and GitHub checks.
  // A tagged PR alone cannot authenticate an arbitrary caller-supplied lock.
  const receipts = await verifyRegistry(lock);
  validateLockedRegistryReceipts(lock, { receipts, receiptMode: 'sealed' });
  const releases = normalizeGithubReleaseSnapshot(lock, await readGithubReleases(lock));
  if (releases.some((release) => release.draft || release.prerelease))
    throw new Error('completed native observations require stable public releases');
  const record = {
    schema: COMPLETED_NATIVE_BASELINES_SCHEMA,
    scope: 'construction' as const,
    repository,
    source: lock.source,
    frozen: {
      lockDigest: lock.lockDigest,
      catalogDigest: lock.catalogDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    builds: authenticated.map(({ origin, qualification }) => ({
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      shippingAnalysis: qualification.shippingAnalysis,
      unverified: qualification.unverified,
      testQualification: qualification.testQualification,
      requiredTests: qualification.requiredTests,
    })),
    products,
    publication: { registryReceipts: receipts, githubReleases: releases },
    coverage: {
      completeFrozenInventory: coverage.completeProductInventory,
      completeMigrationInventory: 'unverified',
    },
    releaseDecision: 'unverified' as const,
    unverified: [
      'immutable input lifetime from the producing build through content capture',
      'qualified mapping from pre-envelope members to every delivered product contract',
      'complete migration inventory and product-specific mandatory qualification policy',
      'necessary delivery comparison against a prior admitted native baseline',
    ],
  };
  return { ...record, observationDigest: consumerDigest(record) };
}

/** Publishing the observation file is allowed only after capture has checked completion. */
export async function recordCompletedNativeProductBaselines(
  file: string,
  input: Parameters<typeof captureCompletedNativeProductBaselines>[0],
  transports: Parameters<typeof captureCompletedNativeProductBaselines>[1] = {},
) {
  const record = await captureCompletedNativeProductBaselines(input, transports);
  requireSafeDirectoryChain(path.dirname(path.resolve(file)), {
    create: true,
    label: 'completed native observations',
  });
  await writeImmutableReceipt(file, record);
  return record;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        lock: { type: 'string' },
        builds: { type: 'string' },
        repository: { type: 'string' },
        'bazel-version': { type: 'string' },
        output: { type: 'string' },
        'head-ref': { type: 'string', default: 'HEAD' },
      },
      allowPositionals: false,
    });
    const required = (name: string) => {
      if (!values[name]) throw new Error(`completed native observations require --${name}`);
      return values[name] as string;
    };
    // Execute under with-source.sh at the immutable publication checkout. Later
    // readers use the captured frozen facts, not current catalog reconstruction.
    const source = sourceIdentity(values['head-ref']);
    const snapshot = JSON.parse(process.env.OLIPHAUNT_GIT_SOURCE_JSON || '{}');
    if (snapshot.checkout !== source.commit)
      throw new Error(
        'completed native CLI must validate the lock at its exact publication checkout',
      );
    execFileSync('bash', [
      path.resolve(import.meta.dir, 'qualified-release-replay.sh'),
      source.commit,
      source.commit,
    ]);
    const lock = loadPublicationLock(required('lock'));
    assertPublicationLockSource(lock, values['head-ref']);
    const record = await recordCompletedNativeProductBaselines(required('output'), {
      publicationLock: lock,
      publicationFiles: lockedPublicationFiles(lock),
      repository: required('repository'),
      bazelVersion: required('bazel-version'),
      builds: JSON.parse(readFileSync(required('builds'), 'utf8')),
    });
    process.stdout.write(
      `${JSON.stringify({ products: record.products.map(({ product }) => product.id), observationDigest: record.observationDigest, baselineAdmission: 'unknown' })}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
