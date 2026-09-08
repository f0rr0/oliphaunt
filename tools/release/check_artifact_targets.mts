#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  extensionNativeRegistryPackageStrings,
  extensionRegistryPackageStrings,
  extensionWasixRegistryPackageStrings,
} from '../../src/extensions/artifacts/packages/tools/extension-registry-packages.mts';
import {
  brokerRuntimeMatrix,
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
  liboliphauntNativeAndroidRuntimeMatrix,
  liboliphauntNativeDesktopRuntimeMatrix,
  liboliphauntNativeIosRuntimeMatrix,
  liboliphauntNativeRuntimeMatrix,
  liboliphauntWasixAotRuntimeMatrix,
  liboliphauntWasixPostmasterRuntimeMatrix,
  nodeDirectRuntimeMatrix,
  reactNativeAndroidMobileAppMatrix,
  wasixNapiRuntimeMatrix,
} from '../../src/shared/product-metadata/artifact-target-matrix.mts';
import {
  declaredCarrierMap,
  loadPublicationCatalog,
} from '../../src/shared/product-metadata/publication-catalog.mts';
import {
  allArtifactTargets,
  ciNpmPackageArtifactRows,
  ciReleaseAssetArtifactRows,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMemberPath,
  extensionMetadata,
  extensionRegistryPackageTargetSets,
  extensionReleaseProduct,
  extensionSqlNames,
  nativeToolsOptionalPackageProducts,
  rawArtifactTargetRows,
  registryPackageRows,
  releaseMetadata,
  sdkPackageProducts,
  typescriptOptionalRuntimePackageProducts,
} from '../../src/shared/product-metadata/release-artifact-targets.mts';
import {
  compareText,
  loadProducts,
  ROOT,
} from '../../src/shared/product-metadata/release-graph.mts';

const TOOL = 'check_artifact_targets.mts';
function invariant(condition, message) {
  if (!condition) throw new Error(`${TOOL}: ${message}`);
}

function object(value, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sameStrings(left, right) {
  const actual = sorted(left);
  const expected = sorted(right);
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function assertSameStrings(actual, expected, label) {
  invariant(
    sameStrings(actual, expected),
    `${label} must be ${JSON.stringify(sorted(expected))}; got ${JSON.stringify(sorted(actual))}`,
  );
}

function readJson(relativePath) {
  try {
    return object(JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')), relativePath);
  } catch (error) {
    throw new Error(`${TOOL}: ${relativePath} is invalid JSON: ${error.message}`);
  }
}

function readToml(relativePath) {
  try {
    return object(
      Bun.TOML.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')),
      relativePath,
    );
  } catch (error) {
    throw new Error(`${TOOL}: ${relativePath} is invalid TOML: ${error.message}`);
  }
}

export function validateExtensionCoverage(runtimeTargets, products, extensionTargets) {
  invariant(
    products.length > 0 && new Set(products).size === products.length,
    'extension product ids must be a non-empty unique set',
  );
  const nativeTargets = runtimeTargets
    .filter(
      (row) =>
        row.product === 'liboliphaunt-native' &&
        row.kind === 'native-runtime' &&
        row.extensionArtifacts,
    )
    .map(({ target }) => target);
  const wasixTargets = runtimeTargets
    .filter((row) => row.product === 'liboliphaunt-wasix' && row.kind === 'wasix-runtime')
    .map(({ target }) => (target === 'portable' ? 'wasix-portable' : target));
  const expectedPairs = new Set(
    products.flatMap((product) =>
      extensionSqlNames(product, TOOL).flatMap((sqlName) => [
        ...nativeTargets.map((target) => `${product}\0${sqlName}\0native\0${target}`),
        ...wasixTargets.map((target) => `${product}\0${sqlName}\0wasix\0${target}`),
      ]),
    ),
  );
  const actualPairs = new Set(
    extensionTargets.map((row) => `${row.product}\0${row.sqlName}\0${row.family}\0${row.target}`),
  );
  assertSameStrings(
    actualPairs,
    expectedPairs,
    'exact-extension product/member/family/target pairs',
  );
  invariant(
    actualPairs.size === extensionTargets.length,
    'exact-extension target rows must be unique',
  );
  for (const row of extensionTargets) {
    const expectedKind =
      row.family === 'wasix'
        ? 'wasix-runtime'
        : row.target === 'ios-xcframework' || row.target.startsWith('android-')
          ? 'native-static-registry'
          : 'native-dynamic';
    invariant(
      row.kind === expectedKind,
      `${row.product}/${row.target} must use ${expectedKind}, got ${row.kind}`,
    );
    invariant(
      extensionSqlNames(row.product, TOOL).includes(row.sqlName),
      `${row.product} target row has undeclared SQL member ${row.sqlName}`,
    );
  }
}

function matrixPairs(matrix, { productField = 'extensions_csv' } = {}) {
  const pairs = [];
  for (const row of matrix.include) {
    for (const product of String(row[productField] ?? '')
      .split(',')
      .filter(Boolean))
      pairs.push(`${product}\0${row.target}`);
  }
  return pairs;
}

export function validateMatrixCoverage(targets, extensions, matrices) {
  const selected = (product, kind) =>
    targets.filter((row) => row.product === product && row.kind === kind);
  assertSameStrings(
    matrices.native.include.map(({ target }) => target),
    selected('liboliphaunt-native', 'native-runtime').map(({ target }) => target),
    'native runtime CI matrix',
  );
  const partitions = [matrices.nativeDesktop, matrices.nativeAndroid, matrices.nativeIos];
  assertSameStrings(
    partitions.flatMap(({ include }) => include.map(({ target }) => target)),
    matrices.native.include.map(({ target }) => target),
    'native runtime CI matrix partitions',
  );
  invariant(
    new Set(partitions.flatMap(({ include }) => include.map(({ target }) => target))).size ===
      matrices.native.include.length,
    'native runtime CI partitions must not overlap',
  );
  assertSameStrings(
    matrices.reactNativeAndroid.include.map(({ target }) => target),
    selected('liboliphaunt-native', 'native-runtime')
      .filter(({ surfaces }) => surfaces.includes('react-native-android'))
      .map(({ target }) => target),
    'React Native Android CI matrix',
  );
  assertSameStrings(
    matrices.broker.include.map(({ target }) => target),
    selected('oliphaunt-broker', 'broker-helper').map(({ target }) => target),
    'broker CI matrix',
  );
  assertSameStrings(
    matrices.nodeDirect.include.map(({ target }) => target),
    selected('oliphaunt-node-direct', 'node-direct-addon').map(({ target }) => target),
    'Node direct CI matrix',
  );
  assertSameStrings(
    matrices.wasixNapi.include.map(({ target }) => target),
    selected('oliphaunt-wasix-napi', 'wasix-napi-addon').map(({ target }) => target),
    'WASIX Node-API CI matrix',
  );
  assertSameStrings(
    matrices.wasixAot.include.map(({ target_id }) => target_id),
    selected('liboliphaunt-wasix', 'wasix-aot-runtime').map(({ target }) => target),
    'WASIX AOT CI matrix',
  );
  const wasixAotTargets = new Map(
    selected('liboliphaunt-wasix', 'wasix-aot-runtime').map((target) => [target.target, target]),
  );
  for (const row of matrices.wasixAot.include) {
    const target = wasixAotTargets.get(row.target_id);
    invariant(target !== undefined, `WASIX AOT CI matrix has unknown target ${row.target_id}`);
    invariant(
      row.llvm_url === target.llvmUrl,
      `WASIX AOT CI matrix ${row.target_id} must bind its declared LLVM URL`,
    );
    invariant(
      row.llvm_sha256 === target.llvmSha256 && /^[0-9a-f]{64}$/u.test(row.llvm_sha256),
      `WASIX AOT CI matrix ${row.target_id} must bind its exact LLVM SHA-256`,
    );
    invariant(
      row.llvm_bytes === target.llvmBytes &&
        Number.isSafeInteger(row.llvm_bytes) &&
        row.llvm_bytes > 0 &&
        row.llvm_bytes <= 2 * 1024 * 1024 * 1024,
      `WASIX AOT CI matrix ${row.target_id} must bind its exact supported LLVM byte size`,
    );
  }
  const postmasterTargets = targets.filter(
    ({ product, kind }) =>
      product === 'liboliphaunt-wasix-postmaster' && kind === 'wasix-postmaster-runtime',
  );
  assertSameStrings(
    matrices.wasixPostmaster.include.map(({ target_id }) => target_id),
    postmasterTargets.map(({ target }) => target),
    'WASIX postmaster CI matrix',
  );
  const postmasterByTarget = new Map(postmasterTargets.map((target) => [target.target, target]));
  for (const row of matrices.wasixPostmaster.include) {
    const target = postmasterByTarget.get(row.target_id);
    invariant(
      target !== undefined,
      `WASIX postmaster CI matrix has unknown target ${row.target_id}`,
    );
    invariant(
      row.os === target.runner && row.target === target.triple,
      `WASIX postmaster CI matrix ${row.target_id} must bind its declared runner and target triple`,
    );
    invariant(
      row.artifact === `liboliphaunt-wasix-postmaster-release-assets-${target.target}`,
      `WASIX postmaster CI matrix ${row.target_id} must bind its exact CI artifact name`,
    );
    invariant(
      row.release_asset_path ===
        `target/oliphaunt-wasix-postmaster/release-assets/${target.asset.replace('{version}', '*')}`,
      `WASIX postmaster CI matrix ${row.target_id} must bind its catalog-derived release asset path`,
    );
    invariant(
      row.llvm_url === target.llvmUrl &&
        row.llvm_sha256 === target.llvmSha256 &&
        row.llvm_bytes === target.llvmBytes,
      `WASIX postmaster CI matrix ${row.target_id} must bind its declared LLVM toolchain`,
    );
  }
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionNative)),
    new Set(
      extensions
        .filter(({ family }) => family === 'native')
        .map(({ product, target }) => `${product}\0${target}`),
    ),
    'native extension CI matrix',
  );
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionWasix)),
    new Set(
      extensions
        .filter(({ family }) => family === 'wasix')
        .map(({ product, target }) => `${product}\0${target}`),
    ),
    'WASIX extension CI matrix',
  );
  const matrixSqlPairs = (matrix) =>
    matrix.include.flatMap((row) =>
      String(row.sql_names_csv ?? '')
        .split(',')
        .filter(Boolean)
        .map((sqlName) => `${sqlName}\0${row.target}`),
    );
  assertSameStrings(
    matrixSqlPairs(matrices.extensionNative),
    extensions
      .filter(({ family }) => family === 'native')
      .map(({ sqlName, target }) => `${sqlName}\0${target}`),
    'native extension member CI matrix',
  );
  assertSameStrings(
    matrixSqlPairs(matrices.extensionWasix),
    extensions
      .filter(({ family }) => family === 'wasix')
      .map(({ sqlName, target }) => `${sqlName}\0${target}`),
    'WASIX extension member CI matrix',
  );
}

function manifestArray(value) {
  return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [];
}

export function validateCarrierCoverage({
  graph,
  catalog,
  targets,
  jsManifest,
  nativeToolsManifest,
  rustManifest,
  platformManifests,
}) {
  const carriers = declaredCarrierMap(catalog);
  const runtimeProducts = new Set([
    'liboliphaunt-native',
    'oliphaunt-broker',
    'oliphaunt-node-direct',
    'oliphaunt-wasix-napi',
  ]);
  for (const product of runtimeProducts) {
    const expected = registryPackageRows({ product, packageKind: 'npm' }, TOOL).map(
      (row) => row.packageName,
    );
    const actual = catalog.carriers
      .filter((row) => row.product === product && row.ecosystem === 'npm')
      .map((row) => row.name);
    assertSameStrings(actual, expected, `${product} npm carrier identities`);
  }
  for (const target of targets.filter((row) => row.npmPackage)) {
    const carrier = carriers.get(`npm:${target.npmPackage}`);
    invariant(
      carrier?.product === target.product &&
        carrier.version === graph.products[target.product].version,
      `${target.id} npm carrier is missing or version-skewed`,
    );
    if (target.npmOs === undefined) continue;
    const manifest = platformManifests.get(target.npmPackage);
    invariant(manifest !== undefined, `${target.npmPackage} has no package manifest`);
    invariant(
      manifest.version === graph.products[target.product].version && manifest.optional === true,
      `${target.npmPackage} must be optional and match ${target.product} version`,
    );
    assertSameStrings(
      manifestArray(manifest.os),
      [target.npmOs],
      `${target.npmPackage} os selector`,
    );
    assertSameStrings(
      manifestArray(manifest.cpu),
      [target.npmCpu],
      `${target.npmPackage} cpu selector`,
    );
    assertSameStrings(
      manifestArray(manifest.libc),
      target.npmLibc === undefined ? [] : [target.npmLibc],
      `${target.npmPackage} libc selector`,
    );
    invariant(
      manifest.oliphaunt?.target === target.target,
      `${target.npmPackage} must select target ${target.target}`,
    );
  }
  const expectedOptional = new Map(
    typescriptOptionalRuntimePackageProducts(TOOL).map((row) => [row.packageName, 'workspace:*']),
  );
  const actualOptional = object(
    jsManifest.optionalDependencies ?? {},
    'TypeScript optionalDependencies',
  );
  assertSameStrings(
    Object.keys(actualOptional),
    [...expectedOptional.keys()],
    'TypeScript optional runtime packages',
  );
  for (const [name, version] of expectedOptional)
    invariant(
      actualOptional[name] === version,
      `TypeScript optional runtime ${name} must use ${version}`,
    );
  const expectedToolsOptional = new Map(
    nativeToolsOptionalPackageProducts(TOOL).map((row) => [
      row.packageName,
      `workspace:${graph.products[row.product].version}`,
    ]),
  );
  const actualToolsOptional = object(
    nativeToolsManifest.optionalDependencies ?? {},
    'native tools facade optionalDependencies',
  );
  assertSameStrings(
    Object.keys(actualToolsOptional),
    [...expectedToolsOptional.keys()],
    'native tools facade optional packages',
  );
  for (const [name, version] of expectedToolsOptional) {
    invariant(
      actualToolsOptional[name] === version,
      `native tools facade optional package ${name} must use ${version}`,
    );
  }
  const brokerMetadata = object(
    object(rustManifest.package, 'Rust package').metadata?.oliphaunt,
    'Rust broker metadata',
  );
  invariant(
    brokerMetadata['broker-helper'] === 'oliphaunt-broker',
    'Rust SDK broker helper identity must be oliphaunt-broker',
  );
  invariant(
    brokerMetadata['broker-version'] === graph.products['oliphaunt-broker'].version,
    'Rust SDK broker helper version must match the broker product',
  );
}

export function validateExtensionCarrierCoverage(graph, catalog, products) {
  for (const product of products) {
    const targetSets = extensionRegistryPackageTargetSets(product, TOOL);
    const expected = extensionRegistryPackageStrings({ product, ...targetSets }).map((identity) =>
      identity.replace(/^crates:/u, 'cargo:'),
    );
    const expectedNative = extensionNativeRegistryPackageStrings({ product, ...targetSets }).map(
      (identity) => identity.replace(/^crates:/u, 'cargo:'),
    );
    const expectedWasix = extensionWasixRegistryPackageStrings({
      product,
      includeAot: targetSets.includeWasixAot,
    }).map((identity) => identity.replace(/^crates:/u, 'cargo:'));
    const actual = catalog.carriers.filter((row) => expected.includes(row.id));
    assertSameStrings(
      actual.map((row) => row.id),
      expected,
      `${product} registry carriers`,
    );
    for (const [family, identities] of [
      ['native', expectedNative],
      ['wasix', expectedWasix],
    ]) {
      const owner = extensionReleaseProduct(product, family, TOOL);
      invariant(
        actual
          .filter((row) => identities.includes(row.id))
          .every((row) => row.product === owner && row.version === graph.products[owner].version),
        `${product} ${family} carrier versions must match ${owner}`,
      );
    }
  }
}

function platformPackageManifests(graph, targets) {
  const names = new Set(
    targets.filter(({ npmPackage }) => npmPackage).map(({ npmPackage }) => npmPackage),
  );
  const manifests = new Map();
  for (const config of Object.values(graph.products)) {
    for (const relativePath of config.version_files ?? []) {
      if (path.basename(relativePath) !== 'package.json') continue;
      const manifest = readJson(relativePath);
      if (!names.has(manifest.name)) continue;
      invariant(
        !manifests.has(manifest.name),
        `duplicate platform package manifest ${manifest.name}`,
      );
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

export function repositoryInventory() {
  const graph = { products: loadProducts(TOOL) };
  const targets = allArtifactTargets({}, TOOL);
  const products = exactExtensionProducts(TOOL);
  const extensions = extensionArtifactTargets({}, TOOL);
  return {
    graph,
    targets,
    products,
    extensions,
    catalog: loadPublicationCatalog(TOOL),
    sdkProducts: sdkPackageProducts(TOOL),
    matrices: {
      native: liboliphauntNativeRuntimeMatrix(),
      nativeDesktop: liboliphauntNativeDesktopRuntimeMatrix(),
      nativeAndroid: liboliphauntNativeAndroidRuntimeMatrix(),
      nativeIos: liboliphauntNativeIosRuntimeMatrix(),
      reactNativeAndroid: reactNativeAndroidMobileAppMatrix(),
      extensionNative: extensionArtifactsNativeMatrix(),
      extensionWasix: extensionArtifactsWasixMatrix(),
      wasixAot: liboliphauntWasixAotRuntimeMatrix(),
      wasixPostmaster: liboliphauntWasixPostmasterRuntimeMatrix(),
      broker: brokerRuntimeMatrix(),
      nodeDirect: nodeDirectRuntimeMatrix(),
      wasixNapi: wasixNapiRuntimeMatrix(),
    },
  };
}

export function validateRepository() {
  const inventory = repositoryInventory();
  validateExtensionCoverage(inventory.targets, inventory.products, inventory.extensions);
  validateMatrixCoverage(inventory.targets, inventory.extensions, inventory.matrices);
  validateCarrierCoverage({
    graph: inventory.graph,
    catalog: inventory.catalog,
    targets: inventory.targets,
    jsManifest: readJson('src/sdks/js/package.json'),
    nativeToolsManifest: readJson('src/runtimes/liboliphaunt/native/tools-npm/package.json'),
    rustManifest: readToml('src/sdks/rust/Cargo.toml'),
    platformManifests: platformPackageManifests(inventory.graph, inventory.targets),
  });
  validateExtensionCarrierCoverage(inventory.graph, inventory.catalog, inventory.products);
  return {
    artifactTargets: inventory.targets.length,
    extensionProducts: inventory.products.length,
    extensionTargets: inventory.extensions.length,
    registryCarriers: inventory.catalog.carriers.length,
    sdkProducts: inventory.sdkProducts.length,
  };
}

if (import.meta.main) {
  try {
    const summary = validateRepository();
    console.log(
      `artifact target checks passed (${summary.artifactTargets} runtime/helper rows, ` +
        `${summary.extensionProducts} exact-extension products, ${summary.extensionTargets} extension rows, ` +
        `${summary.registryCarriers} catalog-declared registry carrier minima, ${summary.sdkProducts} SDK packages)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
