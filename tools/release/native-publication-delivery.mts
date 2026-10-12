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
import { validateReviewedNativeProducerAssurance } from './authenticate-native-build-evidence.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import { nativeShippingRootsHaveQualification } from './native-build-qualification.mts';
import {
  assertSeedConstructionBaseline,
  type NativeSeedConstructionBaseline,
  seedArchiveHasChangedDeclaredContents,
} from './native-seed-baseline.mts';
import type { compareNativeCompletedPhysicalDelivery } from './native-completed-delivery.mts';
import { nativeOutputPath } from './native-publication-artifacts.mts';
import type { observeNativePublicationConstruction } from './native-publication-observation.mts';
import {
  type NativeDeliveryVerification,
  type NativePayloadCohort,
  type NativePayloads,
  nativePayloadDigest,
} from './native-publication-payloads.mts';
import {
  captureNativeOutputMembers,
  type NativeOutputMember,
} from './native-publication-staging.mts';
import type { compareNativeCompletedSourceDelivery } from './native-source-carrier-changes.mts';
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
type DeliveredMember = { path: string; mode: number };
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

/** Exact inner member equality, independent of producer labels, actions and outer envelopes. */
export function differentNativeDeliveredMembers(
  before: readonly DeliveredMember[],
  after: readonly DeliveredMember[],
) {
  const index = (members: readonly DeliveredMember[]) => {
    const result = new Map<string, string>();
    for (const member of members) {
      if (
        typeof member.path !== 'string' ||
        (member.path !== '' &&
          (member.path.startsWith('/') ||
            member.path.includes('\\') ||
            /[\u0000-\u001f\u007f]/u.test(member.path) ||
            member.path.split('/').some((part) => !part || part === '.' || part === '..'))) ||
        !Number.isInteger(member.mode) ||
        member.mode < 0 ||
        member.mode > 0o777 ||
        result.has(member.path)
      )
        throw new Error('native delivery member identity is unsafe, duplicate or has invalid mode');
      // Keep every adapter-supplied identity field. Source-envelope adapters
      // neutralize only their typed own identity before calling this function.
      result.set(member.path, canonical(member));
    }
    return result;
  };
  const old = index(before);
  const current = index(after);
  return [...new Set([...old.keys(), ...current.keys()])]
    .filter((name) => old.get(name) !== current.get(name))
    .sort();
}

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
  // This is the installed-tree contract, not the TAR wrapper header. Both
  // retained extractors force the destination root to 0755, including ZIPs
  // without a root marker; all actual inner paths and modes remain below.
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
    source: current.source,
    currentArchives: current.products.flatMap(({ archives }) => archives),
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
      const identical = after.every(
        (root) =>
          !differentNativeDeliveredMembers(
            root.outputs[0].members,
            before.find(({ target }) => target === root.configuration)!.members,
          ).length,
      );
      return {
        product: product.product,
        deliveryStatus: identical ? ('identical' as const) : ('different' as const),
      };
    }),
  };
}

/**
 * One pre-version comparison for the supported completed delivery bridges.
 * Invoke before version updates or controller metadata sealing. Changed inputs
 * and action definitions request checks only. A source-owned configured policy,
 * reviewed producing origin and complete physical contract admit each decision.
 * Complete repository resolution is separate from execution: held baselines may
 * be reused only after their causal input and contract identity has been proven.
 */
export function compareNativePreVersionDelivery({
  source,
  products,
  archives,
  sources,
  completed,
  affectedProducts,
  observation,
  seedConstructionBaseline,
}: {
  source: Source;
  products: string[];
  archives?: ReturnType<typeof compareCompletedNativeArchiveDelivery>;
  sources?: Awaited<ReturnType<typeof compareNativeCompletedSourceDelivery>>;
  completed?: Awaited<ReturnType<typeof compareNativeCompletedPhysicalDelivery>>;
  affectedProducts?: string[];
  observation?: Awaited<ReturnType<typeof observeNativePublicationConstruction>>;
  seedConstructionBaseline?: NativeSeedConstructionBaseline;
}) {
  exactSource(source);
  if (seedConstructionBaseline) assertSeedConstructionBaseline(seedConstructionBaseline, source);
  if (!Array.isArray(products) || new Set(products).size !== products.length)
    throw new Error('native pre-version comparison requires unique explicit products');
  if (
    affectedProducts !== undefined &&
    (!Array.isArray(affectedProducts) ||
      new Set(affectedProducts).size !== affectedProducts.length ||
      affectedProducts.some((product) => !products.includes(product)))
  )
    throw new Error('native affected build selection differs from the explicit product inventory');
  const catalog = loadPublicationCatalog('native pre-version delivery');
  const selected = catalog.products.filter((product) => products.includes(product.id));
  if (selected.length !== products.length)
    throw new Error('native pre-version comparison contains an unknown product');
  for (const comparison of [archives, sources, completed]) {
    if (!comparison) continue;
    if (comparison.scope !== 'construction' || !same(comparison.source, source))
      throw new Error('native pre-version comparison differs from its captured source');
    if (
      new Set(comparison.products.map(({ product }) => product)).size !== comparison.products.length
    )
      throw new Error('ambiguous native pre-version product comparison');
    if (comparison.products.some(({ product }) => !products.includes(product)))
      throw new Error('native pre-version comparison exceeds explicit product inventory');
  }
  const qualificationUnknowns: string[] = [];
  let producerAssured = false;
  if (observation) {
    if (!observation.authenticated.length || !observation.coverage.completeProductInventory)
      throw new Error('native pre-version observation has incomplete frozen inventory');
    if (!same(observation.products.map(({ product }) => product.id).sort(), [...products].sort()))
      throw new Error('native pre-version observation differs from product inventory');
    for (const build of observation.authenticated) {
      if (
        !same(build.evidence.source, source) ||
        !same(build.qualification.source, source) ||
        build.qualification.testQualification !== 'passed' ||
        !build.qualification.requiredTests.length
      )
        throw new Error('native pre-version observation differs from source/configured tests');
      qualificationUnknowns.push(...build.qualification.unverified);
      if (build.producerAssurance)
        validateReviewedNativeProducerAssurance(build.producerAssurance, {
          source,
          github: build.origin.github,
          artifact: build.origin.artifact,
          evidenceDigest: build.origin.evidenceDigest,
          requiredTests: build.qualification.requiredTests,
        });
    }
    producerAssured = observation.authenticated.every((build) => build.producerAssurance);
  }
  if (!producerAssured)
    qualificationUnknowns.push('immutable input lifetime and loaded-analysis provenance');
  const results = selected.map((product) => {
    const sourceDelivery = sources?.products.find((row) => row.product === product.id);
    const archiveDelivery = archives?.products.find((row) => row.product === product.id);
    const completedDelivery = completed?.products.find((row) => row.product === product.id);
    let deliveryStatus = 'unknown' as 'unknown' | 'identical' | 'different';
    let reason = 'completed-delivery-origin-or-contract-missing';
    if (completedDelivery) {
      deliveryStatus = completedDelivery.deliveryStatus;
      reason =
        deliveryStatus === 'unknown'
          ? completedDelivery.unknowns?.join(',') || completedDelivery.reason || reason
          : 'completed-public-members-compared';
      if (observation) {
        const observed = observation.products.find(({ product: row }) => row.id === product.id);
        const ordered = (records) => [...records].sort((a, b) => a.id.localeCompare(b.id));
        // Observation adds authenticated output locations to the same original
        // envelope. Compare every envelope field; those derived bindings were
        // already checked against the producing packet by the observer.
        const envelope = (records) => records.map(({ qualifiedFiles: _bindings, ...row }) => row);
        if (
          !observed ||
          observed.product.version !== product.version ||
          !same(ordered(envelope(observed.carriers)), ordered(completedDelivery.carriers)) ||
          !same(
            ordered(envelope(observed.productArtifacts)),
            ordered(completedDelivery.productArtifacts),
          )
        )
          throw new Error('completed delivery differs from qualified physical inventory');
      }
    } else if (sourceDelivery && sourceDelivery.deliveryStatus !== 'unknown') {
      deliveryStatus = sourceDelivery.deliveryStatus as 'identical' | 'different';
      reason = 'source-envelope-members-compared';
      if (observation) {
        const observed = observation.products.find(({ product: row }) => row.id === product.id);
        if (
          !observed ||
          observed.product.version !== product.version ||
          observed.productArtifacts.length
        )
          throw new Error('source delivery observation has a different identity or output class');
        for (const carrier of sourceDelivery.carriers ?? []) {
          const actual = observed.carriers.filter(({ id }) => id === carrier.carrier);
          if (actual.length !== 1 || !same(actual[0].artifacts, [carrier.currentArtifact]))
            throw new Error('source comparison differs from qualified physical envelope');
        }
        if (observed.carriers.length !== sourceDelivery.carriers?.length)
          throw new Error('source comparison has incomplete qualified carrier inventory');
      }
    } else if (archiveDelivery) {
      // These bridges currently map the two native GitHub archive families.
      // Their registry facades/parts and contrib carriers are separate public
      // contracts, so an identical archive must not certify the whole product.
      reason = 'remaining-public-carrier-contracts-unmapped';
      if (observation) {
        const observed = observation.products.find(({ product: row }) => row.id === product.id);
        if (!observed || observed.product.version !== product.version)
          throw new Error('archive delivery observation has a different identity');
        for (const archive of archives?.currentArchives.filter(
          (row) => row.product === product.id,
        ) ?? []) {
          const actual = observed.productArtifacts.filter(({ id }) => id === archive.id);
          if (
            actual.length !== 1 ||
            actual[0].name !== archive.name ||
            actual[0].kind !== archive.kind ||
            actual[0].target !== archive.target ||
            actual[0].sha256 !== archive.sha256 ||
            actual[0].size !== archive.size
          )
            throw new Error('archive comparison differs from qualified physical envelope');
        }
      }
    } else if (sourceDelivery) reason = sourceDelivery.reason ?? reason;
    const relevantBuilds =
      observation?.authenticated.filter((build) =>
        (build.qualification.cohorts ?? []).some((cohort) =>
          cohort.roots.some((root) => root.package.product === product.id),
        ),
      ) ?? [];
    const relevantCohorts = relevantBuilds.flatMap((build) =>
      build.qualification.cohorts.filter((cohort) =>
        cohort.roots.some((root) => root.package.product === product.id),
      ),
    );
    const policiesBound =
      relevantCohorts.length > 0 &&
      relevantCohorts.every((cohort) =>
        nativeShippingRootsHaveQualification(
          cohort.qualificationPolicy,
          cohort.roots.filter((root) => root.package.product === product.id),
        ),
      );
    const productUnknowns = relevantBuilds
      .flatMap((build) => build.qualification.unverified)
      .filter(
        (unknown) =>
          unknown !== 'complete canonical product qualification and completed-baseline admission' &&
          !(
            policiesBound &&
            unknown ===
              'source-owned mandatory qualification policy bound to every configured shipping root'
          ),
      );
    const qualified =
      policiesBound &&
      relevantBuilds.every((build) => build.producerAssurance) &&
      !productUnknowns.length;
    // Fresh initdb identity needs causal freeze/reuse evidence, even after its tests pass.
    const seedRows = expectedProductArtifactRows([product]).filter((artifact) =>
      ['native-seeds', 'wasix-seeds'].includes(artifact.kind),
    );
    const seedComparisons =
      completedDelivery?.comparisons?.filter((comparison) =>
        ['native-seeds', 'wasix-seeds'].includes(comparison.kind),
      ) ?? [];
    const unclassifiedSeedChange =
      seedRows.length > 0 &&
      deliveryStatus === 'different' &&
      (!same(
        seedRows.map(({ id }) => id).sort(),
        seedComparisons.map((comparison) => comparison.currentId ?? comparison.id).sort(),
      ) ||
        seedComparisons.some((comparison) => {
          const row = seedRows.find((row) => row.id === (comparison.currentId ?? comparison.id));
          if (!comparison.differentMembers.length || !row?.name.endsWith('.tar.zst')) return false;
          if (!seedConstructionBaseline || !observation || !completedDelivery?.origin) return true;
          try {
            return !seedArchiveHasChangedDeclaredContents({
              declaration: seedConstructionBaseline,
              source,
              publication: completedDelivery.origin,
              observation,
              artifactId: comparison.currentId ?? comparison.id,
            });
          } catch {
            return true; // Missing or conflicting causal/public File joins remain unclassified.
          }
        }));
    if (unclassifiedSeedChange) reason = 'seed-lifetime-or-reuse-unverified';
    const necessaryDelivery =
      !unclassifiedSeedChange && qualified && deliveryStatus !== 'unknown'
        ? deliveryStatus === 'different'
          ? ('needed' as const)
          : ('not-needed' as const)
        : ('unknown' as const);
    return {
      product: product.id,
      affectedBuild:
        affectedProducts === undefined
          ? ('unknown' as const)
          : affectedProducts.includes(product.id)
            ? ('required' as const)
            : ('not-required' as const),
      deliveryStatus,
      ...(archiveDelivery ? { archiveDeliveryStatus: archiveDelivery.deliveryStatus } : {}),
      configuredTests: qualified
        ? ('qualified' as const)
        : observation
          ? ('observed-passed' as const)
          : ('unverified' as const),
      necessaryDelivery,
      reason,
    };
  });
  const completeRepositoryInventory = same(
    [...products].sort(),
    catalog.products.map(({ id }) => id).sort(),
  );
  const completeDecisions = results.every((product) => product.necessaryDelivery !== 'unknown');
  if (!completeDecisions)
    qualificationUnknowns.push(
      'admitted complete product-specific qualification and delivery contract',
    );
  if (!completeRepositoryInventory)
    qualificationUnknowns.push('complete repository product decision inventory');
  const unverified = [...new Set(qualificationUnknowns)].filter(
    (unknown) =>
      !(
        completeDecisions &&
        unknown === 'complete canonical product qualification and completed-baseline admission'
      ),
  );
  const releaseDecision =
    completeRepositoryInventory && completeDecisions && !unverified.length
      ? ('qualified' as const)
      : ('unverified' as const);
  return {
    scope: 'construction' as const,
    source: structuredClone(source),
    releaseDecision,
    completeRepositoryInventory,
    ...(releaseDecision === 'qualified'
      ? {
          selectedProducts: results
            .filter((product) => product.necessaryDelivery === 'needed')
            .map(({ product }) => product)
            .sort(),
        }
      : {}),
    products: results,
    unverified,
  };
}
