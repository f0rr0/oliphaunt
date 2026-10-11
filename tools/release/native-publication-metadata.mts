/** Prepared observations become authenticated public origins, never native admission. */
import { deepStrictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
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
import { ROOT } from './release-graph.mts';
import {
  prepareBundleVerification,
  readGhBundleVerification,
  requestReleaseAssetProof,
  verifyAttestationBundleSubject,
  writeImmutableReceipt,
} from './verify_github_release_attestations.mts';

const execute = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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
  return observation.products.map((product) =>
    validateNativePublicationMetadata({
      schema: NATIVE_PUBLICATION_METADATA_SCHEMA,
      scope: 'construction',
      repository: frozen.repository,
      source: frozen.envelope.source,
      ...product,
      // The separately attested control file never includes itself or a checksum
      // envelope. Existing producer checksums remain unchanged outside this file.
      productArtifacts: product.productArtifacts.filter(
        (artifact) => !['checksums', NATIVE_PUBLICATION_METADATA_KIND].includes(artifact.kind),
      ),
      builds: observation.authenticated.map(({ origin, qualification }) => ({
        github: origin.github,
        artifact: origin.artifact,
        evidenceDigest: origin.evidenceDigest,
        shippingAnalysis: qualification.shippingAnalysis,
        unverified: qualification.unverified,
        testQualification: qualification.testQualification,
        requiredTests: qualification.requiredTests,
      })),
      releaseDecision: 'unverified',
      unverified: limitations,
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
    publisherSha: string;
    bundlePaths: string[];
  },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompleted = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    verifyAttestation = authenticatePublicMetadataAttestation,
  } = {},
) {
  if (!/^[a-f0-9]{40}$/u.test(publisherSha))
    throw new Error('public native metadata requires exact publishing controller source');
  const completed = await assertCompleted(publication);
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
  const attestation = await verifyAttestation({
    file: absolute,
    artifact: { ...artifact, sha256, size: bytes.length },
    repository,
    publisherSha,
    bundlePaths,
  });
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
  return {
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
}
