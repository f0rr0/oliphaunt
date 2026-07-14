#!/usr/bin/env bun
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PRODUCT_MANIFEST_PATH =
  'src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml';
const XTASK_MANIFEST_PATH = 'tools/xtask/Cargo.toml';
const WASIX_TOOLCHAIN_PATH = 'src/sources/toolchains/wasix.toml';
const RUNTIME_VERSION_PATH = 'src/runtimes/liboliphaunt/wasix/VERSION';
const SOURCE_TEMPLATE_ASSETS_MANIFEST =
  'src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml';
const SOURCE_TEMPLATE_TOOLS_MANIFEST =
  'src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml';
const SOURCE_TEMPLATE_AOT_MANIFESTS_DIR = 'src/runtimes/liboliphaunt/wasix/crates/aot';
const SOURCE_TEMPLATE_TOOLS_AOT_MANIFESTS_DIR =
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot';

function fail(errors) {
  console.error('release version invariant violations:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

async function readToml(path) {
  return Bun.TOML.parse(await Bun.file(path).text());
}

function* dependencyTables(manifest) {
  yield ['dependencies', manifest.dependencies ?? {}];
  for (const [cfg, table] of Object.entries(manifest.target ?? {})) {
    yield [`target.${cfg}.dependencies`, table.dependencies ?? {}];
  }
}

function dependencyName(depKey, spec) {
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    return spec.package ?? depKey;
  }
  return depKey;
}

function dependencyVersion(spec) {
  if (typeof spec === 'string') {
    return spec;
  }
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    return spec.version;
  }
  return undefined;
}

function dependencyPath(spec) {
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    return spec.path;
  }
  return undefined;
}

function isWasixArtifactCrate(name) {
  return (
    name === 'liboliphaunt-wasix-portable' ||
    name === 'oliphaunt-wasix-tools' ||
    name.startsWith('liboliphaunt-wasix-aot-') ||
    name.startsWith('oliphaunt-wasix-tools-aot-')
  );
}

function validateExactDependency(manifest, manifestPath, name, expectedVersion, errors) {
  const matches = [];
  for (const [tableName, deps] of dependencyTables(manifest)) {
    for (const [depKey, spec] of Object.entries(deps)) {
      if (dependencyName(depKey, spec) === name) {
        matches.push({ tableName, depKey, spec });
      }
    }
  }
  if (matches.length !== 1) {
    errors.push(
      `${manifestPath} must declare ${name} exactly once, found ${matches.length}`,
    );
    return;
  }
  const [{ tableName, depKey, spec }] = matches;
  const actualVersion = dependencyVersion(spec);
  if (actualVersion !== `=${expectedVersion}`) {
    errors.push(
      `${manifestPath} ${tableName}.${depKey} must pin ${name} exactly to ` +
        `=${expectedVersion}, got ${JSON.stringify(actualVersion)}`,
    );
  }
}

const productManifest = await readToml(PRODUCT_MANIFEST_PATH);
const xtaskManifest = await readToml(XTASK_MANIFEST_PATH);
const wasixToolchain = await readToml(WASIX_TOOLCHAIN_PATH);
const runtimeVersion = (await Bun.file(RUNTIME_VERSION_PATH).text()).trim();
const errors = [];
const productDeps = new Map();

const wasmerVersion = wasixToolchain.toolchain?.wasmer;
const wasmerWasixVersion = wasixToolchain.toolchain?.['wasmer-wasix'];
if (typeof wasmerVersion !== 'string' || wasmerVersion === '') {
  errors.push(`${WASIX_TOOLCHAIN_PATH} must declare a non-empty toolchain.wasmer version`);
}
if (typeof wasmerWasixVersion !== 'string' || wasmerWasixVersion === '') {
  errors.push(
    `${WASIX_TOOLCHAIN_PATH} must declare a non-empty toolchain.wasmer-wasix version`,
  );
}
if (typeof wasmerVersion === 'string' && wasmerVersion !== '') {
  for (const [manifestPath, manifest] of [
    [PRODUCT_MANIFEST_PATH, productManifest],
    [XTASK_MANIFEST_PATH, xtaskManifest],
  ]) {
    validateExactDependency(manifest, manifestPath, 'wasmer', wasmerVersion, errors);
    validateExactDependency(manifest, manifestPath, 'wasmer-types', wasmerVersion, errors);
  }
}
if (typeof wasmerWasixVersion === 'string' && wasmerWasixVersion !== '') {
  for (const [manifestPath, manifest] of [
    [PRODUCT_MANIFEST_PATH, productManifest],
    [XTASK_MANIFEST_PATH, xtaskManifest],
  ]) {
    validateExactDependency(
      manifest,
      manifestPath,
      'wasmer-wasix',
      wasmerWasixVersion,
      errors,
    );
  }
  validateExactDependency(
    productManifest,
    PRODUCT_MANIFEST_PATH,
    'wasmer-config',
    wasmerWasixVersion,
    errors,
  );
}

for (const [tableName, deps] of dependencyTables(productManifest)) {
  for (const [depKey, spec] of Object.entries(deps)) {
    const name = dependencyName(depKey, spec);
    if (!isWasixArtifactCrate(name)) {
      continue;
    }
    if (productDeps.has(name)) {
      errors.push(`${name} is declared more than once in oliphaunt-wasix dependencies`);
    }
    productDeps.set(name, { tableName, spec });
  }
}

const sourceTemplateManifestPaths = [SOURCE_TEMPLATE_ASSETS_MANIFEST, SOURCE_TEMPLATE_TOOLS_MANIFEST];
for (const manifestsDir of [SOURCE_TEMPLATE_AOT_MANIFESTS_DIR, SOURCE_TEMPLATE_TOOLS_AOT_MANIFESTS_DIR]) {
  for (const entry of (await readdir(manifestsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    sourceTemplateManifestPaths.push(join(manifestsDir, entry, 'Cargo.toml'));
  }
}

for (const manifestPath of sourceTemplateManifestPaths) {
  const manifest = await readToml(manifestPath);
  const packageConfig = manifest.package ?? {};
  const name = packageConfig.name;
  const version = packageConfig.version;
  if (typeof name !== 'string' || !isWasixArtifactCrate(name)) {
    errors.push(`${manifestPath}: unexpected WASIX artifact crate name ${JSON.stringify(name)}`);
    continue;
  }
  if (version !== runtimeVersion) {
    errors.push(
      `${manifestPath}: ${name} version ${version} does not match liboliphaunt-wasix runtime version ${runtimeVersion}`,
    );
  }
  if (packageConfig.publish !== false) {
    errors.push(
      `${manifestPath}: source artifact crate template ${name} must declare publish = false until release packaging injects payloads and strips the guard`,
    );
  }
  if (!productDeps.has(name)) {
    errors.push(`oliphaunt-wasix must depend on WASIX artifact crate ${name}`);
  }
}

for (const [name, { tableName, spec }] of [...productDeps].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const version = dependencyVersion(spec);
  const sourcePath = dependencyPath(spec);
  if (version !== `=${runtimeVersion}`) {
    errors.push(
      `${PRODUCT_MANIFEST_PATH} ${tableName}.${name} must use exact liboliphaunt-wasix version =${runtimeVersion}, got ${JSON.stringify(version)}`,
    );
  }
  if (sourcePath === undefined || sourcePath === null || sourcePath === '') {
    errors.push(
      `${PRODUCT_MANIFEST_PATH} ${tableName}.${name} must keep a source-checkout path dependency`,
    );
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log('release version invariants ok');
