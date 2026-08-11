#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import {
  REQUIRED_WASIX_CONSUMER_PINS,
  canonicalWasixCargoToolchainVersions,
  validateResolvedWasixToolchainPolicy,
  validateWasixConsumerDependencyPins,
} from "./wasix-cargo-toolchain-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "example-cargo-policy.mjs";
const WASIX_PRODUCT_MANIFEST_PATH =
  "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml";

const ADVISORY_VERSION_FLOORS = new Map([
  ["crossbeam-epoch", "0.9.20"],
  ["postgres-protocol", "0.6.12"],
]);

export {
  REQUIRED_WASIX_CONSUMER_PINS,
  validateWasixConsumerDependencyPins,
};

const LINUX_X64_GNU_TARGET =
  'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))';

function dependencyBinding(name, tableParts) {
  return Object.freeze({
    name,
    entryParts: Object.freeze([...tableParts, name]),
  });
}

function exampleCargoPolicy({ dependencyBindings, runtime = undefined, ...policy }) {
  const frozenBindings = Object.freeze(dependencyBindings);
  return Object.freeze({
    ...policy,
    dependencyBindings: frozenBindings,
    directPackages: Object.freeze(frozenBindings.map(({ name }) => name)),
    ...(runtime === undefined ? {} : { runtime: Object.freeze(runtime) }),
  });
}

export const EXAMPLE_CARGO_POLICIES = Object.freeze([
  exampleCargoPolicy({
    id: "native-tauri",
    crateDir: "examples/tauri/src-tauri",
    ignoredLock: "examples/tauri/src-tauri/Cargo.lock",
    wasixToolchain: false,
    dependencyBindings: [
      dependencyBinding("oliphaunt-build", ["build-dependencies"]),
      dependencyBinding("oliphaunt", ["dependencies"]),
      dependencyBinding("oliphaunt-tools", ["dependencies"]),
      dependencyBinding("liboliphaunt-native-linux-x64-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
      dependencyBinding("oliphaunt-broker-linux-x64-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
      dependencyBinding("oliphaunt-extension-contrib-pg18-linux-x64-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
    ],
    runtime: {
      product: "liboliphaunt-native",
      productParts: Object.freeze(["package", "metadata", "oliphaunt", "runtime"]),
      versionParts: Object.freeze(["package", "metadata", "oliphaunt", "runtime-version"]),
    },
    requiredPackages: Object.freeze([
      "oliphaunt",
      "oliphaunt-build",
      "oliphaunt-tools",
      "liboliphaunt-native-linux-x64-gnu",
      "oliphaunt-broker-linux-x64-gnu",
      "oliphaunt-extension-contrib-pg18-linux-x64-gnu",
    ]),
  }),
  exampleCargoPolicy({
    id: "wasix-tauri",
    crateDir: "examples/tauri-wasix/src-tauri",
    ignoredLock: "examples/tauri-wasix/src-tauri/Cargo.lock",
    wasixToolchain: true,
    dependencyBindings: [
      dependencyBinding("oliphaunt-wasix", ["dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools", ["dependencies"]),
      dependencyBinding("liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
    ],
    requiredPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-contrib-pg18-wasix",
      "oliphaunt-extension-contrib-pg18-aot-linux-x64",
    ]),
  }),
  exampleCargoPolicy({
    id: "wasix-electron-sidecar",
    crateDir: "examples/electron-wasix/src-wasix",
    ignoredLock: "examples/electron-wasix/src-wasix/Cargo.lock",
    wasixToolchain: true,
    dependencyBindings: [
      dependencyBinding("oliphaunt-wasix", ["dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools", ["dependencies"]),
      dependencyBinding("liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
    ],
    requiredPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-contrib-pg18-wasix",
      "oliphaunt-extension-contrib-pg18-aot-linux-x64",
    ]),
  }),
  exampleCargoPolicy({
    id: "wasix-tauri-sqlx",
    crateDir: "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri",
    ignoredLock: "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock",
    wasixToolchain: true,
    dependencyBindings: [
      dependencyBinding("oliphaunt-wasix", ["dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools", ["dependencies"]),
      dependencyBinding("liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
      dependencyBinding("oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu", ["target", LINUX_X64_GNU_TARGET, "dependencies"]),
    ],
    requiredPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    ]),
  }),
]);

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function objectTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readToml(file) {
  return Bun.TOML.parse(readFileSync(file, "utf8"));
}

function effectivePublishVersion(version, initialVersion) {
  return version === "0.0.0" ? initialVersion : version;
}

function initialReleaseVersion() {
  const config = JSON.parse(readFileSync(path.join(ROOT, "release-please-config.json"), "utf8"));
  const version = config["initial-version"];
  if (typeof version !== "string" || !/^\d+[.]\d+[.]\d+$/u.test(version)) {
    fail("release-please-config.json must declare a stable initial-version");
  }
  return version;
}

export function exampleCargoPolicyById(id) {
  const policy = EXAMPLE_CARGO_POLICIES.find((candidate) => candidate.id === id);
  if (policy === undefined) {
    fail(`unknown example Cargo policy ${JSON.stringify(id)}`);
  }
  return policy;
}

function catalogContext() {
  const initialVersion = initialReleaseVersion();
  const catalog = loadPublicationCatalog(TOOL);
  return { catalog, initialVersion };
}

function expectedCarrierVersion(name, context) {
  const carrier = resolveActualCarrier(context.catalog, "cargo", name, TOOL);
  return effectivePublishVersion(carrier.version, context.initialVersion);
}

function expectedProductVersion(product, context) {
  const rows = context.catalog.products.filter(({ id }) => id === product);
  if (rows.length !== 1) {
    fail(`release product ${JSON.stringify(product)} must appear exactly once in the publication catalog`);
  }
  return effectivePublishVersion(rows[0].version, context.initialVersion);
}

export function exampleCargoReleaseVersionBindings() {
  const context = catalogContext();
  const bindings = [];
  for (const policy of EXAMPLE_CARGO_POLICIES) {
    const file = `${policy.crateDir}/Cargo.toml`;
    for (const dependency of policy.dependencyBindings) {
      const carrier = resolveActualCarrier(context.catalog, "cargo", dependency.name, TOOL);
      const entryParts = [...dependency.entryParts];
      bindings.push(Object.freeze({
        kind: "dependency",
        policyId: policy.id,
        file,
        name: dependency.name,
        entryParts: Object.freeze(entryParts),
        versionPaths: Object.freeze([
          Object.freeze(entryParts),
          Object.freeze([...entryParts, "version"]),
        ]),
        sourceProduct: carrier.product,
        expected: `=${effectivePublishVersion(carrier.version, context.initialVersion)}`,
        wrapped: true,
      }));
    }
    if (policy.runtime !== undefined) {
      const entryParts = [...policy.runtime.versionParts];
      bindings.push(Object.freeze({
        kind: "runtime",
        policyId: policy.id,
        file,
        name: "runtime-version",
        entryParts: Object.freeze(entryParts),
        versionPaths: Object.freeze([Object.freeze(entryParts)]),
        sourceProduct: policy.runtime.product,
        expected: expectedProductVersion(policy.runtime.product, context),
        wrapped: false,
      }));
    }
  }
  return Object.freeze(bindings);
}

export function isOliphauntCargoName(name) {
  return name === "oliphaunt" || name.startsWith("oliphaunt-") || name.startsWith("liboliphaunt-");
}

function dependencyTables(manifest) {
  const tables = [
    objectTable(manifest.dependencies),
    objectTable(manifest["build-dependencies"]),
    objectTable(manifest["dev-dependencies"]),
  ];
  for (const target of Object.values(objectTable(manifest.target))) {
    const targetTable = objectTable(target);
    tables.push(
      objectTable(targetTable.dependencies),
      objectTable(targetTable["build-dependencies"]),
      objectTable(targetTable["dev-dependencies"]),
    );
  }
  return tables;
}

function dependencyVersion(spec) {
  if (typeof spec === "string") return spec;
  return typeof spec?.version === "string" ? spec.version : null;
}

function valueAt(root, parts) {
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function validateExampleManifestPolicy(policy, manifest, bindings) {
  const manifestLabel = `${policy.crateDir}/Cargo.toml`;
  const failures = [];
  if (Object.hasOwn(manifest, "patch")) {
    failures.push(`${manifestLabel} must not commit candidate registry patches`);
  }

  const dependencyBindings = bindings.filter(({ kind }) => kind === "dependency");
  const expectedByName = new Map(dependencyBindings.map((binding) => [binding.name, binding]));
  const seen = [];
  for (const table of dependencyTables(manifest)) {
    for (const [name, spec] of Object.entries(table)) {
      if (!isOliphauntCargoName(name)) continue;
      seen.push(name);
      if (typeof spec === "object" && spec !== null && Object.hasOwn(spec, "registry")) {
        failures.push(`${manifestLabel} ${name} must use normal crates.io resolution`);
      }
      const expected = expectedByName.get(name)?.expected;
      const actual = dependencyVersion(spec);
      if (expected !== undefined && actual !== expected) {
        failures.push(`${manifestLabel} ${name} uses ${JSON.stringify(actual)}; expected ${expected}`);
      }
    }
  }

  const expectedDirect = [...policy.directPackages].sort();
  const actualDirect = [...seen].sort();
  if (JSON.stringify(actualDirect) !== JSON.stringify(expectedDirect)) {
    failures.push(
      `${policy.id} direct Oliphaunt dependencies are ${JSON.stringify(actualDirect)}; expected ${JSON.stringify(expectedDirect)}`,
    );
  }
  for (const binding of dependencyBindings) {
    if (valueAt(manifest, binding.entryParts) === undefined) {
      failures.push(
        `${manifestLabel} ${binding.name} must remain at TOML path ${binding.entryParts.join(".")}`,
      );
    }
  }

  if (policy.runtime !== undefined) {
    const actualProduct = valueAt(manifest, policy.runtime.productParts);
    if (actualProduct !== policy.runtime.product) {
      failures.push(
        `${manifestLabel} runtime uses ${JSON.stringify(actualProduct)}; expected ${policy.runtime.product}`,
      );
    }
    const binding = bindings.find(({ kind }) => kind === "runtime");
    const actualVersion = valueAt(manifest, policy.runtime.versionParts);
    if (binding === undefined) {
      failures.push(`${manifestLabel} has no release binding for runtime-version`);
    } else if (actualVersion !== binding.expected) {
      failures.push(
        `${manifestLabel} runtime-version uses ${JSON.stringify(actualVersion)}; expected ${binding.expected}`,
      );
    }
  }
  return failures;
}

export function validateExampleManifests() {
  const context = catalogContext();
  const releaseBindings = exampleCargoReleaseVersionBindings();
  const failures = [];
  const toolchainVersions = canonicalWasixCargoToolchainVersions(ROOT);
  failures.push(...validateWasixConsumerDependencyPins(
    readToml(path.join(ROOT, WASIX_PRODUCT_MANIFEST_PATH)),
    { toolchainVersions },
  ));
  for (const policy of EXAMPLE_CARGO_POLICIES) {
    const manifestPath = path.join(ROOT, policy.crateDir, "Cargo.toml");
    const manifest = readToml(manifestPath);
    if (existsSync(path.join(ROOT, policy.ignoredLock))) {
      failures.push(`${policy.ignoredLock} must be ephemeral and untracked`);
    }
    const policyBindings = releaseBindings.filter(({ policyId }) => policy.id === policyId);
    failures.push(...validateExampleManifestPolicy(policy, manifest, policyBindings));
    for (const required of policy.requiredPackages) {
      try {
        expectedCarrierVersion(required, context);
      } catch (error) {
        failures.push(`${policy.id} required package: ${error.message}`);
      }
    }
  }
  return failures;
}

function packageByName(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    const rows = byName.get(pkg.name) ?? [];
    rows.push(pkg);
    byName.set(pkg.name, rows);
  }
  return byName;
}

function semverParts(version) {
  const match = version.match(/^(\d+)[.](\d+)[.](\d+)(?:-([0-9A-Za-z.-]+))?(?:[+][0-9A-Za-z.-]+)?$/u);
  if (match === null) return null;
  return {
    numbers: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(left, right) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (leftParts === null || rightParts === null) return null;
  for (let index = 0; index < leftParts.numbers.length; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) {
      return leftParts.numbers[index] < rightParts.numbers[index] ? -1 : 1;
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (leftParts.prerelease === null) return 1;
  if (rightParts.prerelease === null) return -1;
  return leftParts.prerelease < rightParts.prerelease
    ? -1
    : leftParts.prerelease > rightParts.prerelease
      ? 1
      : 0;
}

export function validateResolvedPackagePolicy(
  lockfile,
  packages,
  { wasixToolchain = false, toolchainVersions } = {},
) {
  const failures = [];
  const byName = packageByName(packages);
  for (const [name, floor] of ADVISORY_VERSION_FLOORS) {
    for (const pkg of byName.get(name) ?? []) {
      const comparison = compareSemver(pkg.version, floor);
      if (comparison === null) {
        failures.push(`${lockfile}: ${name} has invalid semantic version ${pkg.version}`);
      } else if (comparison < 0) {
        failures.push(`${lockfile}: ${name} ${pkg.version} is below required floor ${floor}`);
      }
    }
  }
  if (!wasixToolchain) return failures;
  failures.push(...validateResolvedWasixToolchainPolicy(
    lockfile,
    packages,
    { toolchainVersions },
  ));
  return failures;
}

function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    fail("usage: tools/release/example-cargo-policy.mjs [--check]");
  }
  const failures = validateExampleManifests();
  if (failures.length > 0) fail(failures.join("\n"));
  console.log(`example Cargo manifests are registry-neutral and ${EXAMPLE_CARGO_POLICIES.length} ephemeral lock policies are valid`);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
