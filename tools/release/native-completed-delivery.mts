/** Completed public bytes compared with a construction candidate; never release admission. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateMavenCentralPublication } from '../packaging/maven-central-contract.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { readCompletedContribCarrierRows } from './completed-contrib-carrier-context.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import {
  captureCompletedSwiftSourceTag,
  currentSwiftSourceTagMembers,
} from './completed-swift-source-delivery.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import { fileIdentity } from './native-file-identity.mts';
import { nativePublicationMetadataArtifactRow } from './native-publication-metadata-contract.mts';
import { differentNativeDeliveredMembers } from './native-publication-delivery.mts';
import { sourceCarrierMembers } from './native-source-carrier-changes.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  validateCargoPayloadPartSets,
  validatePublicationCandidate,
} from './publication-lock.mts';
import { verifyRegistryCarrierIntegrity } from './registry-integrity.mts';
import { artifactTargetConfig, contribCarrierDescriptor } from './release-artifact-targets.mts';
import { loadProducts } from './release-graph.mts';
import { requestReleaseAssetProof } from './verify_github_release_attestations.mts';

type Member = {
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size?: number;
  sha256?: string;
};
type Carrier = {
  id: string;
  ecosystem: string;
  name: string;
  version: string;
  artifacts: { path: string; size: number; sha256: string }[];
};
export type CompletedDeliveryBaseline = {
  publication: CompletedPublication;
  /** Exact local downloaded files, not source folders or inferred historical Bazel roots. */
  carriers: Record<string, string[]>;
  productArtifacts?: Record<string, string>;
};
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stable = (value: unknown): string =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? `[${value.map(stable).join(',')}]`
      : `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
          .join(',')}}`
    : JSON.stringify(value);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const absolute = (file: string) => path.resolve(import.meta.dir, '../..', file);
const requireValue = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`native completed delivery: ${message}`);
};

/** Installed archive member view. Compression, timestamps and outer names are not members. */
export function nativeArchiveDeliveryMembers(file: string): Member[] {
  return [
    { path: '', type: 'directory' as const, mode: 0o755 },
    ...[...readPortableArchiveEntries(file).values()].map((entry) =>
      entry.isDirectory
        ? {
            path: entry.name.replace(/\/$/u, ''),
            type: 'directory' as const,
            mode: entry.mode & 0o777,
          }
        : {
            path: entry.name,
            type: 'file' as const,
            mode: entry.mode & 0o777,
            size: entry.size,
            sha256: sha(entry.data()),
          },
    ),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

function ownedPomVersion(text: string, version: string) {
  // The existing Central validator owns XML/coordinate validation. Mask the
  // same nested coordinate scopes, retaining offsets, and replace only the
  // one literal project.version. Dependencies/parents/properties stay exact.
  const header = text.replace(
    /<(parent|dependencies|dependencyManagement|properties|build|profiles|repositories|distributionManagement)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gu,
    (block) => ' '.repeat(block.length),
  );
  const versions = [...header.matchAll(/<version(?:\s[^>]*)?>([\s\S]*?)<\/version>/gu)];
  requireValue(
    versions.length === 1 && versions[0][1].trim() === version,
    'POM needs one literal own project.version',
  );
  const match = versions[0];
  const content = match.index + match[0].indexOf('>') + 1;
  const start = content + match[1].indexOf(version);
  return text.slice(0, start) + '0.0.0' + text.slice(start + version.length);
}

/** Preserve every Maven companion and packed member; neutralize only the own POM identity. */
export function nativeCarrierDeliveryMembers(carrier: Carrier): Member[] | undefined {
  const files = carrier.artifacts.map(({ path: file }) => absolute(file));
  if (['cargo', 'npm'].includes(carrier.ecosystem)) {
    requireValue(files.length === 1, 'Cargo/npm delivery needs exactly one packed carrier');
    return sourceCarrierMembers(files[0], carrier).map(({ member, file, mode, sha256 }) => ({
      path: member === '.' ? '' : member.replace(/\/$/u, ''),
      type: file ? 'file' : 'directory',
      mode,
      sha256,
    }));
  }
  if (carrier.ecosystem !== 'maven') return undefined;
  const poms = files.filter((file) => file.endsWith('.pom'));
  requireValue(poms.length === 1, 'Maven delivery needs exactly one POM');
  const text = utf8.decode(readFileSync(poms[0]));
  const identity = validateMavenCentralPublication({
    pomText: text,
    files: carrier.artifacts.map((artifact) => ({
      name: path.basename(artifact.path),
      size: artifact.size,
    })),
  });
  requireValue(
    `${identity.groupId}:${identity.artifactId}` === carrier.name &&
      identity.version === carrier.version,
    'Maven own coordinate differs',
  );
  const prefix = `${identity.artifactId}-${identity.version}`;
  const members: Member[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = path.basename(file);
    requireValue(
      name.startsWith(prefix) && name.length > prefix.length,
      'Maven companion lacks its exact coordinate basename',
    );
    const suffix = name.slice(prefix.length);
    requireValue(!seen.has(suffix), 'duplicate Maven companion');
    seen.add(suffix);
    if (suffix === '.pom') {
      const bytes = Buffer.from(ownedPomVersion(text, carrier.version));
      members.push({
        path: suffix,
        type: 'file',
        mode: 0o644,
        size: bytes.length,
        sha256: sha(bytes),
      });
    } else if (/\.(?:jar|aar|zip|tar\.gz|tar\.zst)$/u.test(suffix)) {
      members.push(
        ...nativeArchiveDeliveryMembers(file).map((member) => ({
          ...member,
          path: suffix + (member.path ? `/${member.path}` : ''),
        })),
      );
    } else return undefined; // Signatures/checksums/unknown publications are not guessed away.
  }
  return members.sort((a, b) => a.path.localeCompare(b.path));
}

function boundArtifacts(artifacts: Carrier['artifacts']) {
  return artifacts.map((artifact) => {
    const file = absolute(artifact.path);
    const before = fileIdentity(file);
    requireValue(
      before.sha256 === artifact.sha256 && before.size === artifact.size,
      'candidate physical file differs from its captured artifact',
    );
    return { file, before };
  });
}

async function completedRegistryDeclarations(publication, productPath, options) {
  const contrib = contribCarrierDescriptor('completed registry declarations');
  const historicalContrib = [contrib.nativeOwner, contrib.wasixOwner].includes(publication.product)
    ? await readCompletedContribCarrierRows(publication, {
        repository: options.repository,
        assertCompleted: options.assertCompletedPublication,
        readJson: options.readJson,
      })
    : undefined;
  let descriptor;
  if (historicalContrib) descriptor = historicalContrib.descriptor;
  else {
    const descriptorPath = `${productPath}/release.toml`;
    const contents = await options.readJson(
      `repos/${options.repository}/contents/${descriptorPath}?ref=${publication.publicationSha}`,
    );
    requireValue(
      contents.type === 'file' &&
        contents.path === descriptorPath &&
        contents.encoding === 'base64' &&
        typeof contents.content === 'string',
      'missing completed source descriptor',
    );
    const bytes = Buffer.from(contents.content, 'base64');
    requireValue(
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') ===
        contents.sha,
      'completed descriptor Git blob differs',
    );
    descriptor = Bun.TOML.parse(utf8.decode(bytes));
  }
  requireValue(
    descriptor.id === publication.product &&
      (descriptor.registry_packages === undefined || Array.isArray(descriptor.registry_packages)),
    'completed descriptor owner/registry inventory differs',
  );
  return {
    descriptor,
    declaredRegistry: historicalContrib
      ? historicalContrib.registryRows.map(({ raw }) => raw)
      : (descriptor.registry_packages ?? []),
  };
}

async function completedRegistryCarrier(publication, carrier, files, declaredRegistry, options) {
  const owner = carrier.parentCarrier ?? carrier.id;
  requireValue(
    declaredRegistry.includes(owner.replace(/^cargo:/u, 'crates:')),
    `historical registry ownership is unverified: ${carrier.id}`,
  );
  requireValue(Array.isArray(files) && files.length, `completed carrier is missing: ${carrier.id}`);
  const records = discoverPublicationArtifacts(files);
  requireValue(
    records.length === 1 &&
      records[0].ecosystem === carrier.ecosystem &&
      records[0].name === carrier.name &&
      records[0].version === publication.version,
    'completed carrier files have a different registry identity',
  );
  const published = {
    ...carrier,
    version: publication.version,
    artifacts: records[0].artifacts,
    packageDependencies: records[0].dependencies,
  };
  // Discovery must not acquire an adjacent Maven companion outside this input.
  requireValue(
    same(
      published.artifacts.map(({ path: file }) => absolute(file)).sort(),
      files.map(absolute).sort(),
    ),
    'completed carrier includes undeclared companion files',
  );
  const beforeFiles = boundArtifacts(published.artifacts);
  const registryProof = await verifyRegistryCarrierIntegrity(published, options);
  for (const { file, before } of beforeFiles)
    requireValue(
      same(fileIdentity(file), before),
      'carrier changed during registry authentication',
    );
  return { published, registryProof };
}

/**
 * Authenticate only explicitly consumed registry carriers at a completed source.
 * This is not complete owner inventory or a historical producer graph. Preserve
 * every raw packed member: own versions and Cargo provenance are consumed bytes.
 */
export async function captureCompletedNativeRegistryCarriers(
  { publication, carriers }: Pick<CompletedDeliveryBaseline, 'publication' | 'carriers'>,
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    registryOptions = {},
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    same(await assertCompletedPublication(publication), publication),
    'completed registry origin differs from requested source/version',
  );
  requireValue(
    carriers && typeof carriers === 'object' && !Array.isArray(carriers),
    'completed registry inputs must be an explicit carrier map',
  );
  const catalog = loadPublicationCatalog('completed registry member capture', {
    products: [publication.product],
  });
  const { descriptor, declaredRegistry } = await completedRegistryDeclarations(
    publication,
    catalog.products[0].path,
    { repository, assertCompletedPublication, readJson },
  );
  const archives = [];
  const unknowns = [];
  for (const [id, files] of Object.entries(carriers)) {
    const separator = id.indexOf(':');
    requireValue(separator > 0, 'registry input lacks its canonical identity');
    const carrier = resolveActualCarrier(catalog, id.slice(0, separator), id.slice(separator + 1));
    requireValue(carrier.id === id, 'registry input has a different canonical identity');
    const { published, registryProof } = await completedRegistryCarrier(
      publication,
      carrier,
      files,
      declaredRegistry,
      registryOptions,
    );
    if (!['cargo', 'npm'].includes(carrier.ecosystem)) {
      unknowns.push(`unsupported-supplier-registry-contract:${id}`);
      continue;
    }
    const bindings = boundArtifacts(published.artifacts);
    requireValue(bindings.length === 1, 'registry supplier needs exactly one packed archive');
    const packed = bindings[0];
    const root =
      carrier.ecosystem === 'cargo' ? `${carrier.name}-${publication.version}/` : 'package/';
    const members = [];
    for (const entry of readPortableArchiveEntries(packed.file).values()) {
      requireValue(
        entry.name.startsWith(root),
        'registry member is outside its owned package root',
      );
      const member = entry.name.slice(root.length).replace(/\/$/u, '');
      if (!member) continue;
      members.push(
        entry.isDirectory
          ? { path: member, type: 'directory' as const, mode: entry.mode & 0o777 }
          : {
              path: member,
              type: 'file' as const,
              mode: entry.mode & 0o777,
              size: entry.size,
              sha256: sha(entry.data()),
            },
      );
    }
    requireValue(
      same(fileIdentity(packed.file), packed.before),
      'registry carrier changed during member capture',
    );
    archives.push({
      ...published,
      name: id,
      target: carrier.target ?? 'portable',
      members: members.sort((a, b) => a.path.localeCompare(b.path)),
      registryProof,
    });
  }
  return {
    scope: 'construction' as const,
    origin: 'completed-registry-archives' as const,
    publication,
    descriptor,
    declaredRegistry,
    archives,
    unknowns,
  };
}

const archiveKinds = new Set([
  'native-runtime',
  'native-tools',
  'apple-swiftpm-binary',
  'runtime-resources',
  'broker-helper',
  'node-direct-addon',
  'wasix-napi-addon',
  'swift-bindings',
  'wasix-runtime',
  'wasix-aot-runtime',
  'wasix-postmaster-runtime',
  'wasix-tools',
  'wasix-tools-aot',
  'icu-data',
  'swift-source',
  'runtime',
  'extension-bundle',
  'ios-dependency-xcframework',
  'ios-xcframework',
]);
const metadataKinds = new Set(['manifest-json', 'manifest-properties', 'swift-extension-carrier']);
function publicDeliveryContract(row: { kind: string; name: string }) {
  // Both seed formats are canonical public assets. Preserve the descriptor and
  // every PGDATA byte; unchanged construction must reuse the completed seed.
  if (row.kind === 'native-seeds' || row.kind === 'wasix-seeds') {
    if (row.name.endsWith('.tar.zst')) return 'archive';
    if (row.name.endsWith('.json')) return 'file';
    return undefined;
  }
  if (archiveKinds.has(row.kind)) return 'archive';
  if (metadataKinds.has(row.kind)) return 'file';
  return undefined;
}
// Canonical asset IDs contain the own versioned filename. Pair the two
// independently canonical inventories by their semantic slot, retaining each
// side's actual ID/name for API and physical-file authentication.
const artifactSlot = (row, version = row.version) =>
  stable([
    row.role,
    row.kind,
    row.target,
    row.identity,
    // Both names were rendered by expectedProductArtifactRows, rather than
    // inferred from downloaded filenames. Keep canonical variants such as
    // standard/ICU while removing only their rendered own publication version.
    row.name.replace(version, '{version}'),
  ]);

/** Genuine completed public files only; there are no historical producer roots here. */
export async function captureCompletedNativePublicArtifacts(
  { publication, files }: { publication: CompletedPublication; files: Record<string, string> },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    same(await assertCompletedPublication(publication), publication),
    'completed public origin differs from requested source/version',
  );
  const product = loadPublicationCatalog('completed public member capture', {
    products: [publication.product],
  }).products[0];
  const rows = expectedProductArtifactRows([{ ...product, version: publication.version }]).filter(
    ({ role }) => role === 'github-release-asset' || role === 'github-release-metadata',
  );
  const release = await readJson(
    `repos/${repository}/releases/tags/${encodeURIComponent(publication.tagName)}`,
  );
  requireValue(
    Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      release.tag_name === publication.tagName &&
      release.target_commitish === publication.publicationSha &&
      release.draft === false &&
      release.prerelease === false,
    'public release differs from completed source',
  );
  const assets = await readPages(`repos/${repository}/releases/${release.id}/assets`);
  const unknowns = [];
  const metadataName = nativePublicationMetadataArtifactRow({
    id: publication.product,
    version: publication.version,
  }).name;
  const metadataAssets = assets.filter(({ name }) => name === metadataName);
  if (
    metadataAssets.length > 1 ||
    !same(
      assets
        .filter(({ name }) => name !== metadataName)
        .map(({ name }) => name)
        .sort(),
      rows.map(({ name }) => name).sort(),
    )
  )
    unknowns.push('completed-public-asset-inventory-differs');
  if (Object.keys(files).some((id) => !rows.some((row) => row.id === id)))
    unknowns.push('completed-public-artifact-inventory-differs');
  const archives = [];
  for (const row of rows) {
    if (row.kind === 'checksums') continue;
    const contract = publicDeliveryContract(row);
    if (!contract) {
      unknowns.push(`unsupported-public-delivery-contract:${row.kind}`);
      continue;
    }
    const file = files[row.id];
    if (!file) {
      unknowns.push(`completed-public-artifact-missing:${row.id}`);
      continue;
    }
    const matches = assets.filter((asset) => asset.name === row.name);
    requireValue(matches.length === 1, 'completed public artifact is absent or ambiguous');
    const asset = matches[0];
    requireValue(
      Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.state === 'uploaded' &&
        asset.url === `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
      'completed asset has invalid identity/state',
    );
    requireValue(
      asset.digest == null || /^sha256:[a-f0-9]{64}$/u.test(asset.digest),
      'completed asset digest is invalid',
    );
    const identity = fileIdentity(absolute(file));
    const proof = asset.digest
      ? { bytes: asset.size, sha256: asset.digest.slice(7) }
      : await proveAsset(asset.url, row.name, asset.size);
    requireValue(
      identity.size === asset.size &&
        identity.size === proof.bytes &&
        identity.sha256 === proof.sha256,
      'completed public archive bytes differ',
    );
    const members =
      contract === 'archive'
        ? nativeArchiveDeliveryMembers(absolute(file))
        : [
            {
              path: '',
              type: 'file' as const,
              mode: 0o644,
              size: identity.size,
              sha256: identity.sha256,
            },
          ];
    requireValue(
      same(fileIdentity(absolute(file)), identity),
      'public archive changed during capture',
    );
    archives.push({
      ...row,
      assetId: asset.id,
      releaseId: release.id,
      size: identity.size,
      sha256: identity.sha256,
      members,
    });
  }
  return {
    scope: 'construction' as const,
    origin: 'completed-published-archives' as const,
    publication,
    archives,
    unknowns,
  };
}

/**
 * One physical completed-delivery bridge for the existing candidate schema.
 * This compares public members, not consumed inputs or action keys. The old
 * public origin supplies no historical BUILD graph. Necessary delivery stays
 * unknown until the separate complete qualification/admission gates close.
 */
export async function compareNativeCompletedPhysicalDelivery(
  candidate: any,
  baselines: CompletedDeliveryBaseline[],
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    registryOptions = {},
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    candidate.scope === 'construction' && !candidate.missing?.length,
    'requires a complete physical construction candidate',
  );
  validatePublicationCandidate(candidate);
  const currentDeclarations = loadProducts('native completed delivery declarations');
  requireValue(
    new Set(baselines.map(({ publication }) => publication.product)).size === baselines.length,
    'duplicate completed product origin',
  );
  requireValue(
    baselines.every(({ publication }) =>
      candidate.products.some(({ id }) => id === publication.product),
    ),
    'completed origin exceeds candidate inventory',
  );
  const products = [];
  for (const product of candidate.products) {
    const baseline = baselines.find(({ publication }) => publication.product === product.id);
    const carriers = candidate.carriers.filter((carrier) => carrier.product === product.id);
    const currentArtifacts = candidate.productArtifacts.filter(
      (artifact) => artifact.product === product.id,
    );
    const bindings = {
      carriers: structuredClone(carriers),
      productArtifacts: structuredClone(currentArtifacts),
    };
    if (!baseline) {
      products.push({
        product: product.id,
        deliveryStatus: 'unknown' as const,
        reason: 'missing-completed-publication',
        ...bindings,
      });
      continue;
    }
    const publication = await assertCompletedPublication(baseline.publication);
    requireValue(
      same(publication, baseline.publication),
      'completed publication differs from requested source/version',
    );
    const { descriptor, declaredRegistry } = await completedRegistryDeclarations(
      publication,
      product.path,
      { repository, assertCompletedPublication, readJson },
    );
    const unknowns: string[] = [];
    if (
      !same([...(descriptor.publish_targets ?? [])].sort(), [...product.publishTargets].sort()) ||
      !same(
        [...(descriptor.release_artifacts ?? [])].sort(),
        [...(currentDeclarations[product.id].release_artifacts ?? [])].sort(),
      )
    )
      unknowns.push('historical-delivery-declaration-differs');
    const comparisons = [];
    const publishedCarriers = [];
    if (!same(Object.keys(baseline.carriers).sort(), carriers.map(({ id }) => id).sort()))
      unknowns.push('completed-registry-inventory-differs');
    // A removed historical carrier is a missing delivery contract, even when
    // neither the current candidate nor the caller supplied its old archive.
    if (
      !same(
        [...declaredRegistry].sort(),
        carriers
          .filter(({ declared }) => declared)
          .map(({ id }) => id.replace(/^cargo:/u, 'crates:'))
          .sort(),
      )
    )
      unknowns.push('historical-declared-registry-inventory-differs');
    for (const carrier of carriers) {
      const owner = carrier.parentCarrier ?? carrier.id;
      const raw = owner.replace(/^cargo:/u, 'crates:');
      if (!declaredRegistry.includes(raw)) {
        unknowns.push(`historical-expanded-carrier-ownership-unverified:${carrier.id}`);
        continue;
      }
      const files = baseline.carriers[carrier.id];
      if (!Array.isArray(files) || !files.length) {
        unknowns.push(`completed-carrier-missing:${carrier.id}`);
        continue;
      }
      const { published, registryProof } = await completedRegistryCarrier(
        publication,
        carrier,
        files,
        declaredRegistry,
        registryOptions,
      );
      const beforeFiles = boundArtifacts(published.artifacts);
      const currentFiles = boundArtifacts(carrier.artifacts);
      const before = nativeCarrierDeliveryMembers(published);
      const after = nativeCarrierDeliveryMembers(carrier);
      for (const { file, before: identity } of [...beforeFiles, ...currentFiles])
        requireValue(
          same(fileIdentity(file), identity),
          'carrier changed during delivery comparison',
        );
      publishedCarriers.push(published);
      if (!before || !after) unknowns.push(`unsupported-registry-delivery-contract:${carrier.id}`);
      else
        comparisons.push({
          id: carrier.id,
          kind: carrier.ecosystem,
          differentMembers: differentNativeDeliveredMembers(before, after),
          registryProof,
        });
    }
    if (publishedCarriers.length === carriers.length)
      validateCargoPayloadPartSets(publishedCarriers);
    const rows = expectedProductArtifactRows([{ ...product, version: publication.version }]);
    const publicRows = rows.filter(
      ({ role }) => role === 'github-release-asset' || role === 'github-release-metadata',
    );
    const finalInputs = currentArtifacts.filter(
      ({ role }) => role === 'github-release-asset' || role === 'github-release-metadata',
    );
    requireValue(
      new Set(publicRows.map((row) => artifactSlot(row))).size === publicRows.length &&
        new Set(finalInputs.map((row) => artifactSlot(row, product.version))).size ===
          finalInputs.length,
      'ambiguous canonical public artifact slot',
    );
    if (
      !same(
        finalInputs.map((row) => artifactSlot(row, product.version)).sort(),
        publicRows.map((row) => artifactSlot(row)).sort(),
      )
    )
      unknowns.push('completed-public-artifact-contract-inventory-differs');
    let capturedPublic;
    if (publicRows.length) {
      if (
        descriptor.artifact_targets &&
        !same(
          descriptor.artifact_targets,
          artifactTargetConfig(product.id, descriptor.artifact_targets.preset),
        )
      )
        unknowns.push('completed-public-artifact-declaration-differs');
      const captured = await captureCompletedNativePublicArtifacts(
        { publication, files: baseline.productArtifacts ?? {} },
        { repository, assertCompletedPublication, readJson, readPages, proveAsset },
      );
      capturedPublic = captured;
      unknowns.push(...captured.unknowns);
      for (const row of captured.archives) {
        const current = finalInputs.find(
          (input) => artifactSlot(input, product.version) === artifactSlot(row),
        );
        if (!current) {
          unknowns.push(`current-public-artifact-contract-missing:${row.id}`);
          continue;
        }
        const currentFiles = boundArtifacts([current]);
        const memberView = (file: string) =>
          publicDeliveryContract(row) === 'archive'
            ? nativeArchiveDeliveryMembers(file)
            : [
                {
                  path: '',
                  type: 'file' as const,
                  mode: 0o644,
                  size: readFileSync(file).length,
                  sha256: sha(readFileSync(file)),
                },
              ];
        const differentMembers = differentNativeDeliveredMembers(
          row.members,
          memberView(currentFiles[0].file),
        );
        requireValue(
          same(fileIdentity(currentFiles[0].file), currentFiles[0].before),
          'public archive changed during comparison',
        );
        comparisons.push({
          id: row.id,
          currentId: current.id,
          kind: row.kind,
          differentMembers,
          assetId: row.assetId,
          releaseId: row.releaseId,
        });
      }
    }
    // The source publisher's separate unscoped commit is independently
    // authenticated. It supplies actual delivered members, never old BUILD facts.
    if (
      product.publishTargets?.includes('swift-package-source-tag') ||
      descriptor.publish_targets?.includes('swift-package-source-tag')
    ) {
      const bindingsArchive = capturedPublic?.archives.find(
        ({ kind }) => kind === 'swift-bindings',
      );
      if (product.id !== 'oliphaunt-swift' || !bindingsArchive)
        unknowns.push('authenticated-swift-source-tag-delivery-missing');
      else {
        const sourceTag = await captureCompletedSwiftSourceTag(
          { publication, descriptor, bindings: bindingsArchive },
          { assertCompletedPublication, readJson, readPages },
        );
        const currentMembers = currentSwiftSourceTagMembers(candidate);
        comparisons.push({
          id: 'release-input:swiftpm-release-tree',
          kind: 'swiftpm-release-tree',
          differentMembers: differentNativeDeliveredMembers(sourceTag.members, currentMembers),
          sourceTag: sourceTag.source,
          nativePublication: sourceTag.nativePublication,
        });
      }
    }
    if (!comparisons.length) unknowns.push('delivered-contract-inventory-empty');
    products.push({
      product: product.id,
      origin: publication,
      deliveryStatus: unknowns.length
        ? ('unknown' as const)
        : comparisons.some(({ differentMembers }) => differentMembers.length)
          ? ('different' as const)
          : ('identical' as const),
      comparisons,
      unknowns,
      ...bindings,
    });
  }
  return {
    scope: 'construction' as const,
    source: candidate.source,
    releaseDecision: 'unverified' as const,
    products,
    unverified: [
      'complete product-specific qualification and input lifetime admission',
      'historical producer graph is unavailable; public members are not historical ShippingInfo',
      'necessary delivery is unverified',
    ],
  };
}
