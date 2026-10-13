/** Authenticate construction evidence through the existing Actions artifact transport. */

import { deepStrictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { matchesGithubWorkflowRef } from './github-read.mts';
import { readNativeBuildFinalFiles } from './native-build-files.mts';
import {
  assertNativeBuildGithub,
  type NativeBuildEvidence,
  type NativeBuildGithub,
  type NativeBuildSource,
  type NativeRequiredTest,
  nativeBuildMetadata,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';

const execute = promisify(execFile);
const authenticatedOrigins = new WeakSet<object>();
function freezeAuthenticated(value: any) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeAuthenticated(child);
    Object.freeze(value);
  }
  return value;
}
/** This capability is minted by actual GitHub/ZIP acquisition, never JSON parsing. */
export function assertAuthenticatedNativeBuildOrigin(value: unknown) {
  if (!value || typeof value !== 'object' || !authenticatedOrigins.has(value))
    throw new Error('native origin was not acquired through the authenticated producer transport');
  const origin = value as Awaited<ReturnType<typeof acquireAuthenticatedNativeBuildEvidence>>;
  origin.finalFiles?.assertUnchanged?.();
  return origin;
}
const reviewedProducerArtifacts: readonly (readonly [string, string])[] = [
  ['Linux runtime (x86_64)', 'native-build-evidence-x86_64'],
  ['Linux runtime (aarch64)', 'native-build-evidence-aarch64'],
  ['Portable packages (macos-arm64)', 'native-build-evidence-native-macos-arm64'],
  ['Portable packages (windows-x64)', 'native-build-evidence-native-windows-x64'],
  ['Linux WASIX and installed browser', 'native-build-evidence-wasix-tools'],
  ['Linux native postmaster lifecycle', 'native-build-evidence-postmaster-linux'],
  ['Native postmaster lifecycle (linux-arm64)', 'native-build-evidence-postmaster-linux-arm64'],
  ['Native postmaster lifecycle (macos-arm64)', 'native-build-evidence-postmaster-macos-arm64'],
  ['Portable packages (linux-x64)', 'native-build-evidence-napi-linux-x64'],
  ['Portable packages (linux-arm64)', 'native-build-evidence-napi-linux-arm64'],
  ['Portable packages (macos-arm64)', 'native-build-evidence-napi-macos-arm64'],
  ['Portable packages (windows-x64)', 'native-build-evidence-napi-windows-x64'],
  ['Linux runtime (x86_64)', 'native-build-evidence-mobile-android'],
  ['Portable packages (macos-arm64)', 'native-build-evidence-mobile-ios'],
  ['Native React Native consumers', 'native-build-evidence-react-native-macos-arm64'],
  ['Native release families', 'native-build-evidence-release-families'],
];
const isReviewedProducerArtifact = (job: string, artifact: unknown) =>
  reviewedProducerArtifacts.some(([owner, name]) => owner === job && name === artifact);
export function reviewedNativeProducerArtifacts() {
  return reviewedProducerArtifacts.map(([job, artifactName]) => ({ job, artifactName }));
}
const acceptedExecutionAssumptions = [
  'producer inputs remained immutable through capture in the reviewed isolated job',
  'the reviewed coordinator retained the native after-build dump from its producer invocation',
];
const scopedExecutionAssumptions = [
  acceptedExecutionAssumptions[0],
  'the reviewed coordinator retained each native action graph from its producing build or corresponding scoped analysis in the same immutable producer window',
];

/** Shape validation does not authenticate JSON; its public use requires the signed metadata origin. */
export function validateReviewedNativeProducerAssurance(
  value: any,
  expected: {
    source: NativeBuildSource;
    github?: NativeBuildGithub;
    artifact?: unknown;
    evidenceDigest?: string;
    requiredTests?: unknown;
  },
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('reviewed native producer assurance must be an object');
  deepStrictEqual(
    Object.keys(value).sort(),
    [
      'acceptedExecutionAssumptions',
      'artifact',
      'event',
      'evidenceDigest',
      'github',
      'ref',
      'requiredTests',
      'reviewedSource',
      'scope',
      'shippingAnalysis',
      'testQualification',
    ].sort(),
    'reviewed native producer assurance fields',
  );
  nativeBuildMetadata(value.reviewedSource, value.github);
  deepStrictEqual(value.reviewedSource, expected.source, 'reviewed native producer source');
  if (
    value.scope !== 'reviewed-producer-assurance' ||
    !['push', 'workflow_dispatch'].includes(value.event) ||
    value.ref !== 'refs/heads/main' ||
    value.github.repository !== 'f0rr0/oliphaunt' ||
    value.github.workflow !== 'Native Bazel qualification' ||
    value.github.workflowPath !== '.github/workflows/bazel.yml' ||
    !isReviewedProducerArtifact(value.github.job, value.artifact?.name) ||
    value.shippingAnalysis !== 'bound' ||
    value.testQualification !== 'passed' ||
    !Array.isArray(value.requiredTests) ||
    !value.requiredTests.length ||
    !Number.isSafeInteger(value.artifact?.id) ||
    value.artifact.id < 1 ||
    !Number.isSafeInteger(value.artifact?.size) ||
    value.artifact.size < 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.artifact?.digest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.evidenceDigest)
  )
    throw new Error('reviewed native producer assurance identity is invalid');
  for (const test of value.requiredTests)
    if (
      typeof test.label !== 'string' ||
      !test.label.startsWith('//') ||
      !/^[0-9a-f]{64}$/u.test(test.configuration)
    )
      throw new Error('reviewed native producer assurance requires exact configured tests');
  if (
    ![acceptedExecutionAssumptions, scopedExecutionAssumptions].some((assumptions) =>
      isDeepStrictEqual(value.acceptedExecutionAssumptions, assumptions),
    )
  )
    throw new Error('reviewed native producer execution assumptions differ');
  for (const key of ['github', 'artifact', 'evidenceDigest', 'requiredTests'] as const)
    if (expected[key] !== undefined)
      deepStrictEqual(value[key], expected[key], `reviewed native producer ${key}`);
  return value;
}

/** Only an authenticated reviewed producer closes these execution premises. */
export function reviewedNativeProducerUnknowns(unverified: string[]) {
  return unverified.filter(
    (check) =>
      ![
        'authenticated producing workflow, attempt, job and immutable artifact',
        'immutable input lifetime from the producing build through content capture',
        'native action-graph dump bytes authenticated by the producing invocation',
      ].includes(check),
  );
}

/** Caller expectations are constraints; only the downloader's GitHub API reads supply origin metadata. */
type NativeBuildOriginExpectation = {
  source: NativeBuildSource;
  github: NativeBuildGithub;
  event: 'push' | 'pull_request' | 'workflow_dispatch' | 'merge_group';
  ref: string;
  artifactName: string;
};

export function authenticateNativeBuildEvidence(
  evidenceRoot: string,
  expected: NativeBuildOriginExpectation,
) {
  return readAuthenticatedNativeBuildEvidence(evidenceRoot, expected);
}

/** Acquire once into an owned directory; observation can reuse this authenticated origin. */
export function acquireAuthenticatedNativeBuildEvidence(
  directory: string,
  expected: NativeBuildOriginExpectation,
) {
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native evidence acquisition',
  });
  if (existsSync(destination))
    throw new Error('native evidence acquisition requires a new owned directory');
  return readAuthenticatedNativeBuildEvidence(undefined, expected, destination);
}

/** A controller-owned metadata snapshot is shared across one finite acquisition.
 * No caller path or inherited cache can supply origin facts to this session.
 */
export function createNativeBuildEvidenceAcquirer() {
  const owner = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-acquisition-'));
  let closed = false;
  return {
    acquire(directory: string, expected: NativeBuildOriginExpectation) {
      if (closed) throw new Error('native evidence acquisition session is closed');
      const destination = path.resolve(directory);
      requireSafeDirectoryChain(path.dirname(destination), {
        create: true,
        label: 'native evidence acquisition',
      });
      if (existsSync(destination))
        throw new Error('native evidence acquisition requires a new owned directory');
      return readAuthenticatedNativeBuildEvidence(
        undefined,
        expected,
        destination,
        path.join(owner, 'snapshots'),
      );
    },
    dispose() {
      closed = true;
      rmSync(owner, { recursive: true, force: true });
    },
  };
}

async function readAuthenticatedNativeBuildEvidence(
  evidenceRoot: string | undefined,
  expected: NativeBuildOriginExpectation,
  retainedRoot?: string,
  snapshotDirectory?: string,
) {
  assertNativeBuildGithub(expected.github);
  if (![expected.source.commit, expected.source.tree].every((sha) => /^[0-9a-f]{40}$/u.test(sha)))
    throw new Error('native origin requires exact source commit and tree');
  if (
    expected.github.workflow !== 'Native Bazel qualification' ||
    expected.github.workflowPath !== '.github/workflows/bazel.yml'
  )
    throw new Error('native origin requires the canonical Native Bazel qualification workflow');
  if (!matchesGithubWorkflowRef(expected.event, expected.ref))
    throw new Error('native origin requires an eligible exact workflow event and ref');
  if (!/^[A-Za-z0-9_.-]+$/u.test(expected.artifactName))
    throw new Error('native origin artifact name is invalid');
  let bytes: Buffer | undefined;
  if (evidenceRoot !== undefined) {
    const file = path.join(path.resolve(evidenceRoot), 'native-build-evidence.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('native origin evidence must be a regular file');
    bytes = readFileSync(file);
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-origin-'));
  try {
    // This cache is created by this controller, never restored from evidence or inherited from a caller.
    const snapshots = snapshotDirectory ?? path.join(scratch, 'snapshots');
    const downloaded = path.join(scratch, 'downloaded');
    const repositoryRoot = path.resolve(import.meta.dir, '../..');
    await execute(
      'bash',
      [
        path.join(repositoryRoot, '.github/scripts/download-build-artifacts.sh'),
        expected.github.workflow,
        expected.source.commit,
        downloaded,
        '--run-id',
        String(expected.github.runId),
        '--job',
        expected.github.job,
        '--job-success-only',
        '--workflow-path',
        expected.github.workflowPath,
        '--event',
        expected.event,
        '--ref',
        expected.ref,
        '--run-attempt',
        String(expected.github.runAttempt),
        '--source-tree',
        expected.source.tree,
        '--artifact',
        expected.artifactName,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GH_REPO: expected.github.repository,
          OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: snapshots,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    const downloadedBytes = readFileSync(path.join(downloaded, 'native-build-evidence.json'));
    if (bytes && !bytes.equals(downloadedBytes))
      throw new Error(
        'native build evidence bytes differ from the authenticated immutable artifact',
      );
    bytes ??= downloadedBytes;
    if (retainedRoot !== undefined) {
      cpSync(downloaded, retainedRoot, { recursive: true, errorOnExist: true, force: false });
      evidenceRoot = retainedRoot;
    }
    if (evidenceRoot === undefined)
      throw new Error('native authenticated files require owned storage');
    const snapshot = JSON.parse(
      readFileSync(path.join(snapshots, `run-${expected.github.runId}.json`), 'utf8'),
    );
    const artifact = snapshot.artifacts.find(
      (row) => row.name === expected.artifactName && row.expired === false,
    );
    const job = snapshot.jobs.find((row) => row.name === expected.github.job);
    const evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const hasFiles = (directory: string) => existsSync(path.join(directory, 'files'));
    if (hasFiles(evidenceRoot) !== hasFiles(downloaded))
      throw new Error('local and authenticated native final file transport differ');
    // Transport uses the authenticated producing packet's protocol version.
    // Qualification callers still supply their independently expected source pin.
    const producingBazelVersion = evidence.cohorts?.[0]?.buildEvents?.find(
      (event) => event.started !== undefined,
    )?.started?.buildToolVersion;
    const finalFiles = hasFiles(downloaded)
      ? readNativeBuildFinalFiles(evidenceRoot, evidence, {
          source: expected.source,
          github: expected.github,
          bazelVersion: producingBazelVersion,
        })
      : undefined;
    if (finalFiles) {
      const downloadedFiles = readNativeBuildFinalFiles(downloaded, evidence, {
        source: expected.source,
        github: expected.github,
        bazelVersion: producingBazelVersion,
      });
      deepStrictEqual(finalFiles.files, downloadedFiles.files, 'authenticated native final files');
      finalFiles.assertUnchanged?.();
    }
    const origin = {
      github: {
        repository: snapshot.repo,
        workflow: snapshot.workflowName,
        workflowPath: snapshot.workflowPath,
        runId: Number(snapshot.runId),
        runAttempt: snapshot.runAttempt,
        job: job.name,
      } as NativeBuildGithub,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        size: artifact.size_in_bytes,
      },
      evidenceDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      // Parsing transports the authenticated bytes; the content validator still owns qualification.
      evidence: evidence as unknown,
      ...(finalFiles === undefined ? {} : { finalFiles }),
    };
    freezeAuthenticated(origin);
    authenticatedOrigins.add(origin);
    return origin;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Controller-owned source review accepts the isolated producer's execution discipline. */
export async function assureReviewedNativeBuildProducer(
  evidenceRoot: string,
  {
    expected,
    reviewedSource,
    bazelVersion,
    requiredTests,
  }: {
    expected: Parameters<typeof authenticateNativeBuildEvidence>[1];
    reviewedSource: NativeBuildSource;
    bazelVersion: string;
    requiredTests: NativeRequiredTest[];
  },
  // Transport injection is for controlled synthetic fixtures; production uses the authenticated downloader.
  { authenticate = authenticateNativeBuildEvidence } = {},
) {
  const metadata = nativeBuildMetadata(reviewedSource, expected.github);
  const expectedMetadata = nativeBuildMetadata(expected.source, expected.github);
  if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata))
    throw new Error('reviewed native producer source differs from the frozen build source');
  if (
    !['push', 'workflow_dispatch'].includes(expected.event) ||
    expected.ref !== 'refs/heads/main' ||
    expected.github.repository !== 'f0rr0/oliphaunt' ||
    expected.github.workflow !== 'Native Bazel qualification' ||
    expected.github.workflowPath !== '.github/workflows/bazel.yml'
  )
    throw new Error('reviewed native producer requires the canonical main workflow');
  if (!isReviewedProducerArtifact(expected.github.job, expected.artifactName))
    throw new Error('reviewed native producer job/artifact role is not canonical');
  if (!Array.isArray(requiredTests) || !requiredTests.length)
    throw new Error('reviewed native producer requires controller-owned mandatory tests');
  const origin = await authenticate(evidenceRoot, expected);
  if (
    JSON.stringify(nativeBuildMetadata(reviewedSource, origin.github)) !==
      JSON.stringify(metadata) ||
    origin.artifact.name !== expected.artifactName ||
    !Number.isSafeInteger(origin.artifact.id) ||
    origin.artifact.id < 1 ||
    !Number.isSafeInteger(origin.artifact.size) ||
    origin.artifact.size < 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(origin.artifact.digest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(origin.evidenceDigest)
  )
    throw new Error('reviewed native producer authenticated origin is inconsistent');
  const qualification = validateNativeBuildEvidence(origin.evidence, {
    source: reviewedSource,
    github: expected.github,
    bazelVersion,
    requiredTests,
    requireShippingAnalysis: true,
  });
  return {
    origin,
    qualification,
    assurance: validateReviewedNativeProducerAssurance(
      {
        scope: 'reviewed-producer-assurance' as const,
        reviewedSource: structuredClone(reviewedSource),
        event: expected.event,
        ref: expected.ref,
        github: structuredClone(origin.github),
        artifact: structuredClone(origin.artifact),
        evidenceDigest: origin.evidenceDigest,
        shippingAnalysis: qualification.shippingAnalysis,
        testQualification: qualification.testQualification,
        requiredTests: qualification.requiredTests,
        acceptedExecutionAssumptions: [
          ...((origin.evidence as NativeBuildEvidence).cohorts.some(
            (cohort) => cohort.producerCapture?.aqueryBuildEvents !== undefined,
          )
            ? scopedExecutionAssumptions
            : acceptedExecutionAssumptions),
        ],
      },
      { source: reviewedSource },
    ),
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        [
          'source-commit',
          'source-tree',
          'github-json',
          'event',
          'ref',
          'artifact-name',
          'evidence-root',
        ].map((name) => [name, { type: 'string' as const }]),
      ),
      allowPositionals: false,
    });
    const required = (key: string) => {
      const value = values[key];
      if (typeof value !== 'string' || !value)
        throw new Error(`native origin authentication requires --${key}`);
      return value;
    };
    const { evidence: _, ...origin } = await authenticateNativeBuildEvidence(
      required('evidence-root'),
      {
        source: { commit: required('source-commit'), tree: required('source-tree') },
        github: JSON.parse(readFileSync(required('github-json'), 'utf8')),
        event: required('event') as NativeBuildOriginExpectation['event'],
        ref: required('ref'),
        artifactName: required('artifact-name'),
      },
    );
    process.stdout.write(`${JSON.stringify(origin)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
