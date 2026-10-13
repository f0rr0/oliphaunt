/** Prepared observations become authenticated public origins, never native admission. */
import { deepStrictEqual } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { reviewedNativeProducerUnknowns } from './authenticate-native-build-evidence.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import {
  NATIVE_PUBLICATION_METADATA_KIND,
  NATIVE_PUBLICATION_METADATA_MAX_BYTES,
  NATIVE_PUBLICATION_METADATA_SCHEMA,
  nativePublicationMetadataArtifactRow,
  validateNativePublicationMetadata,
} from './native-publication-metadata-contract.mts';
import { observeNativePublicationConstruction } from './native-publication-observation.mts';
import { captureNativeInputMembers } from './native-publication-staging.mts';
import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedPublicationFiles,
  sourceIdentity,
} from './publication-lock.mts';
import { ROOT } from './release-graph.mts';
import {
  prepareBundleVerification,
  readGhBundleVerification,
  releaseAttestationPublisherRequest,
  requestReleaseAssetProof,
  verifyAttestationBundleSubject,
  writeImmutableReceipt,
} from './verify_github_release_attestations.mts';

const execute = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const authenticatedBaselines = new WeakMap<object, { digest: string; unchanged: () => void }>();
export function assertAuthenticatedNativePublicBaseline(value: unknown) {
  if (!value || typeof value !== 'object' || !authenticatedBaselines.has(value))
    throw new Error('native seed baseline lacks its authenticated completed metadata origin');
  const proof = authenticatedBaselines.get(value)!;
  proof.unchanged();
  if (hash(Buffer.from(JSON.stringify(value))) !== proof.digest)
    throw new Error('authenticated completed native metadata facts changed');
  return value as Awaited<ReturnType<typeof readCompletedNativePublicBaseline>>;
}

/** Acquire the optional frozen inventory before interpreting an older release.
 * The default reader authenticates the original completed metadata object. */
export async function acquireCompletedNativeMetadataBaseline(
  {
    publication,
    directory,
    assets,
    metadataOrigin,
  }: {
    publication: CompletedPublication;
    directory: string;
    assets: readonly any[];
    metadataOrigin?: { publisherSha: string; bundlePaths: string[] };
  },
  {
    proveAsset = requestReleaseAssetProof,
    readBaseline = readCompletedNativePublicBaseline,
    baselineTransports = {} as Parameters<typeof readCompletedNativePublicBaseline>[1],
  } = {},
) {
  const artifact = nativePublicationMetadataArtifactRow({
    id: publication.product,
    version: publication.version,
  });
  const matching = assets.filter((asset) => asset.name === artifact.name);
  if (matching.length > 1) throw new Error('completed native metadata asset is ambiguous');
  if (!matching.length) return undefined;
  const asset = matching[0];
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    asset.state !== 'uploaded' ||
    asset.url !== `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${asset.id}` ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > NATIVE_PUBLICATION_METADATA_MAX_BYTES ||
    (asset.digest != null && !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))
  )
    throw new Error('completed native metadata asset identity differs');
  const file = path.join(directory, artifact.name);
  requireSafeDirectoryChain(path.dirname(file), {
    create: true,
    label: 'completed native metadata',
  });
  await proveAsset(asset.url, artifact.name, asset.size, {
    retainedPath: file,
    ...(asset.digest ? { expectedSha256: asset.digest.slice(7) } : {}),
  });
  const request = { publication, file, ...(metadataOrigin ?? {}) };
  const baseline =
    readBaseline === readCompletedNativePublicBaseline
      ? assertAuthenticatedNativePublicBaseline(await readBaseline(request))
      : await readBaseline(request, baselineTransports);
  return { baseline, file };
}
const limitations = [
  'immutable input lifetime from the producing build through content capture',
  'native action-graph dump bytes authenticated by the producing invocation',
  'loaded analysis and acquisition provenance for every consumed producer input',
  'qualified mapping from pre-envelope members to every delivered product contract',
  'complete migration inventory and product-specific mandatory qualification policy',
  'necessary delivery comparison against a prior admitted native baseline',
];

/** Input envelope/files are prevalidated together at their exact source. Initial origin authentication is mandatory. */
export async function prepareNativePublicationMetadata(
  input: Parameters<typeof observeNativePublicationConstruction>[0],
  transports: Parameters<typeof observeNativePublicationConstruction>[1] = {},
) {
  const frozen = structuredClone(input);
  const observation = await observeNativePublicationConstruction(frozen, transports);
  return observedNativePublicationMetadata(frozen, observation);
}

/** Describe a previously observed producer set without another acquisition or
 * graph validation. Descriptive metadata cannot grant publication authority. */
export function observedNativePublicationMetadata(
  input: Parameters<typeof observeNativePublicationConstruction>[0],
  observation: Awaited<ReturnType<typeof observeNativePublicationConstruction>>,
  publicationQualification?: Record<string, unknown>,
) {
  return observation.products.map((product) =>
    validateNativePublicationMetadata({
      schema: NATIVE_PUBLICATION_METADATA_SCHEMA,
      scope: 'construction',
      repository: input.repository,
      source: input.envelope.source,
      ...(publicationQualification === undefined ? {} : { publicationQualification }),
      ...product,
      // The separately attested control file never includes itself or a checksum
      // envelope. Existing producer checksums remain unchanged outside this file.
      productArtifacts: product.productArtifacts.filter(
        (artifact) => !['checksums', NATIVE_PUBLICATION_METADATA_KIND].includes(artifact.kind),
      ),
      builds: observation.authenticated.map(({ origin, qualification, producerAssurance }) => ({
        github: origin.github,
        artifact: origin.artifact,
        evidenceDigest: origin.evidenceDigest,
        shippingAnalysis: qualification.shippingAnalysis,
        unverified: qualification.unverified,
        testQualification: qualification.testQualification,
        requiredTests: qualification.requiredTests,
        ...(producerAssurance ? { producerAssurance } : {}),
      })),
      releaseDecision: 'unverified',
      unverified: observation.authenticated.every((build) => build.producerAssurance)
        ? reviewedNativeProducerUnknowns(limitations)
        : limitations,
    }),
  );
}

/** An executable writer consumed by the explicit inventory option; never a capsule extra. */
export async function writePreparedNativePublicationMetadata(
  directory: string,
  input: Parameters<typeof prepareNativePublicationMetadata>[0],
  transports: Parameters<typeof prepareNativePublicationMetadata>[1] = {},
) {
  const records = await prepareNativePublicationMetadata(input, transports);
  return writeMetadataRecords(directory, records);
}

export async function writeMetadataRecords(
  directory: string,
  records: ReturnType<typeof validateNativePublicationMetadata>[],
) {
  for (const record of records) {
    const size = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
    if (size > NATIVE_PUBLICATION_METADATA_MAX_BYTES)
      throw new Error(
        `${record.product.id} native metadata is ${size} bytes, exceeds ${NATIVE_PUBLICATION_METADATA_MAX_BYTES} bytes`,
      );
  }
  requireSafeDirectoryChain(path.resolve(directory), {
    create: true,
    label: 'native publication metadata',
  });
  const artifacts = [];
  for (const record of records) {
    const row = nativePublicationMetadataArtifactRow(record.product);
    const file = path.join(directory, row.name);
    await writeImmutableReceipt(file, record, {
      maximumBytes: NATIVE_PUBLICATION_METADATA_MAX_BYTES,
    });
    const bytes = readFileSync(file);
    artifacts.push({ ...row, path: file, sha256: hash(bytes), size: bytes.length });
  }
  return artifacts;
}

/** The executable controller opts in only at an exact, clean frozen-lock checkout. */
export async function runNativePublicationMetadataController(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      lock: { type: 'string' },
      builds: { type: 'string' },
      repository: { type: 'string' },
      'bazel-version': { type: 'string' },
      'output-directory': { type: 'string' },
      'head-ref': { type: 'string', default: 'HEAD' },
      'reviewed-source-ref': { type: 'string' },
    },
  });
  const required = (name: string) => {
    const value = values[name];
    if (!value) throw new Error(`native metadata controller requires --${name}`);
    return value;
  };
  const source = sourceIdentity(values['head-ref']);
  const assertCheckout = () => {
    try {
      execFileSync(
        'bash',
        [
          path.join(ROOT, 'tools/release/qualified-release-replay.sh'),
          source.commit,
          source.commit,
        ],
        { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (cause) {
      throw new Error('native metadata controller requires a frozen clean exact source checkout', {
        cause,
      });
    }
  };
  assertCheckout();
  const lockFile = required('lock');
  const lock = loadPublicationLock(lockFile);
  assertPublicationLockSource(lock, source.commit);
  const files = lockedPublicationFiles(lock);
  const reviewedSource =
    values['reviewed-source-ref'] === undefined
      ? undefined
      : sourceIdentity(values['reviewed-source-ref']);
  const records = await prepareNativePublicationMetadata({
    envelope: lock,
    files,
    repository: required('repository'),
    bazelVersion: required('bazel-version'),
    builds: JSON.parse(readFileSync(required('builds'), 'utf8')),
    ...(reviewedSource ? { reviewedSource } : {}),
  });
  const assertFrozen = () => {
    assertCheckout();
    deepStrictEqual(loadPublicationLock(lockFile), lock, 'native metadata frozen lock changed');
    deepStrictEqual(lockedPublicationFiles(lock), files, 'native metadata frozen files changed');
  };
  assertFrozen();
  const artifacts = await writeMetadataRecords(required('output-directory'), records);
  assertFrozen();
  return {
    artifacts,
    producerPolicy: reviewedSource ? 'reviewed-main' : 'observed',
    releaseDecision: 'unverified',
  };
}

async function authenticatePublicMetadataAttestation({
  file,
  artifact,
  repository,
  publisherSha,
  bundlePaths,
}) {
  if (!Array.isArray(bundlePaths) || bundlePaths.length !== 1)
    throw new Error('public native metadata requires exactly one signed bundle');
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-metadata-attestation-'));
  const context = {
    bundlePath: bundlePaths[0],
    file,
    name: artifact.name,
    sha256: artifact.sha256,
    repo: repository,
    publisherSha,
  };
  try {
    await verifyAttestationBundleSubject(context, {
      verifyBundleImpl: (options) => prepareBundleVerification(options, scratch),
    });
    await execute(
      'bash',
      [
        path.join(ROOT, 'tools/release/verify-github-release-attestations.sh'),
        '--verify-prepared',
        scratch,
      ],
      { cwd: ROOT, maxBuffer: 1024 * 1024 },
    );
    return await verifyAttestationBundleSubject(context, {
      verifyBundleImpl: (options) => readGhBundleVerification(options, scratch),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Public asset + canonical completion + release-workflow signature supersede an expiring Actions pointer. */
export async function readCompletedNativePublicBaseline(
  {
    publication,
    file,
    publisherSha,
    bundlePaths,
  }: {
    publication: CompletedPublication;
    file: string;
    publisherSha?: string;
    bundlePaths?: string[];
  },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompleted = undefined as ReturnType<typeof createCompletedPublicationChecker> | undefined,
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    verifyAttestation = authenticatePublicMetadataAttestation,
  } = {},
) {
  if (publisherSha !== undefined && !/^[a-f0-9]{40}$/u.test(publisherSha))
    throw new Error('public native metadata requires exact publishing controller source');
  if (Boolean(publisherSha) !== Boolean(bundlePaths))
    throw new Error('native metadata explicit publisher and bundles must be paired');
  const completed = await (assertCompleted ?? createCompletedPublicationChecker({ repository }))(
    publication,
  );
  deepStrictEqual(completed, publication, 'native metadata completion');
  const source = { commit: completed.publicationSha, tree: completed.publicationTree };
  const artifact = nativePublicationMetadataArtifactRow({
    id: completed.product,
    version: completed.version,
  });
  const absolute = path.resolve(file);
  requireSafeDirectoryChain(path.dirname(absolute), { label: 'public native metadata' });
  const stat = lstatSync(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > NATIVE_PUBLICATION_METADATA_MAX_BYTES ||
    path.basename(absolute) !== artifact.name
  )
    throw new Error('public native metadata must be its canonical bounded regular File');
  const capture = captureNativeInputMembers(path.dirname(absolute), path.basename(absolute));
  const bytes = readFileSync(absolute);
  const sha256 = hash(bytes);
  if (
    capture.members.length !== 1 ||
    capture.members[0].type !== 'file' ||
    capture.members[0].sha256 !== sha256 ||
    capture.members[0].size !== bytes.length
  )
    throw new Error('public native metadata bytes changed while captured');
  const release = await readJson(`repos/${repository}/releases/tags/${completed.tagName}`);
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== completed.tagName ||
    release.target_commitish !== source.commit ||
    release.draft !== false ||
    release.prerelease !== false
  )
    throw new Error('public native metadata release differs from completed source');
  const assets = await readPages(`repos/${repository}/releases/${release.id}/assets`);
  const matches = assets.filter((asset) => asset.name === artifact.name);
  if (matches.length !== 1) throw new Error('public native metadata asset is missing or ambiguous');
  const asset = matches[0];
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    asset.url !== `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` ||
    asset.state !== 'uploaded' ||
    asset.size !== bytes.length ||
    (asset.digest != null && !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))
  )
    throw new Error('public native metadata asset identity differs');
  const proof =
    asset.digest == null
      ? await proveAsset(asset.url, artifact.name, asset.size)
      : { bytes: asset.size, sha256: asset.digest.slice(7) };
  if (proof.bytes !== bytes.length || proof.sha256 !== sha256)
    throw new Error('public native metadata bytes differ from authenticated asset');
  let attestation;
  if (publisherSha) {
    attestation = await verifyAttestation({
      file: absolute,
      artifact: { ...artifact, sha256, size: bytes.length },
      repository,
      publisherSha,
      bundlePaths,
    });
  } else {
    const rows = await readPages(`repos/${repository}/attestations/sha256:${sha256}`, {
      itemsField: 'attestations',
      maxPages: 10,
    });
    const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-completed-metadata-bundles-'));
    const seen = new Set<string>();
    try {
      for (const row of rows) {
        let request;
        try {
          request = releaseAttestationPublisherRequest(row.bundle, {
            repo: repository,
            name: artifact.name,
            sha256,
          });
        } catch {
          continue;
        }
        if (!request) continue;
        const contents = Buffer.from(JSON.stringify(row.bundle));
        if (contents.length > 32 * 1024 * 1024)
          throw new Error('completed metadata attestation bundle exceeds bound');
        const digest = hash(contents);
        if (seen.has(digest)) continue;
        seen.add(digest);
        const bundle = path.join(scratch, `${digest}.json`);
        writeFileSync(bundle, contents, { flag: 'wx' });
        try {
          const verified = await verifyAttestation({
            file: absolute,
            artifact: { ...artifact, sha256, size: bytes.length },
            repository,
            publisherSha: request.publisherSha,
            bundlePaths: [bundle],
          });
          if (
            verified?.subjects?.filter(
              (subject) => subject.name === artifact.name && subject.sha256 === sha256,
            ).length !== 1
          )
            continue;
          attestation = verified;
          publisherSha = request.publisherSha;
          break;
        } catch {
          /* Unsigned lookup fields cannot replace an authenticated signer. */
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (
    !attestation ||
    !Array.isArray(attestation.subjects) ||
    attestation.subjects.filter(
      (subject) => subject.name === artifact.name && subject.sha256 === sha256,
    ).length !== 1
  )
    throw new Error('public native metadata has no authenticated exact attestation subject');
  const metadata = validateNativePublicationMetadata(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    { repository, source, product: { id: completed.product, version: completed.version } },
  );
  capture.assertUnchanged();
  const result = {
    scope: 'construction' as const,
    publication: completed,
    metadata,
    publicOrigin: {
      releaseId: release.id,
      assetId: asset.id,
      sha256,
      size: bytes.length,
      publisherSha,
      attestation,
    },
    baselineAdmission: 'unknown' as const,
    releaseDecision: 'unverified' as const,
  };
  if (
    assertCompleted === undefined &&
    readJson === requestGithubRepositoryJson &&
    readPages === requestGithubPages &&
    proveAsset === requestReleaseAssetProof &&
    verifyAttestation === authenticatePublicMetadataAttestation
  )
    authenticatedBaselines.set(result, {
      digest: hash(Buffer.from(JSON.stringify(result))),
      unchanged: capture.assertUnchanged,
    });
  return result;
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await runNativePublicationMetadataController())}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
