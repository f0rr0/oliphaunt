/** Post-publication observations, not release selection or native admission. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type CoverageAuthority, checkShippingCoverage } from '../bazel/shipping-coverage.mts';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { authenticateNativeBuildEvidence } from './authenticate-native-build-evidence.mts';
import { buildShippingInputView } from './bazel-shipping-inputs.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import {
  type NativeBuildEvidence,
  type NativeRequiredTest,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import type { NativeRoot } from './native-publication-artifacts.mts';
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
type Build = {
  evidenceRoot: string;
  expected: Parameters<typeof authenticateNativeBuildEvidence>[1];
  requiredTests: NativeRequiredTest[];
};
type FrozenFile = { path: string; sha256: string; size: number };

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
  if (!requestedBuilds.length)
    throw new Error('completed native observations require authenticated builds');
  if (
    requestedBuilds.some(
      (build) => !Array.isArray(build.requiredTests) || !build.requiredTests.length,
    )
  )
    throw new Error(
      'completed native observations require an explicit nonempty configured test plan for every build',
    );
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
  const authenticated = [];
  for (const build of requestedBuilds) {
    equal(build.expected.source, lock.source, 'native build/frozen source');
    equal(build.expected.github.repository, repository, 'native build repository');
    const origin = await authenticate(build.evidenceRoot, build.expected);
    const qualification = validateNativeBuildEvidence(origin.evidence, {
      source: lock.source,
      github: build.expected.github,
      bazelVersion,
      requiredTests: build.requiredTests,
    });
    if (qualification.testQualification !== 'passed')
      throw new Error('completed native observations require successful configured tests');
    equal(origin.github, qualification.github, 'authenticated native build origin');
    authenticated.push({ origin, qualification, evidence: origin.evidence as NativeBuildEvidence });
  }
  const cohorts = authenticated.flatMap(({ evidence }) => evidence.cohorts);
  const authority: CoverageAuthority = {
    catalog: {
      schema: lock.catalogSchema,
      products: lock.products,
      carriers: lock.carriers.filter((carrier) => carrier.declared),
    },
    artifactRows: lock.productArtifacts.map((artifact) => ({
      ...artifact,
      version: lock.products.find((product) => product.id === artifact.product).version,
    })),
    resolveCarrier: (ecosystem, name) => {
      const carrier = lock.carriers.find((row) => row.id === `${ecosystem}:${name}`);
      if (!carrier) throw new Error(`carrier absent from frozen publication: ${ecosystem}:${name}`);
      return carrier;
    },
  };
  const coverage = checkShippingCoverage(authority, cohorts, { includeReleaseInputs: true });
  const capturedFiles = (root: NativeRoot, cohort: NativeBuildEvidence['cohorts'][number]) =>
    root.package.outputs.flatMap((output) => {
      const capture = cohort.outputs.find((capture) => capture.path === output.path);
      if (!capture) throw new Error(`missing qualified output capture: ${output.path}`);
      return capture.members
        .filter((member) => member.type === 'file')
        .map((member) => ({
          ...member,
          path: member.path ? `${output.path}/${member.path}` : output.path,
        }));
    });
  const bind = (artifact: Row, product: string, roots: { root: NativeRoot; cohort: any }[]) => {
    const concrete = files.filter(
      (file) => file.path === artifact.path || file.path.startsWith(`${artifact.path}/`),
    );
    if (!concrete.length)
      throw new Error(`missing frozen concrete files: ${product}/${artifact.path}`);
    if (concrete[0].path === artifact.path) {
      equal(
        concrete,
        [{ path: artifact.path, sha256: artifact.sha256, size: artifact.size }],
        'frozen file envelope',
      );
    } else if (concrete.reduce((size, file) => size + file.size, 0) !== artifact.size) {
      throw new Error(`incomplete frozen directory file list: ${product}/${artifact.path}`);
    }
    return concrete.map((file) => {
      const suffix =
        file.path === artifact.path
          ? path.posix.basename(file.path)
          : file.path.slice(artifact.path.length + 1);
      const matches = roots.flatMap(({ root, cohort }) =>
        capturedFiles(root, cohort)
          .filter(
            (member) =>
              (file.path === artifact.path
                ? path.posix.basename(member.path) === suffix
                : root.package.outputs.some(
                    (output) => member.path === `${output.path}/${suffix}`,
                  )) &&
              member.sha256 === file.sha256 &&
              member.size === file.size,
          )
          .map((member) => ({
            label: root.label,
            path: member.path,
            sha256: member.sha256,
            size: member.size,
          })),
      );
      if (matches.length !== 1)
        throw new Error(`frozen file needs one qualified output: ${product}/${file.path}`);
      return { frozenPath: file.path, ...matches[0] };
    });
  };
  const products = lock.products.map((product) => {
    const roots = cohorts.flatMap((cohort) =>
      cohort.roots
        .filter((root) => root.package.product === product.id)
        .map((root) => ({ root, cohort })),
    );
    const carriers = lock.carriers
      .filter((carrier) => carrier.product === product.id)
      .map((carrier) => {
        const carrierRoots = roots.filter(
          ({ root }) =>
            `${root.package.ecosystem}:${root.package.name}` ===
            (carrier.parentCarrier ?? carrier.id),
        );
        return {
          ...carrier,
          qualifiedFiles: carrier.artifacts.flatMap((artifact) =>
            bind(artifact, product.id, carrierRoots),
          ),
        };
      });
    const productArtifacts = lock.productArtifacts
      .filter((artifact) => artifact.product === product.id)
      .map((artifact) => ({
        ...artifact,
        qualifiedFiles: bind(
          artifact,
          product.id,
          roots.filter(
            ({ root }) =>
              root.package.name === artifact.name && root.package.role === artifact.role,
          ),
        ),
      }));
    const construction = authenticated.flatMap(({ origin, evidence, qualification }) =>
      evidence.cohorts.flatMap((cohort, index) => {
        const selectedRoots = cohort.roots.filter((root) => root.package.product === product.id);
        if (!selectedRoots.length) return [];
        const view = buildShippingInputView(
          {
            schema: 'oliphaunt-bazel-shipping-v1',
            scope: 'construction',
            packages: selectedRoots.map((root) => root.package),
          },
          cohort.aquery,
        );
        const needed = new Set(view.physicalInputs);
        return [
          {
            evidenceDigest: origin.evidenceDigest,
            invocationId: qualification.cohorts[index].invocationId,
            roots: qualification.cohorts[index].roots.filter(
              (root) => root.package.product === product.id,
            ),
            actions: view.products[product.id].actions,
            inputs: cohort.inputs.filter((input) => needed.has(input.path)),
          },
        ];
      }),
    );
    return {
      product: structuredClone(product),
      publication: publications.find((publication) => publication.product === product.id),
      carriers,
      productArtifacts,
      construction,
      preEnvelopeCapture: roots.some(({ root }) => root.package.ecosystem === 'internal')
        ? 'observed'
        : 'absent',
      baselineAdmission: 'unknown' as const,
    };
  });
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
