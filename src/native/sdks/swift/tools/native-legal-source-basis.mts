import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CompletedPublication } from '../../../../../tools/release/completed-release-publication.mts';
import { validateFrozenNativeCarrierIdentity } from './swift-native-carrier-contract.mts';

const repository = 'f0rr0/oliphaunt';
const nativeProduct = 'liboliphaunt-native';
const swiftProduct = 'oliphaunt-swift';
const sourceMember = 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json';
const sha = /^[0-9a-f]{40}$/u;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export const currentNativeLegalSourceBasis = Object.freeze({ kind: 'current-source' as const });

export interface PublishedNativeLegalSourceBasis {
  kind: 'completed-publication';
  publication: CompletedPublication;
  sourcePublication: CompletedPublication;
  source: { commit: string; tree: string; member: string; blob: string };
  assets: readonly { assetId: number; name: string; sha256: string; size: number }[];
}

export type NativeLegalSourceBasis =
  | typeof currentNativeLegalSourceBasis
  | PublishedNativeLegalSourceBasis;

// A held basis has an explicit trusted capture boundary. Consumers cannot use
// their incoming manifest, or a serialized basis, as its own expected policy.
const authenticated = new WeakMap<object, { base: unknown; legal: unknown }>();

function error(message: string) {
  return new Error(`native legal source basis: ${message}`);
}

function checkedCompletion(value, product, version, release): CompletedPublication {
  if (
    value?.product !== product ||
    value.version !== version ||
    value.tagName !== release.tag_name ||
    value.publicationSha !== release.target_commitish ||
    ![value.publicationSha, value.publicationTree, value.releaseSha].every((value) =>
      sha.test(value),
    )
  )
    throw error(`${product}@${version} completion differs from its public release`);
  return value;
}

/**
 * Resolve before construction/admission, outside cacheable actions. Reads are
 * pinned to completed releases and their immutable Git objects. The source-tag
 * carrier supplies its historical policy and member names; current policy is
 * never substituted for that independently published declaration.
 */
export async function createPublishedNativeLegalSourceBasis({
  nativeVersion,
  swiftVersion,
  readJson = undefined,
  readPages = undefined,
  assertCompletedPublication = undefined,
}: {
  nativeVersion: string;
  swiftVersion: string;
  readJson?: (endpoint: string) => Promise<any>;
  readPages?: (endpoint: string, options?: any) => Promise<any[]>;
  assertCompletedPublication?: (identity: {
    product: string;
    version: string;
    publicationSha: string;
    tagName: string;
  }) => Promise<CompletedPublication>;
}): Promise<PublishedNativeLegalSourceBasis> {
  if (!versionPattern.test(nativeVersion) || !versionPattern.test(swiftVersion))
    throw error('published source and native versions must be exact stable versions');
  if (!readJson || !readPages) {
    const github = await import('../../../../../tools/release/github-read.mts');
    readJson ??= github.requestGithubRepositoryJson;
    readPages ??= github.requestGithubPages;
  }
  // Completion and source acquisition observe the same release snapshot.
  const transport = readJson;
  if (!transport || !readPages)
    throw error('published acquisition requires GitHub read transports');
  const reads = new Map<string, Promise<any>>();
  const read = (endpoint: string) => {
    let result = reads.get(endpoint);
    if (!result) {
      result = transport(endpoint);
      reads.set(endpoint, result);
    }
    return result;
  };
  if (!assertCompletedPublication) {
    const { createCompletedPublicationChecker } = await import(
      '../../../../../tools/release/completed-release-publication.mts'
    );
    assertCompletedPublication = createCompletedPublicationChecker({
      repository,
      readJson: read,
      readPages,
    });
  }
  const assertCompletion = assertCompletedPublication;
  if (!assertCompletion)
    throw error('published acquisition requires completed-publication verification');
  const complete = async (product: string, version: string) => {
    const tagName = `${product}-v${version}`;
    const release = await read(`repos/${repository}/releases/tags/${tagName}`);
    if (
      release?.tag_name !== tagName ||
      release.draft !== false ||
      release.prerelease !== false ||
      !sha.test(release.target_commitish) ||
      !Number.isSafeInteger(release.id) ||
      release.id <= 0
    )
      throw error(`${product}@${version} requires an exact stable public release`);
    const publication = checkedCompletion(
      await assertCompletion({
        product,
        version,
        publicationSha: release.target_commitish,
        tagName,
      }),
      product,
      version,
      release,
    );
    return { publication, release };
  };
  const [native, swift] = await Promise.all([
    complete(nativeProduct, nativeVersion),
    complete(swiftProduct, swiftVersion),
  ]);
  const reference = await read(`repos/${repository}/git/ref/tags/${swiftVersion}`);
  if (
    reference?.ref !== `refs/tags/${swiftVersion}` ||
    reference.object?.type !== 'commit' ||
    !sha.test(reference.object.sha)
  )
    throw error('published Swift source requires its exact lightweight source tag');
  const commit = await read(`repos/${repository}/git/commits/${reference.object.sha}`);
  if (commit?.sha !== reference.object.sha)
    throw error('published Swift source differs from its exact tag');
  const contents = await read(`repos/${repository}/contents/${sourceMember}?ref=${commit.sha}`);
  const assets = await readPages(`repos/${repository}/releases/${native.release.id}/assets`, {
    label: 'held native base assets',
  });
  return createCapturedPublishedNativeLegalSourceBasis({
    publication: native.publication,
    nativeRelease: native.release,
    sourcePublication: swift.publication,
    sourceReference: reference,
    sourceCommit: commit,
    carrierContents: contents,
    nativeAssets: assets,
  });
}

/**
 * Bind independently captured facts that the caller has authenticated through
 * the completed-publication checker and immutable Git/API source acquisition.
 * Repository imports declare those captures as inputs; this function performs
 * no network reads and does not authenticate arbitrary JSON receipts.
 */
export function createCapturedPublishedNativeLegalSourceBasis({
  publication,
  nativeRelease,
  sourcePublication,
  sourceReference: reference,
  sourceCommit: commit,
  carrierContents: contents,
  nativeAssets: rows,
}: {
  publication: CompletedPublication;
  nativeRelease: any;
  sourcePublication: CompletedPublication;
  sourceReference: any;
  sourceCommit: any;
  carrierContents: any;
  nativeAssets: any[];
}): PublishedNativeLegalSourceBasis {
  if (
    !versionPattern.test(publication?.version) ||
    nativeRelease?.tag_name !== `${nativeProduct}-v${publication.version}` ||
    nativeRelease.draft !== false ||
    nativeRelease.prerelease !== false ||
    !Number.isSafeInteger(nativeRelease.id) ||
    nativeRelease.id <= 0
  )
    throw error('captured native facts require an exact stable public release');
  checkedCompletion(publication, nativeProduct, publication.version, nativeRelease);
  if (
    sourcePublication?.product !== swiftProduct ||
    !versionPattern.test(sourcePublication.version) ||
    sourcePublication.tagName !== `${swiftProduct}-v${sourcePublication.version}` ||
    ![
      sourcePublication.publicationSha,
      sourcePublication.publicationTree,
      sourcePublication.releaseSha,
    ].every((value) => sha.test(value))
  )
    throw error('captured Swift source requires verified completed publication facts');
  if (
    reference?.ref !== `refs/tags/${sourcePublication.version}` ||
    reference.object?.type !== 'commit' ||
    !sha.test(reference.object.sha) ||
    commit?.sha !== reference.object.sha ||
    !sha.test(commit.tree?.sha) ||
    commit.parents?.length !== 1 ||
    commit.parents[0].sha !== sourcePublication.publicationSha
  )
    throw error('published Swift source does not bind the completed publication parent');
  if (
    contents?.path !== sourceMember ||
    contents.type !== 'file' ||
    contents.encoding !== 'base64' ||
    typeof contents.content !== 'string' ||
    !sha.test(contents.sha)
  )
    throw error('published Swift source has no exact carrier member');
  const bytes = Buffer.from(contents.content, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > 1024 * 1024 ||
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== contents.sha
  )
    throw error('published Swift carrier bytes differ from their immutable Git blob');
  const carrier = validateFrozenNativeCarrierIdentity({
    carrier: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    expectedNativeVersion: publication.version,
  });
  if (!Array.isArray(rows)) throw error('published native release has no asset inventory');
  const assets = carrier.base.assets.map((asset) => {
    const matches = rows.filter((row) => row.name === asset.name);
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      row.browser_download_url !== asset.url ||
      row.digest !== `sha256:${asset.sha256}` ||
      row.size !== asset.bytes ||
      asset.bytes > 512 * 1024 * 1024
    )
      throw error(`published native asset differs from immutable source: ${asset.name}`);
    return Object.freeze({
      assetId: row.id,
      name: asset.name,
      sha256: asset.sha256,
      size: asset.bytes,
    });
  });
  if (new Set(assets.map(({ assetId }) => assetId)).size !== assets.length)
    throw error('published native base repeats an asset identity');
  const basis = Object.freeze({
    kind: 'completed-publication' as const,
    publication: Object.freeze({ ...publication }),
    sourcePublication: Object.freeze({ ...sourcePublication }),
    source: Object.freeze({
      commit: commit.sha,
      tree: commit.tree.sha,
      member: sourceMember,
      blob: contents.sha,
    }),
    assets: Object.freeze(assets),
  });
  authenticated.set(basis, {
    base: JSON.parse(JSON.stringify(carrier.base)),
    legal: JSON.parse(JSON.stringify(carrier.legal.base)),
  });
  return basis;
}

/** Match the full independently authenticated base, not its version alone. */
export function nativeBaseLegalForSource({
  base,
  sourceBasis,
  currentLegal,
}: {
  base: unknown;
  sourceBasis?: NativeLegalSourceBasis;
  currentLegal: () => unknown;
}) {
  if (sourceBasis === undefined || sourceBasis.kind === 'current-source') return currentLegal();
  const held = authenticated.get(sourceBasis);
  if (!held) throw error('held native legal requires an authenticated published source basis');
  if (!isDeepStrictEqual(base, held.base))
    throw error('native base differs from the authenticated publication assets');
  return JSON.parse(JSON.stringify(held.legal));
}

export function publishedNativeBaseForSource(sourceBasis: NativeLegalSourceBasis) {
  const held = authenticated.get(sourceBasis);
  if (!held) throw error('held native assets require an authenticated published source basis');
  return JSON.parse(JSON.stringify(held.base));
}
