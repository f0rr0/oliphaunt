import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createCapturedPublishedNativeLegalSourceBasis,
  nativeBaseLegalForSource,
} from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import { validateFrozenNativeCarrierIdentity } from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';

const member = 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json';
const fullSha = /^[a-f0-9]{40}$/u;
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function frozenNativeCarrierSource(source) {
  const keys = [
    'repository',
    'source_tag',
    'source_commit',
    'source_tree',
    'source_member',
    'source_blob',
    'sha256',
    'bytes',
  ];
  if (
    !source ||
    JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(keys.sort()) ||
    source.repository !== 'f0rr0/oliphaunt' ||
    !stableVersion.test(source.source_tag) ||
    ![source.source_commit, source.source_tree, source.source_blob].every((sha) =>
      fullSha.test(sha),
    ) ||
    source.source_member !== member ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes <= 0 ||
    source.bytes > 1024 * 1024
  )
    throw new Error('frozen native carrier requires exact immutable published source facts');
  return `https://raw.githubusercontent.com/${source.repository}/${source.source_commit}/${source.source_member}`;
}

export function readFrozenNativeCarrier({
  source,
  carrierBytes,
  expectedVersion,
  assetDirectory,
  publicationContext,
}) {
  frozenNativeCarrierSource(source);
  const blob = createHash('sha1')
    .update(`blob ${carrierBytes.byteLength}\0`)
    .update(carrierBytes)
    .digest('hex');
  if (
    carrierBytes.byteLength !== source.bytes ||
    digest(carrierBytes) !== source.sha256 ||
    blob !== source.source_blob
  )
    throw new Error('frozen native carrier bytes differ from the immutable source member');
  if (!stableVersion.test(expectedVersion))
    throw new Error('native compatibility input must contain one stable version');
  // These are externally checked acquisition inputs, not receipts minted by
  // this converter. Bind the downloaded member to the captured source parent,
  // blob and native release inventory before deriving its historical policy.
  const { nativeCompletion, nativeReleases, swiftSource } = publicationContext ?? {};
  if (
    !Array.isArray(nativeReleases) ||
    nativeReleases.length !== 1 ||
    nativeCompletion?.version !== expectedVersion ||
    nativeReleases[0].product !== nativeCompletion.product ||
    nativeReleases[0].version !== nativeCompletion.version ||
    !Array.isArray(nativeReleases[0].assets) ||
    swiftSource?.publication?.version !== source.source_tag ||
    swiftSource.reference?.object?.sha !== source.source_commit ||
    swiftSource.commit?.sha !== source.source_commit ||
    swiftSource.commit?.tree?.sha !== source.source_tree ||
    swiftSource.member?.path !== source.source_member ||
    swiftSource.member?.sha !== source.source_blob
  )
    throw new Error('frozen native carrier requires matching authenticated publication context');
  const release = nativeReleases[0];
  const sourceBasis = createCapturedPublishedNativeLegalSourceBasis({
    publication: nativeCompletion,
    nativeRelease: {
      id: release.releaseId,
      tag_name: release.tag,
      target_commitish: release.targetCommitish,
      draft: release.draft,
      prerelease: release.prerelease,
    },
    sourcePublication: swiftSource.publication,
    sourceReference: swiftSource.reference,
    sourceCommit: swiftSource.commit,
    carrierContents: {
      path: swiftSource.member.path,
      type: 'file',
      encoding: 'base64',
      sha: swiftSource.member.sha,
      content: carrierBytes.toString('base64'),
    },
    nativeAssets: release.assets.map((asset) => ({
      id: asset.assetId,
      name: asset.name,
      browser_download_url: `https://github.com/f0rr0/oliphaunt/releases/download/${release.tag}/${asset.name}`,
      digest: `sha256:${asset.sha256}`,
      size: asset.size,
    })),
  });
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(carrierBytes));
  const carrier = validateFrozenNativeCarrierIdentity({
    carrier: document,
    expectedNativeVersion: expectedVersion,
    expectedBaseLegal: nativeBaseLegalForSource({
      base: document.base,
      sourceBasis,
      currentLegal: () => {
        throw new Error('held native acquisition cannot consult current legal policy');
      },
    }),
  });
  if (assetDirectory)
    for (const asset of carrier.base.assets) {
      const bytes = readFileSync(path.join(assetDirectory, asset.name));
      if (bytes.byteLength !== asset.bytes || digest(bytes) !== asset.sha256)
        throw new Error(
          `published native asset bytes differ from the frozen carrier: ${asset.name}`,
        );
    }
  return carrier;
}

if (import.meta.main) {
  const [
    sourceFile,
    carrierFile,
    versionFile,
    outputFile,
    nativeReleasesFile,
    nativeCompletionFile,
    sourcePublicationFile,
    assetDirectory,
  ] = process.argv.slice(2);
  if (sourceFile && !carrierFile) {
    console.log(frozenNativeCarrierSource(JSON.parse(readFileSync(sourceFile, 'utf8'))));
    process.exit(0);
  }
  if (
    !sourceFile ||
    !carrierFile ||
    !versionFile ||
    !outputFile ||
    !nativeReleasesFile ||
    !nativeCompletionFile ||
    !sourcePublicationFile ||
    process.argv.length > 10
  )
    throw new Error(
      'usage: frozen-native-carrier.mts SOURCE CARRIER COMPATIBILITY_VERSION OUTPUT NATIVE_RELEASES NATIVE_COMPLETION SOURCE_PUBLICATION [ASSET_DIRECTORY]',
    );
  const carrier = readFrozenNativeCarrier({
    source: JSON.parse(readFileSync(sourceFile, 'utf8')),
    carrierBytes: readFileSync(carrierFile),
    expectedVersion: readFileSync(versionFile, 'utf8').trim(),
    publicationContext: {
      nativeReleases: JSON.parse(readFileSync(nativeReleasesFile, 'utf8')),
      nativeCompletion: JSON.parse(readFileSync(nativeCompletionFile, 'utf8')),
      swiftSource: JSON.parse(readFileSync(sourcePublicationFile, 'utf8')),
    },
    assetDirectory,
  });
  writeFileSync(outputFile, JSON.stringify(carrier.base.assets));
}
