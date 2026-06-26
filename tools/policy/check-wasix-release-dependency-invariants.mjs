#!/usr/bin/env bun
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PRODUCT_MANIFEST_PATH =
  'src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml';
const RUNTIME_VERSION_PATH = 'src/runtimes/liboliphaunt/wasix/VERSION';
const INTERNAL_ASSETS_MANIFEST =
  'src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml';
const INTERNAL_AOT_MANIFESTS_DIR = 'src/runtimes/liboliphaunt/wasix/crates/aot';

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
  return name === 'liboliphaunt-wasix-portable' || name.startsWith('liboliphaunt-wasix-aot-');
}

const productManifest = await readToml(PRODUCT_MANIFEST_PATH);
const runtimeVersion = (await Bun.file(RUNTIME_VERSION_PATH).text()).trim();
const errors = [];
const productDeps = new Map();

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

const internalManifestPaths = [INTERNAL_ASSETS_MANIFEST];
for (const entry of (await readdir(INTERNAL_AOT_MANIFESTS_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()) {
  internalManifestPaths.push(join(INTERNAL_AOT_MANIFESTS_DIR, entry, 'Cargo.toml'));
}

for (const manifestPath of internalManifestPaths) {
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
    errors.push(`${manifestPath}: source artifact crate template ${name} must declare publish = false`);
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
