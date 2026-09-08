#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  extensionNativeRegistryPackageStrings,
  extensionWasixRegistryPackageStrings,
} from '../../src/extensions/artifacts/packages/tools/extension-registry-packages.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  ICU_PACKAGE,
  publicAotCargoDependencies,
  publicCargoPackageNames,
  publicToolsAotCargoDependencies,
  publicToolsFeatureDependencies,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
} from '../../src/runtimes/liboliphaunt/wasix/tools/wasix-cargo-artifact-contract.mts';
import {
  compatibilityVersionSource,
  requireCompatibilityVersionBinding,
} from '../../src/shared/product-metadata/compatibility-version-policy.mts';
import {
  declaredCarrierMap,
  loadPublicationCatalog,
  publicationCatalogDigest,
} from '../../src/shared/product-metadata/publication-catalog.mts';
import {
  allArtifactTargets,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionRegistryPackageTargetSets,
  extensionReleaseProduct,
  extensionSourceIdentity,
  extensionSqlNames,
  registryPackageRows,
  releaseMetadata,
} from '../../src/shared/product-metadata/release-artifact-targets.mts';
import {
  compareText,
  compatibilityVersionEntries,
  compatibilityVersionValue,
  loadProducts,
  parseStableVersion,
  ROOT,
  versionFiles,
} from '../../src/shared/product-metadata/release-graph.mts';
import { latestVerifiedReleaseCommit } from './verify-release-commit.mts';

const TOOL = 'check-release-metadata.mts';
const STABLE_VERSION = /^[0-9]+[.][0-9]+[.][0-9]+$/u;
const INSTALL_SCRIPTS = new Set(['preinstall', 'install', 'postinstall']);
const REGISTRY_TARGET_ECOSYSTEM = Object.freeze({
  'crates-io': 'cargo',
  'maven-central': 'maven',
  npm: 'npm',
});
function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function object(value, label) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function stringList(value, label, { nonEmpty = false } = {}) {
  assert(
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0),
    `${label} must be a list of non-empty strings`,
  );
  assert(!nonEmpty || value.length > 0, `${label} must not be empty`);
  assert(new Set(value).size === value.length, `${label} must not contain duplicates`);
  return value;
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function readJson(relativePath) {
  try {
    return object(JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function readToml(relativePath) {
  try {
    return object(
      Bun.TOML.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')),
      relativePath,
    );
  } catch (error) {
    fail(`${relativePath} is not valid TOML: ${error.message}`);
  }
}

function requireFile(relativePath, label = relativePath) {
  const absolute = path.join(ROOT, relativePath);
  assert(
    existsSync(absolute) && statSync(absolute).isFile(),
    `${label} does not exist: ${relativePath}`,
  );
}

function stableVersion(value, label) {
  assert(
    typeof value === 'string' && STABLE_VERSION.test(value),
    `${label} must be stable x.y.z, got ${JSON.stringify(value)}`,
  );
  parseStableVersion(value, TOOL);
  return value;
}

function dottedValue(value, expression, label) {
  assert(
    typeof expression === 'string' && expression.startsWith('$.') && expression.length > 2,
    `${label} must use $.path syntax`,
  );
  let cursor = value;
  for (const key of expression.slice(2).split('.')) {
    assert(
      cursor !== null && typeof cursor === 'object' && !Array.isArray(cursor) && key in cursor,
      `${label} does not resolve ${expression}`,
    );
    cursor = cursor[key];
  }
  return cursor;
}

function genericMarkedVersion(relativePath) {
  const text = readFileSync(path.join(ROOT, relativePath), 'utf8');
  const singleLines = text
    .split(/\r?\n/u)
    .filter((line) => line.includes('x-release-please-version'));
  if (singleLines.length === 1) {
    const matches = singleLines[0].match(/[0-9]+[.][0-9]+[.][0-9]+/gu) ?? [];
    assert(
      matches.length === 1,
      `${relativePath} release-please version marker must own exactly one stable version`,
    );
    return matches[0];
  }
  const block = /x-release-please-start-version(?<body>[\s\S]*?)x-release-please-end/u.exec(text)
    ?.groups?.body;
  assert(
    singleLines.length === 0 && block !== undefined,
    `${relativePath} must have one release-please version marker or marker block`,
  );
  const matches = block.match(/[0-9]+[.][0-9]+[.][0-9]+/gu) ?? [];
  assert(
    matches.length === 1,
    `${relativePath} release-please version block must own exactly one stable version`,
  );
  return matches[0];
}

function conventionalVersion(relativePath) {
  const basename = path.basename(relativePath);
  const text = readFileSync(path.join(ROOT, relativePath), 'utf8');
  if (basename === 'Cargo.toml') {
    const manifest = readToml(relativePath);
    return object(manifest.package, `${relativePath}.package`).version;
  }
  if (basename === 'package.json') {
    return readJson(relativePath).version;
  }
  if (basename === 'VERSION' || basename === 'LIBOLIPHAUNT_VERSION') {
    return text.trim();
  }
  if (basename === 'gradle.properties') {
    const matches = [...text.matchAll(/^VERSION_NAME=(.+)$/gmu)].map((match) => match[1].trim());
    assert(matches.length === 1, `${relativePath} must declare VERSION_NAME exactly once`);
    return matches[0];
  }
  return genericMarkedVersion(relativePath);
}

function releasePleaseVersion(relativePath, entry) {
  if (typeof entry === 'string') {
    return conventionalVersion(relativePath);
  }
  const type = entry.type ?? 'generic';
  if (type === 'generic') {
    return conventionalVersion(relativePath);
  }
  const parsers = {
    json: readJson,
    toml: readToml,
    yaml: (file) => object(Bun.YAML.parse(readFileSync(path.join(ROOT, file), 'utf8')), file),
  };
  const parser = parsers[type];
  assert(
    parser !== undefined,
    `${relativePath} uses unsupported structured release-please type ${JSON.stringify(type)}`,
  );
  const value = parser(relativePath);
  return dottedValue(value, entry.jsonpath, `${relativePath}.jsonpath`);
}

function validateReleasePleaseVersions(graph) {
  const config = readJson('release-please-config.json');
  const manifest = readJson('.release-please-manifest.json');
  const packages = object(config.packages, 'release-please-config.json.packages');
  const productsByPath = new Map(
    Object.entries(graph.products).map(([product, productConfig]) => [productConfig.path, product]),
  );
  assert(
    sameStrings(Object.keys(packages), productsByPath.keys()),
    'release-please package paths must exactly match release graph products',
  );
  assert(
    sameStrings(Object.keys(manifest), productsByPath.keys()),
    'release-please manifest paths must exactly match release graph products',
  );

  for (const [packagePath, packageConfigValue] of Object.entries(packages)) {
    const packageConfig = object(packageConfigValue, `release-please packages.${packagePath}`);
    const product = productsByPath.get(packagePath);
    const productConfig = graph.products[product];
    assert(packageConfig.component === product, `${packagePath}.component must be ${product}`);
    assert(
      manifest[packagePath] === productConfig.version,
      `${packagePath} release-please manifest version must match ${product}`,
    );
    const changelog = packageConfig['changelog-path'] ?? 'CHANGELOG.md';
    assert(
      typeof changelog === 'string' && changelog.length > 0,
      `${packagePath}.changelog-path must be a non-empty string`,
    );
    const changelogPath = path.posix.join(packagePath, changelog);
    requireFile(changelogPath, `${product} changelog`);
    if (manifest[packagePath] === '0.0.0') {
      assert(
        readFileSync(path.join(ROOT, changelogPath)).length === 0,
        `${product} unreleased 0.0.0 changelog must be exactly empty so Release Please can create its canonical heading`,
      );
    }
    assert(
      productConfig.changelog_path === changelogPath,
      `${product} graph changelog must match release-please`,
    );

    const releaseType = packageConfig['release-type'];
    const canonical =
      packageConfig['version-file'] ??
      (releaseType === 'rust'
        ? 'Cargo.toml'
        : ['node', 'expo'].includes(releaseType)
          ? 'package.json'
          : undefined);
    assert(
      typeof canonical === 'string' && canonical.length > 0,
      `${packagePath} must declare a canonical version file`,
    );
    const extraFiles = packageConfig['extra-files'] ?? [];
    assert(Array.isArray(extraFiles), `${packagePath}.extra-files must be a list`);
    const entries = [canonical, ...extraFiles].map((entry) => ({
      entry,
      relative: typeof entry === 'string' ? entry : entry.path,
    }));
    for (const { entry, relative } of entries) {
      assert(
        typeof relative === 'string' && relative.length > 0,
        `${packagePath} version-file entry must declare a path`,
      );
      const file = path.posix.join(packagePath, relative);
      requireFile(file, `${product} version file`);
      const value = releasePleaseVersion(file, entry);
      assert(
        value === productConfig.version,
        `${file} version ${JSON.stringify(value)} must match ${product} ${productConfig.version}`,
      );
    }
    const files = entries.map(({ relative }) => path.posix.join(packagePath, relative));
    assert(
      sameStrings(files, versionFiles(product, TOOL)),
      `${product} release graph version files must match release-please`,
    );
  }
}

function validateCompatibility(graph) {
  const entries = compatibilityVersionEntries(graph.products, {
    requireSourceProduct: true,
    prefix: TOOL,
  });
  assert(
    new Set(entries.map((entry) => entry.id)).size === entries.length,
    'compatibility field ids must be globally unique',
  );
  const pendingRelease = latestVerifiedReleaseCommit({ repo: ROOT });
  const pendingVersions = new Map(Object.entries(pendingRelease?.versions ?? {}));
  const versionSources = new Map();
  for (const entry of entries) {
    const value = compatibilityVersionValue(entry, { prefix: TOOL });
    let source = versionSources.get(entry.product);
    if (source === undefined) {
      source = compatibilityVersionSource(entry, graph.products, pendingVersions, {
        headRef: 'HEAD',
        pendingCommit: pendingRelease?.commit,
        prefix: TOOL,
        root: ROOT,
      });
      versionSources.set(entry.product, source);
    }
    const expected =
      source.kind === 'tagged-sink'
        ? compatibilityVersionValue(entry, {
            ref: source.ref,
            prefix: TOOL,
            // A compatibility pin can become explicit before the sink's next
            // release. Once published, its immutable tag supplies this value.
            missingValue: value,
          })
        : graph.products[entry.sourceProduct].version;
    const provenance =
      source.kind === 'tagged-sink'
        ? `immutable ${entry.product} tag ${source.tag}`
        : `${entry.sourceProduct} ${expected}`;
    requireCompatibilityVersionBinding(
      {
        id: entry.id,
        value,
        expected,
        sourceProduct: entry.sourceProduct,
        sourceVersion: graph.products[entry.sourceProduct].version,
        provenance,
      },
      { prefix: TOOL },
    );
  }
  return entries.length;
}

function validateNpmManifest(relativePath, product, catalogCarriers) {
  const manifest = readJson(relativePath);
  assert(
    typeof manifest.name === 'string' && manifest.name.length > 0,
    `${relativePath}.name must be non-empty`,
  );
  assert(
    manifest.version === product.version,
    `${relativePath}.version must match ${product.id} ${product.version}`,
  );
  const scripts = object(manifest.scripts ?? {}, `${relativePath}.scripts`);
  for (const [name, command] of Object.entries(scripts)) {
    assert(typeof command === 'string', `${relativePath}.scripts.${name} must be a string`);
    assert(
      !INSTALL_SCRIPTS.has(name),
      `${relativePath} must not run ${name} during consumer installation`,
    );
  }
  if (manifest.private !== true) {
    const carrier = catalogCarriers.get(`npm:${manifest.name}`);
    assert(
      carrier?.product === product.id,
      `${relativePath} public npm identity ${manifest.name} must belong to ${product.id} in the publication catalog`,
    );
    assert(
      manifest.publishConfig?.access === 'public',
      `${relativePath}.publishConfig.access must be public`,
    );
    assert(
      manifest.publishConfig?.provenance === true,
      `${relativePath}.publishConfig.provenance must be true`,
    );
  }
}

function validateCargoManifest(relativePath, product, catalogCarriers) {
  const manifest = readToml(relativePath);
  const packageConfig = object(manifest.package, `${relativePath}.package`);
  assert(
    typeof packageConfig.name === 'string' && packageConfig.name.length > 0,
    `${relativePath}.package.name must be non-empty`,
  );
  assert(
    packageConfig.version === product.version,
    `${relativePath}.package.version must match ${product.id} ${product.version}`,
  );
  if (packageConfig.publish !== false) {
    const carrier = catalogCarriers.get(`cargo:${packageConfig.name}`);
    assert(
      carrier?.product === product.id,
      `${relativePath} publishable Cargo identity ${packageConfig.name} must belong to ${product.id}`,
    );
  }
}

function validateSourcePackageManifests(graph, catalog) {
  const carriers = declaredCarrierMap(catalog);
  let npm = 0;
  let cargo = 0;
  for (const [id, config] of Object.entries(graph.products)) {
    const product = { id, ...config };
    for (const file of config.version_files) {
      if (path.basename(file) === 'package.json') {
        validateNpmManifest(file, product, carriers);
        npm += 1;
      } else if (path.basename(file) === 'Cargo.toml') {
        validateCargoManifest(file, product, carriers);
        cargo += 1;
      }
    }
  }
  return { npm, cargo };
}

function validateCatalogAndTargets(graph) {
  const catalog = loadPublicationCatalog(TOOL);
  for (const [product, config] of Object.entries(graph.products)) {
    for (const [target, ecosystem] of Object.entries(REGISTRY_TARGET_ECOSYSTEM)) {
      const count = catalog.carriers.filter(
        (carrier) => carrier.product === product && carrier.ecosystem === ecosystem,
      ).length;
      assert(
        config.publish_targets.includes(target) === count > 0,
        `${product} ${target} target and ${ecosystem} carrier declarations must agree`,
      );
    }
  }

  const runtimeTargets = allArtifactTargets({}, TOOL);
  assert(runtimeTargets.length > 0, 'runtime artifact target catalog must not be empty');
  const carriers = declaredCarrierMap(catalog);
  for (const target of runtimeTargets.filter((row) => row.npmPackage !== undefined)) {
    assert(
      carriers.get(`npm:${target.npmPackage}`)?.product === target.product,
      `${target.id} npm package must be declared by ${target.product}`,
    );
  }

  const extensionProducts = exactExtensionProducts(TOOL);
  let extensionTargets = 0;
  for (const product of extensionProducts) {
    extensionSourceIdentity(product, TOOL);
    const targets = extensionArtifactTargets({ product }, TOOL);
    assert(
      targets.some((target) => target.family === 'native'),
      `${product} must publish at least one native target`,
    );
    assert(
      targets.some((target) => target.family === 'wasix'),
      `${product} must publish at least one WASIX target`,
    );
    const targetSets = extensionRegistryPackageTargetSets(product, TOOL);
    const expectedNative = extensionNativeRegistryPackageStrings({ product, ...targetSets });
    const expectedWasix = extensionWasixRegistryPackageStrings({
      product,
      includeAot: targetSets.includeWasixAot,
    });
    assert(
      expectedNative.every((entry) => !expectedWasix.includes(entry)),
      `${product} native and WASIX registry package families must be disjoint`,
    );
    const nativeOwner = extensionReleaseProduct(product, 'native', TOOL);
    const wasixOwner = extensionReleaseProduct(product, 'wasix', TOOL);
    const nativeDeclared = registryPackageRows({ product: nativeOwner }, TOOL)
      .map((entry) => `${entry.packageKind}:${entry.packageName}`)
      .filter((entry) => expectedNative.includes(entry));
    const wasixDeclared = registryPackageRows({ product: wasixOwner }, TOOL)
      .map((entry) => `${entry.packageKind}:${entry.packageName}`)
      .filter((entry) => expectedWasix.includes(entry));
    assert(
      sameStrings(expectedNative, nativeDeclared) && sameStrings(expectedWasix, wasixDeclared),
      `${product} registry packages must be owned by its native and WASIX release products`,
    );
    extensionTargets += targets.length;
  }

  return {
    catalog,
    runtimeTargets: runtimeTargets.length,
    extensionProducts: extensionProducts.length,
    extensionTargets,
  };
}

function workspaceDependency(table, name, { optional = false } = {}) {
  const dependency = object(table?.[name], `oliphaunt-wasix dependency ${name}`);
  assert(
    dependency.version === '*',
    `${name} must use the local workspace runtime without a release-version constraint`,
  );
  assert(
    typeof dependency.path === 'string' && dependency.path.length > 0,
    `${name} must use a local workspace path`,
  );
  assert(
    optional ? dependency.optional === true : dependency.optional !== true,
    `${name} optional dependency contract is wrong`,
  );
}

function validateWasixContract(graph, catalog) {
  const runtimeVersion = graph.products['liboliphaunt-wasix'].version;
  const coreCargoPackages = publicCargoPackageNames();
  const runtimeCargo = catalog.carriers
    .filter(
      (carrier) =>
        carrier.product === 'liboliphaunt-wasix' &&
        carrier.ecosystem === 'cargo' &&
        coreCargoPackages.includes(carrier.name),
    )
    .map((carrier) => carrier.name);
  assert(
    sameStrings(runtimeCargo, coreCargoPackages),
    'liboliphaunt-wasix core Cargo carriers must exactly match the WASIX artifact contract',
  );

  const manifests = new Map([
    [ICU_PACKAGE, 'src/runtimes/liboliphaunt/icu/Cargo.toml'],
    [RUNTIME_PACKAGE, 'src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml'],
    [TOOLS_PACKAGE, 'src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml'],
    ...Object.entries(AOT_PACKAGES).map(([target, name]) => [
      name,
      `src/runtimes/liboliphaunt/wasix/crates/aot/${AOT_TARGET_TRIPLES[target]}/Cargo.toml`,
    ]),
    ...Object.entries(TOOLS_AOT_PACKAGES).map(([target, name]) => [
      name,
      `src/runtimes/liboliphaunt/wasix/crates/tools-aot/${AOT_TARGET_TRIPLES[target]}/Cargo.toml`,
    ]),
  ]);
  for (const [name, file] of manifests) {
    const packageConfig = object(readToml(file).package, `${file}.package`);
    assert(packageConfig.name === name, `${file} package name must be ${name}`);
    assert(
      packageConfig.version === runtimeVersion,
      `${file} version must match liboliphaunt-wasix`,
    );
  }

  const sdk = readToml('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml');
  const dependencies = object(sdk.dependencies, 'oliphaunt-wasix dependencies');
  workspaceDependency(dependencies, RUNTIME_PACKAGE);
  workspaceDependency(dependencies, TOOLS_PACKAGE, { optional: true });
  workspaceDependency(dependencies, ICU_PACKAGE, { optional: true });
  const targetTables = object(sdk.target, 'oliphaunt-wasix target dependencies');
  for (const [cfg, name] of Object.entries(publicAotCargoDependencies())) {
    workspaceDependency(
      object(targetTables[cfg], `oliphaunt-wasix target ${cfg}`).dependencies,
      name,
    );
  }
  for (const [cfg, name] of Object.entries(publicToolsAotCargoDependencies())) {
    workspaceDependency(
      object(targetTables[cfg], `oliphaunt-wasix target ${cfg}`).dependencies,
      name,
      { optional: true },
    );
  }
  assert(
    sameStrings(sdk.features?.tools ?? [], publicToolsFeatureDependencies()),
    'oliphaunt-wasix tools feature must select exactly the split tool carriers',
  );
  assert(
    !('bundled' in object(sdk.features, 'oliphaunt-wasix features')),
    'oliphaunt-wasix must not expose an inert bundled feature',
  );
  const extensionFeatures = exactExtensionProducts(TOOL)
    .flatMap((product) => extensionSqlNames(product, TOOL))
    .map((sqlName) => `extension-${sqlName.replaceAll('_', '-')}`);
  const sdkExtensionFeatures = Object.keys(sdk.features).filter((feature) =>
    feature.startsWith('extension-'),
  );
  assert(
    sameStrings(extensionFeatures, sdkExtensionFeatures),
    'oliphaunt-wasix extension features must exactly match modeled extensions',
  );
  const runtimeFeatures = Object.keys(
    readToml('src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml').features ?? {},
  );
  assert(
    sameStrings(extensionFeatures, runtimeFeatures),
    'portable WASIX runtime features must exactly match modeled extensions',
  );
  const dump = (sdk.bin ?? []).find((entry) => entry.name === 'oliphaunt-wasix-dump');
  assert(
    Array.isArray(dump?.['required-features']) && dump['required-features'].includes('tools'),
    'oliphaunt-wasix-dump must require the tools feature',
  );
}

function validateNativeContract(graph) {
  const targets = allArtifactTargets({ product: 'liboliphaunt-native' }, TOOL);
  assert(
    targets.some((target) => target.kind === 'native-runtime'),
    'liboliphaunt-native must declare runtime targets',
  );
  assert(
    targets.some((target) => target.kind === 'native-tools'),
    'liboliphaunt-native must declare split tool targets',
  );
}

function parseArgs(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: tools/release/check-release-metadata.mts [--json]');
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return { json };
}

function main(argv) {
  const args = parseArgs(argv);
  const graph = { products: loadProducts(TOOL) };
  validateReleasePleaseVersions(graph);
  const compatibilityFields = validateCompatibility(graph);
  const targetReport = validateCatalogAndTargets(graph);
  const manifests = validateSourcePackageManifests(graph, targetReport.catalog);
  validateNativeContract(graph);
  validateWasixContract(graph, targetReport.catalog);
  const report = {
    schema: 'oliphaunt-release-metadata-validation-v1',
    products: Object.keys(graph.products).length,
    carriers: targetReport.catalog.carriers.length,
    catalogDigest: publicationCatalogDigest(targetReport.catalog),
    runtimeTargets: targetReport.runtimeTargets,
    extensionProducts: targetReport.extensionProducts,
    extensionTargets: targetReport.extensionTargets,
    compatibilityFields,
    sourceNpmManifests: manifests.npm,
    sourceCargoManifests: manifests.cargo,
  };
  if (args.json) {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `release metadata checks passed (${report.products} products, ${report.carriers} catalog-declared registry carrier minima, ${report.runtimeTargets + report.extensionTargets} artifact targets, ${report.compatibilityFields} compatibility fields)`,
    );
  }
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
