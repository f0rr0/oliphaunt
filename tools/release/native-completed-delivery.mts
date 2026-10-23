/** Completed public bytes compared with a construction candidate; never release admission. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONTRIB_CARRIERS_PATH } from '../../src/extensions/artifacts/packages/tools/contrib-carriers.mts';
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
  replayCompletedSwiftSourceArchive,
} from './completed-swift-source-delivery.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import { fileIdentity, safeRelative } from './native-file-identity.mts';
import { differentNativeDeliveredMembers } from './native-publication-delivery.mts';
import { assertAuthenticatedNativePublicBaseline } from './native-publication-metadata.mts';
import {
  NATIVE_PUBLICATION_METADATA_KIND,
  nativePublicationMetadataArtifactRow,
} from './native-publication-metadata-contract.mts';
import { sourceCarrierMembers } from './native-source-carrier-changes.mts';
import {
  type NativeSupplierArtifact,
  validateNativeSupplierArtifacts,
} from './native-supplier-artifacts.mts';
import {
  loadPublicationCatalog,
  PUBLICATION_CATALOG_SCHEMA,
  REGISTRY_KIND_TO_ECOSYSTEM,
  resolveActualCarrier,
} from './publication-catalog.mts';
import {
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  validateCargoPayloadPartSets,
  validatePublicationCandidate,
} from './publication-lock.mts';
import { verifyRegistryCarrierIntegrity } from './registry-integrity.mts';
import { contribCarrierDescriptor, PRODUCT_PRESETS } from './release-artifact-targets.mts';
import { ROOT } from './release-graph.mts';
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
  metadataBaseline?: ReturnType<typeof assertAuthenticatedNativePublicBaseline>;
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
const absolute = (file: string) => path.resolve(ROOT, file);
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
    historicalContrib,
  };
}

/** Exact completed source declarations, including renamed owners and retired contracts. */
export async function readCompletedNativeDeliveryInventory(
  publication: CompletedPublication,
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    metadataBaseline = undefined as
      | ReturnType<typeof assertAuthenticatedNativePublicBaseline>
      | undefined,
    assertMetadataBaseline = assertAuthenticatedNativePublicBaseline,
  } = {},
) {
  publication = structuredClone(publication);
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    same(await assertCompletedPublication(publication), publication),
    'completed inventory origin differs from requested source/version',
  );
  const frozen =
    metadataBaseline === undefined ? undefined : assertMetadataBaseline(metadataBaseline);
  requireValue(
    metadataBaseline === undefined || frozen,
    'frozen metadata authentication returned no baseline',
  );
  if (frozen) {
    requireValue(same(frozen.publication, publication), 'frozen metadata publication differs');
    requireValue(
      frozen.metadata.repository === repository &&
        frozen.metadata.product.id === publication.product &&
        frozen.metadata.product.version === publication.version &&
        same(frozen.metadata.source, {
          commit: publication.publicationSha,
          tree: publication.publicationTree,
        }),
      'frozen metadata source/product/version differs',
    );
  }
  const sources = new Map<string, { text: string; sha: string }>();
  const responses = new Map<string, Promise<any>>();
  const read = (endpoint: string) => {
    let response = responses.get(endpoint);
    if (!response) {
      response = Promise.resolve(readJson(endpoint));
      responses.set(endpoint, response);
    }
    return response;
  };
  const text = async (file: string) => {
    safeRelative(file);
    if (!sources.has(file)) {
      const value = await read(
        `repos/${repository}/contents/${file}?ref=${publication.publicationSha}`,
      );
      requireValue(
        value.type === 'file' &&
          value.path === file &&
          value.encoding === 'base64' &&
          typeof value.content === 'string' &&
          /^[a-f0-9]{40}$/u.test(value.sha),
        `missing exact historical file ${file}`,
      );
      const bytes = Buffer.from(value.content, 'base64');
      requireValue(
        createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') ===
          value.sha,
        `historical Git blob differs for ${file}`,
      );
      sources.set(file, { text: utf8.decode(bytes), sha: value.sha });
    }
    const captured = sources.get(file);
    if (!captured) throw new Error(`native completed delivery: uncaptured historical file ${file}`);
    return captured.text;
  };
  const config = JSON.parse(await text('release-please-config.json'));
  const versions = JSON.parse(await text('.release-please-manifest.json'));
  const ownerPaths = Object.entries(config.packages ?? {})
    .filter(([, entry]: [string, any]) => entry?.component === publication.product)
    .map(([file]) => safeRelative(file));
  requireValue(ownerPaths.length === 1, 'completed product has no unique historical owner');
  const [ownerPath] = ownerPaths;
  requireValue(versions[ownerPath] === publication.version, 'completed historical version differs');
  if (frozen) {
    const descriptor = {
      ...Bun.TOML.parse(await text(`${ownerPath}/release.toml`)),
      path: ownerPath,
      version: publication.version,
    };
    requireValue(
      descriptor.id === publication.product &&
        typeof descriptor.kind === 'string' &&
        Array.isArray(descriptor.publish_targets ?? []) &&
        (descriptor.publish_targets ?? []).every((target) => typeof target === 'string') &&
        Array.isArray(descriptor.registry_packages ?? []),
      'completed descriptor owner/registry inventory differs',
    );
    const safeName = (name: string) =>
      typeof name === 'string' && name === path.basename(name) && safeRelative(name);
    const files = (artifacts) =>
      Array.isArray(artifacts) &&
      artifacts.length &&
      artifacts.every(
        (artifact) =>
          typeof artifact.path === 'string' &&
          safeName(path.basename(artifact.path)) &&
          (artifact.type === undefined || artifact.type === 'file') &&
          Number.isSafeInteger(artifact.size) &&
          artifact.size > 0 &&
          /^[a-f0-9]{64}$/u.test(artifact.sha256),
      );
    const carriers = structuredClone(frozen.metadata.carriers);
    requireValue(
      Array.isArray(carriers) && new Set(carriers.map(({ id }) => id)).size === carriers.length,
      'frozen registry inventory is ambiguous',
    );
    for (const carrier of carriers) {
      requireValue(
        carrier.product === publication.product &&
          carrier.version === publication.version &&
          Object.values(REGISTRY_KIND_TO_ECOSYSTEM).includes(carrier.ecosystem) &&
          typeof carrier.name === 'string' &&
          carrier.name.length &&
          !/[\u0000-\u0020\u007f]/u.test(carrier.name) &&
          carrier.id === `${carrier.ecosystem}:${carrier.name}` &&
          typeof carrier.role === 'string' &&
          carrier.role.length &&
          (carrier.target === null || typeof carrier.target === 'string') &&
          typeof carrier.declared === 'boolean',
        'frozen registry ownership differs',
      );
      requireValue(files(carrier.artifacts), 'frozen registry File inventory differs');
      if (!carrier.declared)
        requireValue(carrier.role === 'payload-part', 'frozen dynamic carrier is not a Cargo part');
    }
    const declaredIds = (descriptor.registry_packages ?? []).map((raw) => {
      requireValue(typeof raw === 'string', 'historical registry declaration is not a string');
      const separator = raw.indexOf(':');
      const ecosystem = REGISTRY_KIND_TO_ECOSYSTEM[raw.slice(0, separator)];
      requireValue(
        separator > 0 && ecosystem && raw.slice(separator + 1),
        'historical registry identity differs',
      );
      return `${ecosystem}:${raw.slice(separator + 1)}`;
    });
    requireValue(
      new Set(declaredIds).size === declaredIds.length &&
        declaredIds.every((id) =>
          carriers.some((carrier) => carrier.id === id && carrier.declared),
        ),
      'frozen registry inventory omits a historical declaration',
    );
    // Signed implicit contrib rows retain their recorded owner/role/target.
    // The source's literal registry list is coverage, not a current name factory.
    validateCargoPayloadPartSets(carriers);
    for (const carrier of carriers.filter(({ role }) => role === 'payload-part')) {
      const parent = carriers.find(({ id }) => id === carrier.parentCarrier);
      requireValue(
        parent && carrier.name === `${parent.name}-part-${String(carrier.part).padStart(3, '0')}`,
        'frozen Cargo part identity differs',
      );
    }
    const publicRows = frozen.metadata.productArtifacts
      .filter(({ role }) => ['github-release-asset', 'github-release-metadata'].includes(role))
      .map((artifact) => {
        requireValue(
          artifact.version === undefined || artifact.version === publication.version,
          'frozen public version differs',
        );
        return { ...structuredClone(artifact), version: publication.version };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    requireValue(
      new Set(publicRows.map(({ id }) => id)).size === publicRows.length,
      'frozen public inventory is ambiguous',
    );
    for (const row of publicRows)
      requireValue(
        row.product === publication.product &&
          !['checksums', NATIVE_PUBLICATION_METADATA_KIND].includes(row.kind) &&
          safeName(row.name) &&
          row.id === `github-release:${row.name}` &&
          files([row]),
        'frozen public File identity differs',
      );
    const catalog = {
      schema: PUBLICATION_CATALOG_SCHEMA,
      products: [
        {
          id: publication.product,
          kind: descriptor.kind,
          path: ownerPath,
          version: publication.version,
          publishTargets: descriptor.publish_targets ?? [],
          dependencies: [],
        },
      ],
      carriers,
    };
    return {
      publication,
      descriptor,
      catalog,
      carriers,
      publicRows,
      inputContext: {
        products: { [publication.product]: descriptor },
        contrib: { nativeOwner: null, wasixOwner: null },
        readText: (file: string) => {
          const captured = sources.get(safeRelative(file));
          if (!captured)
            throw new Error(
              `native completed delivery: uncaptured historical inventory input ${file}`,
            );
          return captured.text;
        },
      },
      sourceFiles: [...sources].map(([file, { sha }]) => ({ path: file, sha })),
    };
  }
  const declarations = await completedRegistryDeclarations(publication, ownerPath, {
    repository,
    assertCompletedPublication,
    readJson: read,
  });
  const descriptor = { ...declarations.descriptor, path: ownerPath, version: publication.version };
  await text(`${ownerPath}/release.toml`);
  const products = { [publication.product]: descriptor };
  const inputContext = declarations.historicalContrib?.inputContext ?? {
    products,
    // Non-runtime products have no implicit contrib carriers.
    contrib: { nativeOwner: null, wasixOwner: null },
  };
  if (declarations.historicalContrib) {
    requireValue(
      inputContext.contrib.nativeOwner !== null,
      'historical contrib context is missing',
    );
    for (const { path: file } of declarations.historicalContrib.sourceFiles) await text(file);
  }
  inputContext.products[publication.product] = descriptor;
  const normalizeTargets = async (owner: string, metadata) => {
    if (metadata.artifact_targets !== undefined) return;
    const moon = Bun.YAML.parse(await text(`${metadata.path}/moon.yml`));
    requireValue(
      moon.id === owner &&
        moon.project?.release?.component === owner &&
        moon.project.release.packagePath === metadata.path,
      'historical Moon release owner differs',
    );
    metadata.artifact_targets = moon.project.release.artifactTargets;
  };
  if (descriptor.publish_targets?.includes('github-release-assets')) {
    if (Object.hasOwn(PRODUCT_PRESETS, publication.product))
      await normalizeTargets(publication.product, descriptor);
    if (publication.product === 'database-resources')
      await text('src/database-resources/contracts/contract.json');
    if (
      declarations.historicalContrib ||
      ['exact-extension-artifact', 'exact-extension-bundle'].includes(descriptor.kind)
    ) {
      if (!declarations.historicalContrib) {
        const carriers = Bun.TOML.parse(await text(CONTRIB_CARRIERS_PATH));
        requireValue(
          [carriers.native_owner, carriers.wasix_owner, carriers.logical_product].every(
            (value) => typeof value === 'string' && value.length,
          ) && carriers.native_owner !== carriers.wasix_owner,
          'historical extension runtime ownership differs',
        );
        inputContext.contrib = {
          nativeOwner: carriers.native_owner,
          wasixOwner: carriers.wasix_owner,
          artifactProduct: carriers.logical_product,
        };
      }
      const owners = [inputContext.contrib.nativeOwner, inputContext.contrib.wasixOwner];
      for (const owner of owners) {
        if (!inputContext.products[owner]) {
          const paths = Object.entries(config.packages ?? {})
            .filter(([, entry]: [string, any]) => entry?.component === owner)
            .map(([file]) => safeRelative(file));
          requireValue(paths.length === 1, 'historical extension runtime has no unique owner');
          const [ownerPath] = paths;
          const metadata = Bun.TOML.parse(await text(`${ownerPath}/release.toml`));
          requireValue(
            metadata.id === owner && typeof versions[ownerPath] === 'string',
            'historical extension runtime owner/version differs',
          );
          inputContext.products[owner] = {
            ...metadata,
            path: ownerPath,
            version: versions[ownerPath],
          };
        }
        await normalizeTargets(owner, inputContext.products[owner]);
      }
    }
    if (['exact-extension-artifact', 'exact-extension-bundle'].includes(descriptor.kind))
      for (const file of [
        'src/extensions/contracts/extension-target-profiles.toml',
        'src/extensions/generated/sdk/extensions.json',
        'src/extensions/generated/mobile/static-extensions.tsv',
      ])
        await text(file);
  }
  const context = {
    ...inputContext,
    readText: (file: string) => {
      const captured = sources.get(safeRelative(file));
      if (!captured)
        throw new Error(`native completed delivery: uncaptured historical inventory input ${file}`);
      return captured.text;
    },
  };
  const catalog = loadPublicationCatalog('completed native delivery inventory', {
    products: [publication.product],
    inputContext: context,
  });
  const decodedRows = expectedProductArtifactRows(catalog.products, {
    inputContext: context,
  }).filter(({ role }) => role === 'github-release-asset' || role === 'github-release-metadata');
  const carriers = catalog.carriers;
  const publicRows = decodedRows;
  return {
    publication,
    descriptor,
    catalog,
    carriers,
    publicRows,
    inputContext: context,
    sourceFiles: [...sources].map(([file, { sha }]) => ({ path: file, sha })),
  };
}

async function completedRegistryCarrier(
  publication,
  carrier,
  files,
  declaredRegistry,
  options,
  frozenCarrier = undefined,
) {
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
  if (frozenCarrier) {
    const identities = (artifacts) =>
      artifacts
        .map((artifact) => ({
          name: path.basename(artifact.path),
          size: artifact.size,
          sha256: artifact.sha256,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    requireValue(
      same(identities(published.artifacts), identities(frozenCarrier.artifacts)),
      'completed registry Files differ from frozen metadata',
    );
  }
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
  {
    publication,
    carriers,
    metadataBaseline,
  }: Pick<CompletedDeliveryBaseline, 'publication' | 'carriers' | 'metadataBaseline'>,
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    registryOptions = {},
    assertMetadataBaseline = assertAuthenticatedNativePublicBaseline,
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
  const inventory = await readCompletedNativeDeliveryInventory(publication, {
    repository,
    assertCompletedPublication,
    readJson,
    metadataBaseline,
    assertMetadataBaseline,
  });
  const { catalog, descriptor } = inventory;
  const declaredRegistry = catalog.carriers.map(({ id }) => id.replace(/^cargo:/u, 'crates:'));
  const archives = [];
  const unknowns = [];
  for (const [id, files] of Object.entries(carriers)) {
    const separator = id.indexOf(':');
    requireValue(separator > 0, 'registry input lacks its canonical identity');
    const frozenCarrier = metadataBaseline
      ? inventory.carriers.find((row) => row.id === id)
      : undefined;
    requireValue(
      !metadataBaseline || frozenCarrier,
      'registry input is absent from frozen metadata',
    );
    const carrier =
      frozenCarrier ??
      resolveActualCarrier(catalog, id.slice(0, separator), id.slice(separator + 1));
    requireValue(carrier.id === id, 'registry input has a different canonical identity');
    const { published, registryProof } = await completedRegistryCarrier(
      publication,
      carrier,
      files,
      declaredRegistry,
      registryOptions,
      frozenCarrier,
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
const isPublicPayload = ({ kind }) =>
  !['checksums', NATIVE_PUBLICATION_METADATA_KIND].includes(kind);
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
    // Names come from the authenticated frozen inventory or the bounded legacy
    // decoder. Preserve variants while removing only the own publication version.
    row.name.replace(version, '{version}'),
  ]);

/** Genuine completed public files only; there are no historical producer roots here. */
export async function captureCompletedNativePublicArtifacts(
  {
    publication,
    files,
    metadataBaseline,
  }: Pick<CompletedDeliveryBaseline, 'publication' | 'metadataBaseline'> & {
    files: Record<string, string>;
  },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    assertMetadataBaseline = assertAuthenticatedNativePublicBaseline,
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    same(await assertCompletedPublication(publication), publication),
    'completed public origin differs from requested source/version',
  );
  const inventory = await readCompletedNativeDeliveryInventory(publication, {
    repository,
    assertCompletedPublication,
    readJson,
    metadataBaseline,
    assertMetadataBaseline,
  });
  const rows = inventory.publicRows;
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
  // Metadata v1 excludes the separate outer checksum envelopes. Their actual
  // names come from this completed release; full public verification owns their
  // contents/coverage. Do not regenerate them from today's product recipes.
  const excludedEnvelopes = metadataBaseline
    ? assets.filter(({ name }) => name === metadataName || name.endsWith('.sha256'))
    : metadataAssets;
  const payloadAssets = assets.filter(
    ({ name }) =>
      rows.some((row) => row.name === name) || !excludedEnvelopes.some((row) => row.name === name),
  );
  if (
    metadataAssets.length > 1 ||
    new Set(assets.map(({ name }) => name)).size !== assets.length ||
    !same(payloadAssets.map(({ name }) => name).sort(), rows.map(({ name }) => name).sort())
  )
    unknowns.push('completed-public-asset-inventory-differs');
  if (
    Object.keys(files).some(
      (id) =>
        !rows.some((row) => row.id === id) &&
        !excludedEnvelopes.some(({ name }) => id === `github-release:${name}`),
    )
  )
    unknowns.push('completed-public-artifact-inventory-differs');
  const archives = [];
  for (const row of rows) {
    const contract = publicDeliveryContract(row);
    if (!contract && row.kind !== 'checksums') {
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
    if (row.sha256 !== undefined)
      requireValue(
        identity.size === row.size && identity.sha256 === row.sha256,
        'completed public File differs from frozen metadata',
      );
    const proof = asset.digest
      ? { bytes: asset.size, sha256: asset.digest.slice(7) }
      : await proveAsset(asset.url, row.name, asset.size);
    requireValue(
      identity.size === asset.size &&
        identity.size === proof.bytes &&
        identity.sha256 === proof.sha256,
      'completed public archive bytes differ',
    );
    if (row.kind === 'checksums') continue;
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

/** Reconstructed Git delivery uses the same authenticated completed binding archive.
 * It is never interpreted as a published GitHub asset or an old Bazel output. */
export async function captureCompletedNativeSwiftSourceSuppliers(
  {
    publication,
    files,
    carriers = {},
    sourceTags,
    metadataBaseline,
  }: {
    publication: CompletedPublication;
    files: Record<string, string>;
    carriers?: Record<string, string[]>;
    sourceTags: NativeSupplierArtifact[];
    metadataBaseline?: ReturnType<typeof assertAuthenticatedNativePublicBaseline>;
  },
  {
    repository = 'f0rr0/oliphaunt',
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
    proveAsset = requestReleaseAssetProof,
    registryOptions = {},
    assertMetadataBaseline = assertAuthenticatedNativePublicBaseline,
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  const rows = validateNativeSupplierArtifacts(sourceTags);
  requireValue(rows.length === 1, 'one completed Swift source-tag input is required');
  const row = rows[0];
  requireValue(
    same(row.publication, publication) &&
      row.source &&
      row.artifact === `swift-source-tag:${publication.version}`,
    'completed Swift source-tag input differs from its publication',
  );
  const completions = new Map<string, Promise<CompletedPublication>>();
  const completed = (value: CompletedPublication) => {
    const key = stable(value);
    let result = completions.get(key);
    if (!result) {
      result = Promise.resolve(assertCompletedPublication(value));
      completions.set(key, result);
    }
    return result;
  };
  const reads = new Map<string, Promise<any>>();
  const read = (endpoint: string) => {
    let result = reads.get(endpoint);
    if (!result) {
      result = Promise.resolve(readJson(endpoint));
      reads.set(endpoint, result);
    }
    return result;
  };
  const options = {
    repository,
    assertCompletedPublication: completed,
    readJson: read,
    readPages,
    proveAsset,
    registryOptions,
    metadataBaseline,
    assertMetadataBaseline,
  };
  const publicOrigin = await captureCompletedNativePublicArtifacts(
    { publication, files, metadataBaseline },
    options,
  );
  const binding = publicOrigin.archives.filter(({ kind }) => kind === 'swift-bindings');
  requireValue(
    binding.length === 1,
    'completed Swift source requires its authenticated binding archive',
  );
  const { descriptor } = await readCompletedNativeDeliveryInventory(publication, options);
  requireValue(
    descriptor.publish_targets?.includes('swift-package-source-tag'),
    'completed owner does not declare a Swift source-tag delivery',
  );
  const replayed = await replayCompletedSwiftSourceArchive(
    {
      publication,
      descriptor,
      bindings: { name: binding[0].name, sha256: binding[0].sha256 },
      source: row.source!,
      file: row.file,
    },
    options,
  );
  const registry = Object.keys(carriers).length
    ? await captureCompletedNativeRegistryCarriers(
        { publication, carriers, metadataBaseline },
        options,
      )
    : undefined;
  return {
    ...publicOrigin,
    archives: [
      ...publicOrigin.archives,
      ...(registry?.archives ?? []),
      {
        id: row.artifact,
        name: row.artifact,
        target: 'portable',
        size: replayed.file.size,
        sha256: replayed.file.sha256,
        members: replayed.members,
      },
    ],
    unknowns: [...publicOrigin.unknowns, ...(registry?.unknowns ?? [])],
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
    unreleasedProducts = [] as string[],
    assertMetadataBaseline = assertAuthenticatedNativePublicBaseline,
  } = {},
) {
  requireValue(repository === 'f0rr0/oliphaunt', 'unsupported repository');
  requireValue(
    candidate.scope === 'construction' && !candidate.missing?.length,
    'requires a complete physical construction candidate',
  );
  validatePublicationCandidate(candidate);
  requireValue(
    Array.isArray(unreleasedProducts) &&
      new Set(unreleasedProducts).size === unreleasedProducts.length &&
      unreleasedProducts.every((id) =>
        candidate.products.some((product) => product.id === id && product.version === '0.0.0'),
      ) &&
      unreleasedProducts.every(
        (id) => !baselines.some((baseline) => baseline.publication.product === id),
      ),
    'first publications require unique explicit version-zero products without completed baselines',
  );
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
      const firstPublication = unreleasedProducts.includes(product.id);
      products.push({
        product: product.id,
        deliveryStatus: firstPublication ? ('different' as const) : ('unknown' as const),
        reason: firstPublication ? 'verified-first-publication' : 'missing-completed-publication',
        ...(firstPublication
          ? {
              contractChanges: { added: [`product:${product.id}`], removed: [] as string[] },
              comparisons: [] as any[],
              unknowns: [] as string[],
            }
          : {}),
        ...bindings,
      });
      continue;
    }
    const publication = await assertCompletedPublication(baseline.publication);
    requireValue(
      same(publication, baseline.publication),
      'completed publication differs from requested source/version',
    );
    const inventory = await readCompletedNativeDeliveryInventory(publication, {
      repository,
      assertCompletedPublication,
      readJson,
      metadataBaseline: baseline.metadataBaseline,
      assertMetadataBaseline,
    });
    const { descriptor } = inventory;
    const declaredRegistry = inventory.catalog.carriers.map(({ id }) =>
      id.replace(/^cargo:/u, 'crates:'),
    );
    const unknowns: string[] = [];
    const comparisons = [];
    const publishedCarriers = [];
    for (const carrier of inventory.carriers)
      if (!baseline.carriers[carrier.id]?.length)
        unknowns.push(`completed-carrier-missing:${carrier.id}`);
    for (const [id, files] of Object.entries(baseline.carriers).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const separator = id.indexOf(':');
      const frozenCarrier = baseline.metadataBaseline
        ? inventory.carriers.find((row) => row.id === id)
        : undefined;
      requireValue(
        !baseline.metadataBaseline || frozenCarrier,
        'completed carrier is absent from frozen metadata',
      );
      let carrier;
      try {
        carrier =
          frozenCarrier ??
          resolveActualCarrier(inventory.catalog, id.slice(0, separator), id.slice(separator + 1));
      } catch {
        unknowns.push(`completed-carrier-undeclared:${id}`);
        continue;
      }
      const { published, registryProof } = await completedRegistryCarrier(
        publication,
        carrier,
        files,
        declaredRegistry,
        registryOptions,
        frozenCarrier,
      );
      const beforeFiles = boundArtifacts(published.artifacts);
      const current = carriers.find((row) => row.id === carrier.id);
      const currentFiles = current ? boundArtifacts(current.artifacts) : [];
      const before = nativeCarrierDeliveryMembers(published);
      const after = current ? nativeCarrierDeliveryMembers(current) : undefined;
      for (const { file, before: identity } of [...beforeFiles, ...currentFiles])
        requireValue(
          same(fileIdentity(file), identity),
          'carrier changed during delivery comparison',
        );
      publishedCarriers.push(published);
      if (!before || (current && !after))
        unknowns.push(`unsupported-registry-delivery-contract:${carrier.id}`);
      else if (current)
        comparisons.push({
          id: carrier.id,
          kind: carrier.ecosystem,
          differentMembers: differentNativeDeliveredMembers(before, after),
          registryProof,
        });
    }
    validateCargoPayloadPartSets(publishedCarriers);
    const publicRows = inventory.publicRows.filter(isPublicPayload);
    const finalInputs = currentArtifacts.filter(
      (row) =>
        ['github-release-asset', 'github-release-metadata'].includes(row.role) &&
        isPublicPayload(row),
    );
    requireValue(
      new Set(publicRows.map((row) => artifactSlot(row))).size === publicRows.length &&
        new Set(finalInputs.map((row) => artifactSlot(row, product.version))).size ===
          finalInputs.length,
      'ambiguous canonical public artifact slot',
    );
    const previousContracts = new Set([
      ...publishedCarriers.map(({ id }) => id),
      ...publicRows.map((row) => `public:${artifactSlot(row)}`),
      ...(descriptor.publish_targets ?? []).map((target) => `publish:${target}`),
    ]);
    const currentContracts = new Set([
      ...carriers.map(({ id }) => id),
      ...finalInputs.map((row) => `public:${artifactSlot(row, product.version)}`),
      ...product.publishTargets.map((target) => `publish:${target}`),
    ]);
    const contractChanges = {
      added: [...currentContracts].filter((id) => !previousContracts.has(id)).sort(),
      removed: [...previousContracts].filter((id) => !currentContracts.has(id)).sort(),
    };
    let capturedPublic;
    if (publicRows.length) {
      const captured = await captureCompletedNativePublicArtifacts(
        {
          publication,
          files: baseline.productArtifacts ?? {},
          metadataBaseline: baseline.metadataBaseline,
        },
        {
          repository,
          assertCompletedPublication,
          readJson,
          readPages,
          proveAsset,
          assertMetadataBaseline,
        },
      );
      capturedPublic = captured;
      unknowns.push(...captured.unknowns);
      for (const row of captured.archives) {
        const current = finalInputs.find(
          (input) => artifactSlot(input, product.version) === artifactSlot(row),
        );
        if (!current) continue;
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
    if (descriptor.publish_targets?.includes('swift-package-source-tag')) {
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
        if (product.publishTargets.includes('swift-package-source-tag'))
          comparisons.push({
            id: 'release-input:swiftpm-release-tree',
            kind: 'swiftpm-release-tree',
            differentMembers: differentNativeDeliveredMembers(
              sourceTag.members,
              currentSwiftSourceTagMembers(candidate),
            ),
            sourceTag: sourceTag.source,
            nativePublication: sourceTag.nativePublication,
          });
      }
    }
    if (!comparisons.length && !contractChanges.added.length && !contractChanges.removed.length)
      unknowns.push('delivered-contract-inventory-empty');
    products.push({
      product: product.id,
      origin: publication,
      deliveryStatus: unknowns.length
        ? ('unknown' as const)
        : contractChanges.added.length ||
            contractChanges.removed.length ||
            comparisons.some(({ differentMembers }) => differentMembers.length)
          ? ('different' as const)
          : ('identical' as const),
      comparisons,
      contractChanges,
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
