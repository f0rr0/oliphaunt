import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { loadContribCarriers } from '../../src/extensions/artifacts/packages/tools/contrib-carriers.mts';
import { validateExtensionTargetProfiles } from '../../src/extensions/contracts/extension-target-profiles.mts';
import { nativeCargoArtifactRows } from '../packaging/rust-native-targets.mts';
import { compatibilityVersionFromText } from './compatibility-version-parser.mts';
import {
  contribExtensionMetadata,
  declaredExtensionMetadata,
  extensionPublicationMetadataRows,
  extensionSourceMetadata,
} from './extension-release-metadata.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import {
  databaseResourceArtifactRows,
  extensionRegistryPackageTargetSetsFromRows,
  nativeHelperArtifactRows,
  nativeRuntimeArtifactRows,
  runtimeExtensionTargetRowsFromConfigs,
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
  extensionSources: Record<string, Record<string, unknown>>;
  extensionRecipes: Record<string, Record<string, unknown>>;
  extensionCompatibility: Record<string, Record<string, unknown>>;
  extensionDependencies: Record<string, Record<string, Record<string, unknown>>>;
  extensionReleaseMetadata: Record<string, unknown>[];
  extensionProfiles: Record<string, unknown>;
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
      const version = compatibilityVersionFromText({ id, path: file, parser }, read(file), {
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
  const moduleMembers = new Set(
    [...generatedCatalog]
      .filter(([, row]) => typeof row['native-module-file'] === 'string')
      .map(([name]) => name),
  );
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
  return {
    products,
    contribOwners,
    contribMembers,
    postgresSource,
    extensions,
    extensionSources,
    extensionRecipes,
    extensionCompatibility,
    extensionDependencies,
    extensionReleaseMetadata,
    extensionProfiles,
    publicationCarriers,
    nativeHelperArtifacts,
    nativeRuntimeArtifacts,
    wasixArtifacts,
    databaseResourceContract,
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

export function renderReleaseMetadata(metadata: ReleaseMetadata, identityRule: string) {
  if (!identityRule.startsWith('@') || !identityRule.endsWith(':identity.bzl')) {
    throw new Error('identity rule must be a repository-qualified identity.bzl label');
  }
  const definitions = {
    PRODUCTS: metadata.products,
    CONTRIB_OWNERS: metadata.contribOwners,
    CONTRIB_MEMBERS: metadata.contribMembers,
    POSTGRES_SOURCE: metadata.postgresSource,
    EXTENSIONS: metadata.extensions,
    EXTENSION_SOURCES: metadata.extensionSources,
    EXTENSION_RECIPES: metadata.extensionRecipes,
    EXTENSION_COMPATIBILITY: metadata.extensionCompatibility,
    EXTENSION_DEPENDENCIES: metadata.extensionDependencies,
    EXTENSION_RELEASE_METADATA: metadata.extensionReleaseMetadata,
    EXTENSION_PROFILES: metadata.extensionProfiles,
    PUBLICATION_CARRIERS: metadata.publicationCarriers,
    NATIVE_HELPER_ARTIFACTS: metadata.nativeHelperArtifacts,
    NATIVE_RUNTIME_ARTIFACTS: metadata.nativeRuntimeArtifacts,
    WASIX_ARTIFACTS: metadata.wasixArtifacts,
    DATABASE_RESOURCE_CONTRACT: metadata.databaseResourceContract,
    DATABASE_RESOURCE_ARTIFACTS: metadata.databaseResourceArtifacts,
    DATABASE_SEED_CARRIERS: metadata.databaseSeedCarriers,
  };
  const bzl = `${Object.entries(definitions)
    .map(([name, value]) => `${name} = ${starlark(value)}`)
    .join('\n\n')}\n`;
  const build = [
    `load(${JSON.stringify(identityRule)}, "release_identity")`,
    'package(default_visibility = ["//visibility:public"])',
    'exports_files(["metadata.bzl", "extension-sources.bzl"])',
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
  return { bzl, extensionSourcesBzl, build: `${build}\n` };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== '--root' ||
    args[2] !== '--output-dir' ||
    args[4] !== '--identity-rule'
  ) {
    throw new Error(
      'usage: bazel-release-metadata.mts --root ROOT --output-dir DIR --identity-rule LABEL',
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
  const rendered = renderReleaseMetadata(metadata, args[5]);
  mkdirSync(args[3], { recursive: true });
  writeFileSync(path.join(args[3], 'metadata.bzl'), rendered.bzl);
  writeFileSync(path.join(args[3], 'extension-sources.bzl'), rendered.extensionSourcesBzl);
  writeFileSync(path.join(args[3], 'BUILD.bazel'), rendered.build);
  writeFileSync(path.join(args[3], '.metadata-inputs.json'), JSON.stringify(metadata.inputs));
  writeFileSync(
    path.join(args[3], '.metadata-directories.json'),
    JSON.stringify(metadata.directories),
  );
}
