import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { wasixSeedConsumerDeclaration } from '../../src/database-resources/seeds/wasix/consumer-contract.mts';
import { staticMemberAliases } from '../../src/extensions/artifacts/native/tools/ios-extension-registration.mts';
import { loadContribCarriers } from '../../src/extensions/artifacts/packages/tools/contrib-carriers.mts';
import { validateExtensionTargetProfiles } from '../../src/extensions/contracts/extension-target-profiles.mts';
import {
  resolveNativeComponentClosure,
  validateNativeComponentContract,
} from '../../src/extensions/tools/native-component-contract.mts';
import { nativeCargoArtifactRows } from '../packaging/rust-native-targets.mts';
import { validateNativeSupplierPublications } from './bazel-shipping-inputs.mts';
import {
  cargoCompatibilityDependency,
  compatibilityVersionFromText,
} from './compatibility-version-parser.mts';
import {
  contribExtensionMetadata,
  declaredExtensionMetadata,
  extensionPublicationMetadataRows,
  extensionSourceMetadata,
} from './extension-release-metadata.mts';
import {
  projectNativeAppleBaseInput,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from './native-extension-final-inputs.mts';
import { projectNativeSeedInputs } from './native-seed-inputs.mts';
import { projectNativeSupplierArtifacts } from './native-supplier-artifacts.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import {
  databaseResourceArtifactRows,
  expectedExtensionGithubReleaseAssetRows,
  extensionRegistryPackageTargetSetsFromRows,
  extensionReleaseMetadataRows,
  nativeHelperArtifactRows,
  nativeRuntimeArtifactRows,
  runtimeExtensionTargetRowsFromConfigs,
  swiftArtifactRows,
  validateExtensionCatalogRows,
  wasixArtifactRows,
} from './release-artifact-targets.mts';

export interface ProductIdentity {
  id: string;
  path: string;
  version: string;
  registry_packages: string[];
  publish_targets: string[];
  artifact_targets: { preset: string; targets: string[] } | null;
  compatibility_versions: Record<string, string>;
  cargo_artifacts: {
    sourceProduct: string;
    target: string;
    packageKind: string;
    packageName: string;
  }[];
}

export interface ReleaseMetadata {
  products: Record<string, ProductIdentity>;
  contribOwners: { native: string; wasix: string };
  contribMembers: Record<string, unknown>[];
  postgresSource: Record<string, unknown>;
  extensions: Record<string, Record<string, unknown>>;
  wasixExtensions: Record<string, Record<string, unknown>>;
  extensionSources: Record<string, Record<string, unknown>>;
  extensionRecipes: Record<string, Record<string, unknown>>;
  extensionCompatibility: Record<string, Record<string, unknown>>;
  extensionDependencies: Record<string, Record<string, Record<string, unknown>>>;
  extensionReleaseMetadata: Record<string, unknown>[];
  extensionGithubArtifacts: Record<string, unknown>[];
  extensionProfiles: Record<string, unknown>;
  nativeComponents: Record<string, unknown>;
  nativeComponentSources: Record<string, Record<string, unknown>>;
  nativeMobileComponentClosures: Record<
    string,
    Record<string, { linkUnits: string[]; runtimeFiles: string[] }>
  >;
  nativeMobileMemberAliases: Record<string, Record<string, string>>;
  publicationCarriers: {
    product: string;
    ecosystem: string;
    name: string;
    version: string;
    target: string | null;
    role: string;
  }[];
  nativeHelperArtifacts: Record<string, unknown>[];
  nativeRuntimeArtifacts: Record<string, unknown>[];
  wasixArtifacts: Record<string, unknown>[];
  databaseResourceContract: Record<string, unknown> | null;
  databaseResourceWasixConsumer: ReturnType<typeof wasixSeedConsumerDeclaration> | null;
  databaseResourceArtifacts: Record<string, unknown>[];
  databaseSeedCarriers: ReturnType<typeof seedCarrierIdentities>;
  inputs: Record<string, string | null>;
  directories: Record<string, string[] | null>;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be a string`);
  return value;
}

function strings(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry))
    throw new Error(`${context} must be a string list`);
  if (new Set(value).size !== value.length) throw new Error(`${context} must be unique`);
  return value;
}

/** Analysis consumes physical unit IDs from the existing canonical resolver. */
export function nativeMobileComponentInputs(
  raw: Record<string, unknown>,
  sqlNames: string[],
  profiles: { target: string; family: string; kind: string }[],
) {
  const components = validateNativeComponentContract(raw, {
    checkSourcePaths: false,
    knownExtensions: new Set(sqlNames),
    targetProfiles: new Map(profiles.map((row) => [row.target, `${row.family}\0${row.kind}`])),
  });
  const mobile = profiles.filter(
    (row) => row.family === 'native' && row.kind === 'native-static-registry',
  );
  return Object.fromEntries(
    [...sqlNames].sort().map((sqlName) => [
      sqlName,
      Object.fromEntries(
        mobile.map((row) => {
          const closure = resolveNativeComponentClosure(components, {
            extension: sqlName,
            family: row.family,
            kind: row.kind,
            target: row.target,
          });
          return [row.target, { linkUnits: closure.linkUnits, runtimeFiles: closure.runtimeFiles }];
        }),
      ),
    ]),
  );
}

export function nativeMobileMemberAliasInputs(catalog: Map<string, Record<string, unknown>>) {
  return Object.fromEntries(
    [...catalog.values()].map((row) => {
      const sqlName = string(row['sql-name'], 'static alias SQL name');
      const module = row['native-module-file'];
      if (module !== undefined && (typeof module !== 'string' || !module.endsWith('.so')))
        throw new Error(`static aliases require the canonical module stem for ${sqlName}`);
      const stem = typeof module === 'string' ? module.slice(0, -3) : null;
      return [
        sqlName,
        Object.fromEntries(
          staticMemberAliases(sqlName, stem).map(({ name, address }) => [name, address]),
        ),
      ];
    }),
  );
}

export function extensionGithubArtifactInputs(
  identity: {
    artifactProduct: string;
    owner: string;
    version: string;
    sqlNames: string[];
    family?: 'native' | 'wasix' | null;
  },
  profiles: { target: string; family: string; kind: string }[],
  catalog: Map<string, Record<string, unknown>>,
  mobile: ReleaseMetadata['nativeMobileComponentClosures'],
) {
  const selectedFamily = identity.family === undefined ? 'native' : identity.family;
  const requiredRows = identity.sqlNames.flatMap((sqlName) => {
    const descriptor = catalog.get(sqlName);
    if (!descriptor) throw new Error(`extension asset inventory is missing ${sqlName}`);
    const module = descriptor['native-module-file'];
    if (module !== undefined && (typeof module !== 'string' || !module.endsWith('.so')))
      throw new Error(
        `extension asset inventory requires the canonical module stem for ${sqlName}`,
      );
    return profiles
      .filter(
        (row) =>
          (selectedFamily === null || row.family === selectedFamily) &&
          (row.family === 'native' || row.target === 'wasix-portable'),
      )
      .flatMap(({ family, target }) => {
        const runtime = {
          sqlName,
          family,
          target,
          kind: family === 'wasix' ? 'wasix-runtime' : 'runtime',
          identity: null,
        };
        if (target !== 'ios-xcframework' || module === undefined) return [runtime];
        const closure = mobile[sqlName]?.[target];
        if (!closure) throw new Error(`extension asset inventory is missing ${sqlName}/${target}`);
        return [
          runtime,
          { sqlName, family, target, kind: 'ios-xcframework', identity: module.slice(0, -3) },
          ...closure.linkUnits.map((dependency) => ({
            sqlName,
            family,
            target,
            kind: 'ios-dependency-xcframework',
            identity: dependency,
          })),
        ];
      });
  });
  requiredRows.sort((left, right) => {
    const a = `${left.sqlName}:${left.family}:${left.target}:${left.kind}:${left.identity ?? ''}`;
    const b = `${right.sqlName}:${right.family}:${right.target}:${right.kind}:${right.identity ?? ''}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return expectedExtensionGithubReleaseAssetRows(
    { id: identity.artifactProduct, version: identity.version, family: selectedFamily },
    { sqlNames: identity.sqlNames, requiredRows },
  ).map((row) => ({
    artifactProduct: identity.artifactProduct,
    owner: identity.owner,
    product: identity.owner,
    version: identity.version,
    id: `github-release:${row.name}`,
    role: 'github-release-asset',
    family: row.family,
    kind: row.kind,
    target: row.target,
    identity: row.identity,
    name: row.name,
  }));
}

export function repositoryPath(value: string): string {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`metadata path must stay inside the repository: ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadReleaseMetadata(root: string): ReleaseMetadata {
  const inputs: Record<string, string | null> = {};
  const directories: Record<string, string[] | null> = {};
  const read = (file: string) => {
    const relative = repositoryPath(file);
    const content = readFileSync(path.join(root, relative), 'utf8');
    inputs[relative] = content;
    return content;
  };
  const json = (file: string) => object(JSON.parse(read(file)), file);
  const toml = (file: string) => object(Bun.TOML.parse(read(file)), file);
  const optionalToml = (file: string) => {
    try {
      return toml(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Absence is also an input: adding a recipe must invalidate the import.
      inputs[repositoryPath(file)] = null;
      return undefined;
    }
  };
  const config = object(json('release-please-config.json').packages, 'release packages');
  const versions = json('.release-please-manifest.json');
  const products: Record<string, ProductIdentity> = {};
  const descriptors = new Map<string, Record<string, unknown>>();
  for (const [source, raw] of Object.entries(config).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const productPath = repositoryPath(source);
    const id = string(object(raw, source).component, `${source}.component`);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid release product id ${id}`);
    if (Object.hasOwn(products, id)) throw new Error(`duplicate release product ${id}`);
    const version = string(versions[source], `${source} release version`);
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
      throw new Error(`${id} must have a stable release version, got ${version}`);
    }
    const descriptor = toml(`${productPath}/release.toml`);
    if (descriptor.id !== id) throw new Error(`${productPath}/release.toml disagrees with ${id}`);
    const artifactTargets =
      descriptor.artifact_targets === undefined
        ? null
        : object(descriptor.artifact_targets, `${id}.artifact_targets`);
    products[id] = {
      id,
      path: productPath,
      version,
      registry_packages: strings(descriptor.registry_packages ?? [], `${id}.registry_packages`),
      publish_targets: strings(descriptor.publish_targets ?? [], `${id}.publish_targets`),
      compatibility_versions: {},
      cargo_artifacts: [],
      artifact_targets:
        artifactTargets === null
          ? null
          : {
              preset: string(artifactTargets.preset, `${id}.artifact_targets.preset`),
              targets: strings(artifactTargets.targets, `${id}.artifact_targets.targets`),
            },
    };
    if (id === 'liboliphaunt-native' || id === 'oliphaunt-broker') {
      if (products[id].artifact_targets === null)
        throw new Error(`${id} has no canonical artifact targets`);
      products[id].cargo_artifacts = nativeCargoArtifactRows(
        id,
        products[id].artifact_targets.targets,
        products[id].registry_packages,
      );
    }
    descriptors.set(id, descriptor);
  }
  const contrib = toml('src/extensions/contrib/carriers.toml');
  const contribOwners = {
    native: string(contrib.native_owner, 'contrib.native_owner'),
    wasix: string(contrib.wasix_owner, 'contrib.wasix_owner'),
  };
  for (const owner of Object.values(contribOwners)) {
    if (!Object.hasOwn(products, owner)) throw new Error(`unknown contrib release owner ${owner}`);
  }
  if (contribOwners.native === contribOwners.wasix) {
    throw new Error('native and WASIX contrib must have distinct release owners');
  }
  const memberManifest = string(contrib.member_manifest, 'contrib.member_manifest');
  const members = toml(memberManifest).extensions;
  if (!Array.isArray(members) || members.length === 0)
    throw new Error('contrib members must be nonempty');
  const contribMembers = members.map((member) => object(member, 'contrib member'));
  const ids = new Set<string>();
  for (const member of contribMembers) {
    const id = string(member.id, 'contrib member.id');
    if (ids.has(id)) throw new Error(`duplicate contrib member ${id}`);
    ids.add(id);
  }
  // Pin inputs remain acquisition facts; publication versions remain product facts.
  const postgresSource = toml(string(contrib.source, 'contrib.source'));
  toml(string(contrib.contract, 'contrib.contract'));
  const catalog = json('src/extensions/catalog/extensions.source.json').extensions;
  if (!Array.isArray(catalog)) throw new Error('extension catalog must have an extensions array');
  const extensions: ReleaseMetadata['extensions'] = {};
  for (const value of catalog) {
    const row = object(value, 'extension');
    const id = string(row.id, 'extension.id');
    if (Object.hasOwn(extensions, id)) throw new Error(`duplicate extension ${id}`);
    extensions[id] = row;
  }
  for (const member of contribMembers) {
    const id = member.id as string;
    if (!Object.hasOwn(extensions, id))
      throw new Error(`contrib member ${id} is absent from the catalog`);
  }
  const extensionSources: ReleaseMetadata['extensionSources'] = {};
  const extensionRecipes: ReleaseMetadata['extensionRecipes'] = {};
  const extensionCompatibility: ReleaseMetadata['extensionCompatibility'] = {};
  const extensionDependencies: ReleaseMetadata['extensionDependencies'] = {};
  for (const [product, descriptor] of descriptors) {
    if (descriptor.extension === undefined) continue;
    const extension = object(descriptor.extension, `${product}.extension`);
    if (extension.class !== 'external') continue;
    const sqlName = string(extension.sql_name, `${product}.extension.sql_name`);
    if (!Object.hasOwn(extensions, sqlName))
      throw new Error(`external extension ${sqlName} is absent from the catalog`);
    if (Object.hasOwn(extensionSources, sqlName))
      throw new Error(`duplicate external SQL identity ${sqlName}`);
    const source = object(extension.source, `${product}.extension.source`);
    const sourcePath = string(source.path, `${product}.extension.source.path`);
    extensionSources[sqlName] = {
      ...toml(sourcePath),
      product,
    };
    extensionCompatibility[sqlName] = object(
      extension.compatibility,
      `${product}.extension.compatibility`,
    );
    const directory = repositoryPath(`${path.posix.dirname(sourcePath)}/dependencies`);
    extensionDependencies[sqlName] = {};
    try {
      const entries = readdirSync(path.join(root, directory), { withFileTypes: true });
      directories[directory] = entries.map(({ name }) => name).sort();
      for (const entry of entries) {
        if (entry.isSymbolicLink())
          throw new Error(`${directory}/${entry.name} cannot be a symlink`);
        if (!entry.isDirectory()) continue;
        extensionDependencies[sqlName][entry.name] = toml(`${directory}/${entry.name}/source.toml`);
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        directories[directory] !== undefined
      )
        throw error;
      directories[directory] = null;
    }
    const recipe = optionalToml(`${path.posix.dirname(sourcePath)}/recipe.toml`);
    if (recipe) {
      if (recipe.sql_name !== sqlName)
        throw new Error(`${product} recipe disagrees with SQL identity ${sqlName}`);
      extensionRecipes[sqlName] = recipe;
    }
  }
  const extensionProfiles = toml('src/extensions/contracts/extension-target-profiles.toml');
  const nativeComponents = toml('src/extensions/catalog/native-components.toml');
  const nativeComponentSources: Record<string, Record<string, unknown>> = {};
  for (const component of nativeComponents.components as Record<string, unknown>[]) {
    if (component['source-path']) continue;
    const name = string(component.source, 'native component source');
    const dependencies = Object.values(extensionDependencies)
      .flatMap((rows) => Object.entries(rows))
      .filter(([key]) => key === name)
      .map(([, source]) => source);
    if (dependencies.length > 0) {
      if (dependencies.some((source) => JSON.stringify(source) !== JSON.stringify(dependencies[0])))
        throw new Error(`native component ${name} has conflicting canonical acquisitions`);
      nativeComponentSources[name] = dependencies[0];
    } else {
      const source = optionalToml(`src/third-party/${repositoryPath(name)}/source.toml`);
      if (source) nativeComponentSources[name] = source;
    }
  }
  const publicationProducts = Object.fromEntries(
    [...descriptors].map(([product, descriptor]) => [
      product,
      {
        ...descriptor,
        path: products[product].path,
        version: products[product].version,
      },
    ]),
  );
  const canonicalContrib = loadContribCarriers(root, 'release metadata', { readText: read });
  const targetRows = validateExtensionTargetProfiles(extensionProfiles).targets;
  const allowed = new Set(
    runtimeExtensionTargetRowsFromConfigs(
      publicationProducts,
      'release metadata',
      canonicalContrib,
    ).map((row) => `${row.target}\0${row.family}\0${row.kind}`),
  );
  for (const row of targetRows) {
    if (!allowed.has(`${row.target}\0${row.family}\0${row.kind}`)) {
      throw new Error(
        `extension target ${row.target}/${row.family}/${row.kind} is not backed by runtime artifact metadata`,
      );
    }
  }
  const generatedCatalog = validateExtensionCatalogRows(
    json('src/extensions/generated/extensions.catalog.json'),
    'release metadata',
  );
  const wasixCatalog = json('src/extensions/generated/wasix/extensions.json').extensions;
  if (!Array.isArray(wasixCatalog)) throw new Error('WASIX extensions must be an array');
  const wasixExtensions: ReleaseMetadata['wasixExtensions'] = {};
  for (const value of wasixCatalog) {
    const row = object(value, 'WASIX extension');
    const sqlName = string(row['sql-name'], 'WASIX extension SQL name');
    if (Object.hasOwn(wasixExtensions, sqlName))
      throw new Error(`duplicate WASIX extension ${sqlName}`);
    wasixExtensions[sqlName] = row;
  }
  const moduleMembers = new Set(
    [...generatedCatalog]
      .filter(([, row]) => typeof row['native-module-file'] === 'string')
      .map(([name]) => name),
  );
  const nativeMobileComponentClosures = nativeMobileComponentInputs(
    nativeComponents,
    [...generatedCatalog.values()].map((row) =>
      string(row['sql-name'], 'native component SQL name'),
    ),
    targetRows,
  );
  const nativeMobileMemberAliases = nativeMobileMemberAliasInputs(generatedCatalog);
  const contribSqlNames = canonicalContrib.members
    .map((member) => string(member['sql-name'], 'contrib SQL name'))
    .sort();
  for (const name of contribSqlNames) {
    if (!generatedCatalog.has(name))
      throw new Error(`contrib member ${name} is absent from generated extension catalog`);
  }
  const contribRegistryTargets = extensionRegistryPackageTargetSetsFromRows(
    canonicalContrib.artifactProduct,
    contribSqlNames,
    contribSqlNames.flatMap((sqlName) => targetRows.map((row) => ({ ...row, sqlName }))),
    contribSqlNames.filter((name) => moduleMembers.has(name)),
    'release metadata',
  );
  const publicationCarriers = loadPublicationCatalog('release metadata', {
    inputContext: {
      products: publicationProducts,
      contrib: canonicalContrib,
      contribRegistryTargets,
    },
  }).carriers.map(({ product, ecosystem, name, version, target, role }) => ({
    product,
    ecosystem,
    name,
    version,
    target,
    role,
  }));
  // Read authored installed requirements through the same parser as release
  // preparation. Workspace producer versions do not replace these pins.
  for (const [product, descriptor] of descriptors) {
    const entries = object(
      descriptor.compatibility_versions ?? {},
      `${product}.compatibility_versions`,
    );
    for (const [id, value] of Object.entries(entries)) {
      const entry = object(value, `${product}.compatibility_versions.${id}`);
      const sourceProduct = string(entry.source_product, `${product}.${id}.source_product`);
      if (!Object.hasOwn(products, sourceProduct))
        throw new Error(`unknown compatibility product ${sourceProduct}`);
      const file = string(entry.path, `${product}.${id}.path`);
      const parser = string(entry.parser, `${product}.${id}.parser`);
      const locator = { id, path: file, parser };
      const text = read(file);
      const dependency = cargoCompatibilityDependency(locator, text);
      if (dependency?.path !== undefined) continue;
      const carrier =
        dependency &&
        publicationCarriers.find(
          (row) =>
            row.product === sourceProduct &&
            row.ecosystem === 'cargo' &&
            row.name === dependency.packageName,
        );
      if (
        carrier?.target === null &&
        publicationCarriers.some(
          (row) =>
            row.product === sourceProduct && row.ecosystem === 'cargo' && row.target !== null,
        )
      )
        continue;
      const version = compatibilityVersionFromText(locator, text, {
        prefix: 'release metadata',
      });
      const prior = products[product].compatibility_versions[sourceProduct];
      if (prior !== undefined && prior !== version)
        throw new Error(
          `${product} declares conflicting compatibility versions for ${sourceProduct}`,
        );
      products[product].compatibility_versions[sourceProduct] = version;
    }
  }
  const nativeHelperArtifacts = ['oliphaunt-broker', 'oliphaunt-node-direct'].flatMap((product) => {
    const identity = products[product];
    if (!identity) return [];
    if (!identity.artifact_targets)
      throw new Error(`${product} must declare artifact targets for native helper construction`);
    return nativeHelperArtifactRows(product, identity.artifact_targets.targets, 'release metadata');
  });
  const nativeRuntimeArtifacts = ['liboliphaunt-native', 'postgres-tools-native'].flatMap(
    (product) => {
      const identity = products[product];
      if (!identity) return [];
      if (!identity.artifact_targets)
        throw new Error(`${product} must declare artifact targets for native runtime construction`);
      return nativeRuntimeArtifactRows(
        product,
        identity.artifact_targets.targets,
        'release metadata',
      );
    },
  );
  const databaseResourceContract = products['database-resources']
    ? json('src/database-resources/contracts/contract.json')
    : null;
  const databaseResourceWasixConsumer = databaseResourceContract
    ? wasixSeedConsumerDeclaration(
        toml('src/database-resources/seeds/wasix/Cargo.toml'),
        products['database-resources'].compatibility_versions['liboliphaunt-wasix'],
        products['liboliphaunt-wasix'].version,
      )
    : null;
  const databaseResourceArtifacts = databaseResourceContract
    ? databaseResourceArtifactRows(databaseResourceContract)
    : [];
  const databaseSeedCarriers = databaseResourceContract
    ? seedCarrierIdentities(databaseResourceContract)
    : [];
  const wasixArtifacts = [
    'liboliphaunt-wasix',
    'postgres-tools-wasix',
    'liboliphaunt-wasix-postmaster',
    'oliphaunt-wasix-napi',
  ].flatMap((product) => {
    const identity = products[product];
    if (!identity) return [];
    if (!identity.artifact_targets)
      throw new Error(`${product} must declare WASIX artifact targets`);
    return wasixArtifactRows(product, identity.artifact_targets.targets, 'release metadata');
  });
  const extensionReleaseMetadata = [];
  for (const [product, descriptor] of descriptors) {
    if (descriptor.extension === undefined) continue;
    const extension = object(descriptor.extension, `${product}.extension`);
    if (extension.class !== 'external') continue;
    const metadata = declaredExtensionMetadata(product, extension);
    extensionReleaseMetadata.push(
      ...extensionPublicationMetadataRows(
        product,
        metadata,
        extensionSourceMetadata(product, metadata, extensionSources[metadata.sqlName]),
        () => products[product].path,
      ),
    );
  }
  const artifactProduct = string(contrib.logical_product, 'contrib.logical_product');
  const postgresVersion = string(
    object(postgresSource.postgresql, 'postgresql').version,
    'postgresql.version',
  );
  const postgresMajor = postgresVersion.split('.')[0];
  if (!/^[1-9][0-9]*$/.test(postgresMajor))
    throw new Error('PostgreSQL must have a stable major version');
  const contribMetadata = contribExtensionMetadata({
    artifactProduct,
    sourcePath: string(contrib.source, 'contrib.source'),
    sqlNames: contribMembers.map((member) => string(member['sql-name'], 'contrib SQL name')).sort(),
    compatibility: {
      postgresMajor,
      extensionRuntimeContract: string(contrib.contract, 'contrib.contract'),
      nativeRuntimeProduct: contribOwners.native,
      nativeRuntimeVersion: products[contribOwners.native].version,
      wasixRuntimeProduct: contribOwners.wasix,
      wasixRuntimeVersion: products[contribOwners.wasix].version,
    },
  });
  extensionReleaseMetadata.push(
    ...extensionPublicationMetadataRows(
      artifactProduct,
      contribMetadata,
      extensionSourceMetadata(artifactProduct, contribMetadata, postgresSource),
      () => path.posix.dirname(memberManifest),
    ),
  );
  extensionReleaseMetadata.sort((left, right) => {
    const a = `${left.product}:${left.sqlName}`;
    const b = `${right.product}:${right.sqlName}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const extensionGithubArtifacts = [
    ...new Set(extensionReleaseMetadata.map((row) => row.artifactProduct)),
  ]
    .sort()
    .flatMap((artifactProduct) => {
      const rows = extensionReleaseMetadata.filter(
        (row) => row.artifactProduct === artifactProduct,
      );
      const owners =
        rows[0].class === 'contrib'
          ? [
              { owner: contribOwners.native, family: 'native' as const },
              { owner: contribOwners.wasix, family: 'wasix' as const },
            ]
          : [{ owner: string(artifactProduct, 'extension artifact product'), family: null }];
      return owners.flatMap(({ owner, family }) => {
        const identity = {
          artifactProduct: string(artifactProduct, 'extension artifact product'),
          owner,
          version: products[owner].version,
          sqlNames: rows.map((row) => string(row.sqlName, 'extension SQL name')),
          family,
        };
        return [
          ...extensionGithubArtifactInputs(
            identity,
            targetRows,
            generatedCatalog,
            nativeMobileComponentClosures,
          ),
          ...extensionReleaseMetadataRows(
            { id: identity.artifactProduct, version: identity.version },
            family,
          ).map(([kind, name]) => ({
            artifactProduct: identity.artifactProduct,
            owner,
            product: owner,
            version: identity.version,
            id: `github-release:${name}`,
            role: 'github-release-metadata',
            family,
            kind,
            target: 'portable',
            identity: null,
            name,
            control: true,
          })),
        ];
      });
    });
  return {
    products,
    contribOwners,
    contribMembers,
    postgresSource,
    extensions,
    wasixExtensions,
    extensionSources,
    extensionRecipes,
    extensionCompatibility,
    extensionDependencies,
    extensionReleaseMetadata,
    extensionGithubArtifacts,
    extensionProfiles,
    nativeComponents,
    nativeComponentSources,
    nativeMobileComponentClosures,
    nativeMobileMemberAliases,
    publicationCarriers,
    nativeHelperArtifacts,
    nativeRuntimeArtifacts,
    wasixArtifacts,
    databaseResourceContract,
    databaseResourceWasixConsumer,
    databaseResourceArtifacts,
    databaseSeedCarriers,
    inputs,
    directories,
  };
}

function starlark(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return `[${value.map(starlark).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}: ${starlark(child)}`)
      .join(', ')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('nonfinite metadata');
  return JSON.stringify(value);
}

/** Complete public GitHub declarations from the supplied source snapshot.
 * This view reuses the same owner/version renderers as the carrier graph. */
export function nativeSupplierGithubArtifactDeclarations(metadata: ReleaseMetadata) {
  const declared = (product: string) =>
    metadata.products[product]?.publish_targets.some(
      (target) => target === 'github-release' || target === 'github-release-assets',
    );
  const base = [
    ...metadata.nativeRuntimeArtifacts,
    ...metadata.nativeHelperArtifacts,
    ...metadata.wasixArtifacts,
    ...metadata.databaseResourceArtifacts,
    ...swiftArtifactRows(),
  ].flatMap((row) =>
    typeof row.product === 'string' &&
    typeof row.asset === 'string' &&
    Array.isArray(row.surfaces) &&
    row.surfaces.includes('github-release') &&
    declared(row.product)
      ? [{ product: row.product, asset: row.asset }]
      : [],
  );
  const extensions = metadata.extensionGithubArtifacts
    .map((row) => {
      const product = string(row.product, 'extension GitHub supplier owner');
      const version = string(row.version, 'extension GitHub supplier version');
      if (metadata.products[product]?.version !== version)
        throw new Error('extension GitHub supplier version differs from its declared owner');
      const name = string(row.name, 'extension GitHub supplier filename');
      return { product, asset: name.replaceAll(version, '{version}') };
    })
    .filter(({ product }) => declared(product));
  return [
    ...new Map(
      [...base, ...extensions].map((row) => [row.product + '\0' + row.asset, row]),
    ).values(),
  ];
}

export function nativePublicationInputProjection(value: unknown, _metadata?: ReleaseMetadata) {
  const snapshot = object(value, 'native publication inputs');
  if (
    Object.keys(snapshot).some(
      (key) =>
        ![
          'source',
          'seedControls',
          'supplierPublications',
          'extensionFinalInputs',
          'nativeAppleBase',
          'nativeSwiftSource',
          'selectedProducts',
          'supplierArtifacts',
        ].includes(key),
    )
  )
    throw new Error('native publication inputs contain unknown fields');
  const source = object(snapshot.source, 'native publication source');
  if (
    Object.keys(source).sort().join(',') !== 'commit,tree' ||
    ![source.commit, source.tree].every(
      (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha),
    )
  )
    throw new Error('native publication inputs require an exact source commit and tree');
  const supplierPublications = validateNativeSupplierPublications(
    snapshot.supplierPublications ?? [],
  );
  const seeds = projectNativeSeedInputs(
    snapshot.seedControls ?? [],
    source as { commit: string; tree: string },
  );
  const extensions = projectNativeExtensionFinalInputs(snapshot.extensionFinalInputs ?? []);
  const apple =
    snapshot.nativeAppleBase === undefined
      ? { input: null, files: [] }
      : projectNativeAppleBaseInput(snapshot.nativeAppleBase);
  const swift =
    snapshot.nativeSwiftSource === undefined
      ? { input: null, files: [] }
      : projectNativeSwiftSourceInput(snapshot.nativeSwiftSource);
  const selectedProducts = snapshot.selectedProducts === undefined ? [] : snapshot.selectedProducts;
  if (
    !Array.isArray(selectedProducts) ||
    selectedProducts.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(id)) ||
    new Set(selectedProducts).size !== selectedProducts.length
  )
    throw new Error('prepared native selected products require unique canonical IDs');
  const suppliers = projectNativeSupplierArtifacts(
    snapshot.supplierArtifacts === undefined ? [] : snapshot.supplierArtifacts,
  );
  for (const { publication } of Object.values(suppliers.artifacts)) {
    const matching = supplierPublications.find(
      (row) => row.product === publication.product && row.version === publication.version,
    );
    if (matching && Object.keys(matching).some((key) => matching[key] !== publication[key]))
      throw new Error('completed supplier artifact source conflicts with supplier publication');
  }
  return {
    selectedProducts: [...selectedProducts],
    nativeSwiftSource: swift.input,
    supplierArtifacts: suppliers.artifacts,
    supplierPublications: Object.fromEntries(
      supplierPublications.map((publication) => [
        `${publication.product}@${publication.version}`,
        publication,
      ]),
    ),
    seedControls: seeds.controls,
    extensionFinalInputs: extensions.leaves,
    nativeAppleBase: apple.input,
    files: [
      ...seeds.files,
      ...extensions.files,
      ...apple.files,
      ...swift.files,
      ...suppliers.files,
    ],
  };
}

export function renderReleaseMetadata(
  metadata: ReleaseMetadata,
  identityRule: string,
  publicationInputs = {
    supplierPublications: {},
    seedControls: {},
    extensionFinalInputs: {},
    nativeAppleBase: null,
    nativeSwiftSource: null,
    selectedProducts: [],
    supplierArtifacts: {},
    files: [],
  },
) {
  if (!identityRule.startsWith('@') || !identityRule.endsWith(':identity.bzl')) {
    throw new Error('identity rule must be a repository-qualified identity.bzl label');
  }
  for (const id of publicationInputs.selectedProducts)
    if (!Object.hasOwn(metadata.products, id))
      throw new Error(`unknown prepared native selected product: ${id}`);
  const definitions = {
    PRODUCTS: metadata.products,
    CONTRIB_OWNERS: metadata.contribOwners,
    CONTRIB_MEMBERS: metadata.contribMembers,
    POSTGRES_SOURCE: metadata.postgresSource,
    EXTENSIONS: metadata.extensions,
    WASIX_EXTENSIONS: metadata.wasixExtensions,
    EXTENSION_SOURCES: metadata.extensionSources,
    EXTENSION_RECIPES: metadata.extensionRecipes,
    EXTENSION_COMPATIBILITY: metadata.extensionCompatibility,
    EXTENSION_DEPENDENCIES: metadata.extensionDependencies,
    EXTENSION_RELEASE_METADATA: metadata.extensionReleaseMetadata,
    EXTENSION_GITHUB_ARTIFACTS: metadata.extensionGithubArtifacts,
    EXTENSION_PROFILES: metadata.extensionProfiles,
    NATIVE_COMPONENTS: metadata.nativeComponents,
    NATIVE_COMPONENT_SOURCES: metadata.nativeComponentSources,
    NATIVE_MOBILE_COMPONENT_CLOSURES: metadata.nativeMobileComponentClosures,
    NATIVE_MOBILE_MEMBER_ALIASES: metadata.nativeMobileMemberAliases,
    PUBLICATION_CARRIERS: metadata.publicationCarriers,
    NATIVE_HELPER_ARTIFACTS: metadata.nativeHelperArtifacts,
    NATIVE_RUNTIME_ARTIFACTS: metadata.nativeRuntimeArtifacts,
    WASIX_ARTIFACTS: metadata.wasixArtifacts,
    DATABASE_RESOURCE_CONTRACT: metadata.databaseResourceContract,
    DATABASE_WASIX_SEED_CONSUMER: metadata.databaseResourceWasixConsumer,
    DATABASE_RESOURCE_ARTIFACTS: metadata.databaseResourceArtifacts,
    DATABASE_SEED_CARRIERS: metadata.databaseSeedCarriers,
    COMPLETED_SUPPLIER_PUBLICATIONS: publicationInputs.supplierPublications,
    SEED_REUSE_CONTROLS: publicationInputs.seedControls,
    EXTENSION_FINAL_INPUTS: publicationInputs.extensionFinalInputs,
    NATIVE_APPLE_BASE_INPUT: publicationInputs.nativeAppleBase,
    NATIVE_SWIFT_SOURCE_INPUT: publicationInputs.nativeSwiftSource,
    PREPARED_NATIVE_SELECTED_PRODUCTS: publicationInputs.selectedProducts,
    COMPLETED_SUPPLIER_ARTIFACTS: publicationInputs.supplierArtifacts,
  };
  const bzl = `${Object.entries(definitions)
    .map(([name, value]) => `${name} = ${starlark(value)}`)
    .join('\n\n')}\n`;
  const build = [
    `load(${JSON.stringify(identityRule)}, "release_identity")`,
    'package(default_visibility = ["//visibility:public"])',
    'exports_files(["metadata.bzl", "extension-sources.bzl", "completed-supplier-artifacts.json", "native-swift-source-input.json", "native-apple-base-input.json", "prepared-selected-products.json"])',
    ...(publicationInputs.files.length
      ? [`exports_files(${starlark(publicationInputs.files.map(({ path }) => path))})`]
      : []),
    ...Object.values(metadata.products)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(
        ({ id, version }) =>
          `release_identity(name = "product_${id}", product_id = ${JSON.stringify(id)}, version = ${JSON.stringify(version)})`,
      ),
  ].join('\n');
  // Module-extension acquisition excludes unrelated product versions. Loading
  // metadata.bzl here would change MODULE.bazel.lock on every release bump.
  const acquisitionSources = Object.fromEntries(
    Object.entries(metadata.extensionSources).map(([sqlName, source]) => [
      sqlName,
      Object.fromEntries(
        ['name', 'url', 'commit'].map((key) => [
          key,
          string(source[key], `${sqlName} acquisition ${key}`),
        ]),
      ),
    ]),
  );
  const extensionSourcesBzl = `EXTENSION_SOURCES = ${starlark(acquisitionSources)}\n\nEXTENSION_DEPENDENCIES = ${starlark(metadata.extensionDependencies)}\n`;
  return {
    bzl,
    extensionSourcesBzl,
    completedSupplierArtifacts: `${JSON.stringify(publicationInputs.supplierArtifacts)}\n`,
    nativeSwiftSourceInput: `${JSON.stringify(publicationInputs.nativeSwiftSource)}\n`,
    nativeAppleBaseInput: `${JSON.stringify(publicationInputs.nativeAppleBase)}\n`,
    preparedSelectedProducts: `${JSON.stringify(publicationInputs.selectedProducts)}\n`,
    build: `${build}\n`,
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (
    ![6, 8].includes(args.length) ||
    args[0] !== '--root' ||
    args[2] !== '--output-dir' ||
    args[4] !== '--identity-rule' ||
    (args.length === 8 && args[6] !== '--native-publication-inputs')
  ) {
    throw new Error(
      'usage: bazel-release-metadata.mts --root ROOT --output-dir DIR --identity-rule LABEL [--native-publication-inputs FILE]',
    );
  }
  const metadata = loadReleaseMetadata(args[1]);
  // Track the complete implementation import closure as well as data reads.
  // Builtins come from the declared Bun tool; package imports require their own
  // acquisition contract rather than silently resolving checkout node_modules.
  const pending = ['tools/release/bazel-release-metadata.mts'];
  const scanned = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  while (pending.length) {
    const projectionFile = pending.pop()!;
    if (scanned.has(projectionFile)) continue;
    scanned.add(projectionFile);
    const source = readFileSync(path.join(args[1], projectionFile), 'utf8');
    metadata.inputs[projectionFile] = source;
    for (const { path: imported } of scanner.scanImports(
      source.replace(/^#![^\r\n]*(?:\r?\n|$)/u, '\n'),
    )) {
      if (imported.startsWith('node:') || imported === 'bun') continue;
      if (!imported.startsWith('.'))
        throw new Error(`metadata implementation has undeclared package import ${imported}`);
      pending.push(
        repositoryPath(
          path.posix.normalize(path.posix.join(path.posix.dirname(projectionFile), imported)),
        ),
      );
    }
  }
  const publicationInputs =
    args.length === 8
      ? nativePublicationInputProjection(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              readFileSync(args[7]),
            ),
          ),
          metadata,
        )
      : undefined;
  const rendered = renderReleaseMetadata(metadata, args[5], publicationInputs);
  mkdirSync(args[3], { recursive: true });
  writeFileSync(path.join(args[3], 'metadata.bzl'), rendered.bzl);
  writeFileSync(path.join(args[3], 'extension-sources.bzl'), rendered.extensionSourcesBzl);
  writeFileSync(
    path.join(args[3], 'completed-supplier-artifacts.json'),
    rendered.completedSupplierArtifacts,
  );
  writeFileSync(
    path.join(args[3], 'native-swift-source-input.json'),
    rendered.nativeSwiftSourceInput,
  );
  writeFileSync(path.join(args[3], 'native-apple-base-input.json'), rendered.nativeAppleBaseInput);
  writeFileSync(
    path.join(args[3], 'prepared-selected-products.json'),
    rendered.preparedSelectedProducts,
  );
  writeFileSync(path.join(args[3], 'BUILD.bazel'), rendered.build);
  writeFileSync(
    path.join(args[3], '.metadata-inputs.json'),
    JSON.stringify({
      sourceInputs: metadata.inputs,
      nativePublicationFiles: publicationInputs?.files ?? [],
    }),
  );
  writeFileSync(
    path.join(args[3], '.metadata-directories.json'),
    JSON.stringify(metadata.directories),
  );
}
