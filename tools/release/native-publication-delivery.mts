/** Physical archive bindings and completed delivery bytes, never publication admission. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import {
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
} from '../../src/native/runtime/tools/native-runtime-payload.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import {
  createCompletedPublicationChecker,
  type CompletedPublication,
} from './completed-release-publication.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import { nativeOutputPath } from './native-publication-artifacts.mts';
import {
  nativePayloadDigest,
  type NativeDeliveryVerification,
  type NativePayloadCohort,
  type NativePayloads,
} from './native-publication-payloads.mts';
import {
  captureNativeOutputMembers,
  type NativeOutputMember,
} from './native-publication-staging.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { requestReleaseAssetProof } from './verify_github_release_attestations.mts';

type Artifact = {
  product: string;
  version: string;
  id: string;
  role: string;
  kind: string;
  target: string;
  name: string;
};
type Source = { commit: string; tree: string };
type DeliveredRoot = NativeDeliveryVerification['deliveredPayloads'][number];
const kinds = new Map([
  ['liboliphaunt-native', 'native-runtime'],
  ['postgres-tools-native', 'native-tools'],
]);
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const sortedMembers = (members: NativeOutputMember[]) =>
  members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

function exactSource(source: Source) {
  if (![source?.commit, source?.tree].every((sha) => /^[a-f0-9]{40}$/u.test(sha ?? '')))
    throw new Error('native archive delivery requires exact source commit/tree');
}

function rows(products = loadPublicationCatalog('native archive delivery').products) {
  return expectedProductArtifactRows(products).filter(
    (row) => row.role === 'github-release-asset' && kinds.get(row.product) === row.kind,
  ) as Artifact[];
}

function memberIdentities(file: string): NativeOutputMember[] {
  // The retained reader omits the archive's "." root marker. The existing
  // archiveDirectory contract always supplies that directory with mode 0755.
  const members: NativeOutputMember[] = [{ path: '', type: 'directory', mode: 0o755 }];
  for (const entry of readPortableArchiveEntries(file).values()) {
    const memberPath = entry.name.replace(/\/$/u, '');
    members.push(
      entry.isDirectory
        ? { path: memberPath, type: 'directory', mode: entry.mode & 0o777 }
        : {
            path: memberPath,
            type: 'file',
            mode: entry.mode & 0o777,
            size: entry.size,
            sha256: hash(entry.data()),
          },
    );
  }
  return sortedMembers(members);
}

function payloadContract(members: NativeOutputMember[], artifact: Artifact) {
  const executable = new Set(
    artifact.kind === 'native-runtime'
      ? requiredRuntimeMemberPaths(artifact.target, 'runtime/bin')
      : requiredToolsMemberPaths(artifact.target, 'runtime/bin'),
  );
  for (const name of executable)
    if (!members.some((member) => member.path === name && member.type === 'file'))
      throw new Error(`native archive delivery is missing declared executable ${name}`);
  // These are precisely copyDeclaredTree(executableFiles) + archiveDirectory
  // modes from the existing native GitHub envelope, not a guessed chmod policy.
  return sortedMembers(
    members.map((member) => ({
      ...member,
      mode: member.type === 'directory' || executable.has(member.path) ? 0o755 : 0o644,
    })),
  );
}

/** Bind final native GitHub members to actual declared pre-envelope outputs. */
export function bindNativeArchiveDelivery(
  payloads: NativePayloads,
  cohorts: NativePayloadCohort[],
  artifactRows = rows(),
) {
  exactSource(payloads.source);
  if (payloads.scope !== 'construction') throw new Error('native archive binding is construction');
  for (const cohort of cohorts)
    if (!same(cohort.source, payloads.source))
      throw new Error('native archive cohort differs from captured payload source');
  const products = payloads.products.map((product) => {
    const deliveredPayloads: DeliveredRoot[] = [];
    const archives = [];
    let reason = 'pre-envelope-roots-missing';
    for (const root of product.roots) {
      reason = 'unsupported-native-delivery-contract';
      const expected = artifactRows.filter(
        (artifact) =>
          artifact.product === product.id &&
          artifact.version === product.version &&
          artifact.target === root.configuration &&
          artifact.role === 'github-release-asset' &&
          artifact.kind === kinds.get(product.id),
      );
      if (!expected.length) continue;
      if (
        expected.length !== 1 ||
        root.name !== `${product.id}-public-payload` ||
        root.role !== 'construction' ||
        root.outputs.length !== 1 ||
        !root.outputs[0].members.some((member) => member.path === '' && member.type === 'directory')
      )
        throw new Error('native archive requires one unambiguous declared payload directory');
      const declaredPayloads = cohorts.flatMap((cohort) =>
        cohort.roots.filter(
          ({ label, package: pkg }) =>
            cohort.executionRoot === root.executionRoot &&
            label === root.label &&
            pkg.product === product.id &&
            pkg.version === product.version &&
            pkg.ecosystem === 'internal' &&
            pkg.name === root.name &&
            pkg.configuration === root.configuration &&
            pkg.role === root.role &&
            same(
              pkg.outputs,
              root.outputs.map(({ members: _members, ...output }) => output),
            ),
        ),
      );
      reason = 'declared-pre-envelope-root-missing';
      if (!declaredPayloads.length) continue;
      if (declaredPayloads.length !== 1) throw new Error('ambiguous declared native payload root');
      const capturedPayload = captureNativeOutputMembers(root.executionRoot, root.outputs[0].path);
      if (!same(capturedPayload.members, root.outputs[0].members))
        throw new Error('native raw payload differs from its captured physical members');
      const artifact = expected[0];
      const observed = cohorts.flatMap((cohort) =>
        cohort.roots
          .filter(
            ({ package: pkg }) =>
              pkg.product === artifact.product &&
              pkg.ecosystem === 'github' &&
              pkg.name === artifact.name &&
              pkg.configuration === artifact.target &&
              pkg.role === artifact.role,
          )
          .map((root) => ({ cohort, root })),
      );
      reason = 'declared-final-archive-missing';
      if (!observed.length) continue;
      if (
        observed.length !== 1 ||
        observed[0].root.package.version !== artifact.version ||
        observed[0].root.package.outputs.length !== 1
      )
        throw new Error('native final archive declaration is ambiguous or has a different version');
      const { cohort, root: archiveRoot } = observed[0];
      const output = archiveRoot.package.outputs[0];
      if (!output.owner || path.posix.basename(output.path) !== artifact.name)
        throw new Error('native final archive differs from its declared canonical file');
      const capture = captureNativeOutputMembers(cohort.executionRoot, output.path);
      const physical = capture.members[0];
      if (capture.members.length !== 1 || physical.type !== 'file')
        throw new Error('native final archive must be one declared regular File');
      const members = memberIdentities(nativeOutputPath(cohort.executionRoot, output.path));
      if (!same(members, payloadContract(root.outputs[0].members, artifact)))
        throw new Error(
          'native final archive does not exactly deliver its captured payload contract',
        );
      capture.assertUnchanged();
      capturedPayload.assertUnchanged();
      archives.push({ ...artifact, size: physical.size, sha256: physical.sha256 });
      deliveredPayloads.push({
        name: root.name,
        configuration: root.configuration,
        role: root.role,
        outputs: [{ name: path.posix.basename(root.outputs[0].path), members }],
      });
    }
    const complete =
      deliveredPayloads.length > 0 && deliveredPayloads.length === product.roots.length;
    const completeConfiguredArchiveInventory =
      complete &&
      same(
        artifactRows
          .filter(
            (artifact) =>
              artifact.product === product.id &&
              artifact.version === product.version &&
              artifact.kind === kinds.get(product.id),
          )
          .map(({ target }) => target)
          .sort(),
        deliveredPayloads.map(({ configuration }) => configuration).sort(),
      );
    return {
      product: product.id,
      version: product.version,
      reason: complete ? 'physical-final-members-bound' : reason,
      archives,
      completeConfiguredArchiveInventory,
      physicalDelivery: complete
        ? ({
            source: payloads.source,
            product: product.id,
            version: product.version,
            payloadDigest: nativePayloadDigest(product),
            deliveredPayloads,
          } satisfies NativeDeliveryVerification)
        : undefined,
    };
  });
  return {
    scope: 'construction' as const,
    source: payloads.source,
    products,
    unverified: [
      'producer execution or trusted cached-result provenance',
      'native qualification workflow proof',
      'producer equivalence to the declared frozen source cohort',
      'remaining registry carrier, facade and public artifact delivery coverage',
    ],
  };
}

function regularArchiveIdentity(file: string) {
  requireSafeDirectoryChain(path.dirname(path.resolve(file)), {
    label: 'completed native archive',
  });
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('completed native archive must be regular');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(descriptor, buffer);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
      size += count;
    }
    const after = fstatSync(descriptor);
    const named = lstatSync(file);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      [after, named].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs,
      )
    )
      throw new Error('completed native archive changed during capture');
    return { size, sha256: digest.digest('hex'), device: before.dev, inode: before.ino };
  } finally {
    closeSync(descriptor);
  }
}

/** Authenticate actual completed public assets; never infer historical Bazel outputs. */
export async function captureCompletedNativeArchiveDelivery(
  {
    publication,
    files,
  }: {
    publication: CompletedPublication;
    files: { target: string; file: string }[];
  },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
  } = {},
) {
  if (repository !== 'f0rr0/oliphaunt' || !kinds.has(publication?.product))
    throw new Error('unsupported completed native archive repository/product');
  const completed = await assertCompletedPublication(publication);
  if (!same(completed, publication)) throw new Error('completed native archive source differs');
  exactSource({ commit: completed.publicationSha, tree: completed.publicationTree });
  const catalog = loadPublicationCatalog('completed native archive');
  const product = catalog.products.find(({ id }) => id === completed.product)!;
  const expected = rows([{ ...product, version: completed.version }]);
  const release = await readJson(`repos/${repository}/releases/tags/${completed.tagName}`);
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== completed.tagName ||
    release.target_commitish !== completed.publicationSha ||
    release.draft !== false ||
    release.prerelease !== false
  )
    throw new Error('published native release differs from completed source');
  const assets = await readPages(`repos/${repository}/releases/${release.id}/assets`);
  const targets = new Set<string>();
  const archives = [];
  for (const { target, file } of files) {
    if (targets.has(target)) throw new Error('duplicate completed native archive target');
    targets.add(target);
    const matches = expected.filter((row) => row.target === target);
    if (matches.length !== 1)
      throw new Error('completed native archive has no canonical target contract');
    const artifact = matches[0];
    const matchingAssets = assets.filter((asset) => asset.name === artifact.name);
    if (matchingAssets.length !== 1)
      throw new Error('completed native archive public asset is missing/ambiguous');
    const asset = matchingAssets[0];
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error('completed native archive public asset identity is invalid');
    if (
      asset.state !== 'uploaded' ||
      asset.url !== `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`
    )
      throw new Error('completed native archive asset is not the canonical uploaded File');
    if (asset.digest != null && !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))
      throw new Error('completed native archive API digest is invalid');
    const before = regularArchiveIdentity(file);
    const downloaded = /^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? '')
      ? { bytes: asset.size, sha256: asset.digest.slice(7) }
      : await proveAsset(asset.url, artifact.name, asset.size);
    if (
      before.size !== asset.size ||
      before.size !== downloaded.bytes ||
      before.sha256 !== downloaded.sha256
    )
      throw new Error('completed native archive bytes differ from authenticated public asset');
    const members = memberIdentities(file);
    if (!same(before, regularArchiveIdentity(file)))
      throw new Error('completed native archive changed after read');
    archives.push({
      ...artifact,
      assetId: asset.id,
      releaseId: release.id,
      size: before.size,
      sha256: before.sha256,
      members,
    });
  }
  if (!archives.length) throw new Error('completed native archive target coverage is empty');
  return {
    scope: 'construction' as const,
    origin: 'completed-published-archives' as const,
    publication: completed,
    archives,
    unverified: [
      'historical native producer inputs, configured actions and execution/cache provenance',
    ],
  };
}

/** Delivery differences alone remain diagnostic; qualification decides no release here. */
export function compareCompletedNativeArchiveDelivery(
  current: ReturnType<typeof bindNativeArchiveDelivery>,
  origins: Awaited<ReturnType<typeof captureCompletedNativeArchiveDelivery>>[],
) {
  return {
    scope: 'construction' as const,
    releaseDecision: 'unverified' as const,
    products: current.products.map((product) => {
      const matches = origins.filter((origin) => origin.publication.product === product.product);
      if (matches.length > 1) throw new Error('ambiguous completed native archive origin');
      const before = matches[0]?.archives;
      const after = product.physicalDelivery?.deliveredPayloads;
      if (
        !product.completeConfiguredArchiveInventory ||
        !before ||
        !after ||
        !same(
          before.map(({ target }) => target).sort(),
          after.map(({ configuration }) => configuration).sort(),
        )
      )
        return { product: product.product, deliveryStatus: 'unknown' as const };
      const identical = after.every((root) =>
        same(
          root.outputs[0].members,
          before.find(({ target }) => target === root.configuration)!.members,
        ),
      );
      return {
        product: product.product,
        deliveryStatus: identical ? ('identical' as const) : ('different' as const),
      };
    }),
  };
}
