#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXAMPLE_CARGO_REGISTRY_SOURCE,
  candidateRegistryDigest,
  candidateRegistryPackages,
  verifyCandidateRegistryPackage,
} from "./example-cargo-registry.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "example-cargo-policy.mjs";
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const WASIX_TOOLCHAIN_PATH = "src/sources/toolchains/wasix.toml";
const HEX_SHA256 = /^[0-9a-f]{64}$/u;

const ADVISORY_VERSION_FLOORS = new Map([
  ["crossbeam-epoch", "0.9.20"],
  ["postgres-protocol", "0.6.12"],
]);

const REQUIRED_WASMER_PACKAGES = new Map([
  ["wasmer", "wasmer"],
  ["wasmer-compiler", "wasmer"],
  ["wasmer-derive", "wasmer"],
  ["wasmer-types", "wasmer"],
  ["wasmer-vm", "wasmer"],
  ["wasmer-config", "wasmerWasix"],
  ["wasmer-journal", "wasmerWasix"],
  ["wasmer-package", "wasmerWasix"],
  ["wasmer-wasix", "wasmerWasix"],
  ["wasmer-wasix-types", "wasmerWasix"],
  ["virtual-fs", "wasmerWasix"],
  ["virtual-mio", "wasmerWasix"],
  ["virtual-net", "wasmerWasix"],
]);

export const EXAMPLE_CARGO_POLICIES = Object.freeze([
  Object.freeze({
    id: "native-tauri",
    crateDir: "examples/tauri/src-tauri",
    ignoredLock: "examples/tauri/src-tauri/Cargo.lock",
    wasixToolchain: false,
    directPackages: Object.freeze([
      "oliphaunt",
      "oliphaunt-build",
      "oliphaunt-tools",
      "liboliphaunt-native-linux-x64-gnu",
      "oliphaunt-broker-linux-x64-gnu",
      "oliphaunt-extension-hstore-linux-x64-gnu",
      "oliphaunt-extension-pg-trgm-linux-x64-gnu",
      "oliphaunt-extension-unaccent-linux-x64-gnu",
    ]),
    requiredPackages: Object.freeze([
      "oliphaunt",
      "oliphaunt-build",
      "oliphaunt-tools",
      "liboliphaunt-native-linux-x64-gnu",
      "oliphaunt-broker-linux-x64-gnu",
      "oliphaunt-extension-hstore-linux-x64-gnu",
      "oliphaunt-extension-pg-trgm-linux-x64-gnu",
      "oliphaunt-extension-unaccent-linux-x64-gnu",
    ]),
  }),
  Object.freeze({
    id: "wasix-tauri",
    crateDir: "examples/tauri-wasix/src-tauri",
    ignoredLock: "examples/tauri-wasix/src-tauri/Cargo.lock",
    wasixToolchain: true,
    directPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    ]),
    requiredPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-hstore-wasix",
      "oliphaunt-extension-hstore-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-pg-trgm-wasix",
      "oliphaunt-extension-pg-trgm-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-unaccent-wasix",
      "oliphaunt-extension-unaccent-wasix-aot-x86_64-unknown-linux-gnu",
    ]),
  }),
  Object.freeze({
    id: "wasix-electron-sidecar",
    crateDir: "examples/electron-wasix/src-wasix",
    ignoredLock: "examples/electron-wasix/src-wasix/Cargo.lock",
    wasixToolchain: true,
    directPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    ]),
    requiredPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-hstore-wasix",
      "oliphaunt-extension-hstore-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-pg-trgm-wasix",
      "oliphaunt-extension-pg-trgm-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-extension-unaccent-wasix",
      "oliphaunt-extension-unaccent-wasix-aot-x86_64-unknown-linux-gnu",
    ]),
  }),
  Object.freeze({
    id: "wasix-tauri-sqlx",
    crateDir: "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri",
    ignoredLock: "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock",
    wasixToolchain: true,
    directPackages: Object.freeze([
      "oliphaunt-wasix",
      "oliphaunt-wasix-tools",
      "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
      "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    ]),
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

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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

function wasixToolchainVersions() {
  const manifest = readToml(path.join(ROOT, WASIX_TOOLCHAIN_PATH));
  const toolchain = objectTable(manifest.toolchain);
  const wasmer = toolchain.wasmer;
  const wasmerWasix = toolchain["wasmer-wasix"];
  if (typeof wasmer !== "string" || typeof wasmerWasix !== "string") {
    fail(`${WASIX_TOOLCHAIN_PATH} must declare Wasmer and Wasmer-WASIX versions`);
  }
  return { wasmer, wasmerWasix };
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

export function validateExampleManifests() {
  const context = catalogContext();
  const failures = [];
  for (const policy of EXAMPLE_CARGO_POLICIES) {
    const manifestPath = path.join(ROOT, policy.crateDir, "Cargo.toml");
    const manifest = readToml(manifestPath);
    if (existsSync(path.join(ROOT, policy.ignoredLock))) {
      failures.push(`${policy.ignoredLock} must be ephemeral and untracked`);
    }
    if (Object.hasOwn(manifest, "patch")) {
      failures.push(`${policy.crateDir}/Cargo.toml must not commit candidate registry patches`);
    }
    const seen = new Set();
    for (const table of dependencyTables(manifest)) {
      for (const [name, spec] of Object.entries(table)) {
        if (!isOliphauntCargoName(name)) continue;
        seen.add(name);
        if (typeof spec === "object" && spec !== null && Object.hasOwn(spec, "registry")) {
          failures.push(`${policy.crateDir}/Cargo.toml ${name} must use normal crates.io resolution`);
        }
        let expected;
        try {
          expected = `=${expectedCarrierVersion(name, context)}`;
        } catch (error) {
          failures.push(error.message);
          continue;
        }
        const actual = dependencyVersion(spec);
        if (actual !== expected) {
          failures.push(`${policy.crateDir}/Cargo.toml ${name} uses ${JSON.stringify(actual)}; expected ${expected}`);
        }
      }
    }
    for (const required of policy.requiredPackages) {
      try {
        expectedCarrierVersion(required, context);
      } catch (error) {
        failures.push(`${policy.id} required package: ${error.message}`);
      }
    }
    const expectedDirect = [...policy.directPackages].sort();
    const actualDirect = [...seen].sort();
    if (JSON.stringify(actualDirect) !== JSON.stringify(expectedDirect)) {
      failures.push(
        `${policy.id} direct Oliphaunt dependencies are ${JSON.stringify(actualDirect)}; expected ${JSON.stringify(expectedDirect)}`,
      );
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
  return leftParts.prerelease.localeCompare(rightParts.prerelease);
}

function optionalWasmerVersionKey(name) {
  if (name.startsWith("wasmer-compiler-")) return "wasmer";
  if (name.startsWith("wasmer-wasix-")) return "wasmerWasix";
  return null;
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
  for (const [name, versionKey] of REQUIRED_WASMER_PACKAGES) {
    const entries = byName.get(name) ?? [];
    const expected = toolchainVersions?.[versionKey];
    if (entries.length !== 1) {
      failures.push(`${lockfile}: expected exactly one resolved ${name} package, found ${entries.length}`);
      continue;
    }
    if (entries[0].source !== CRATES_IO_SOURCE) {
      failures.push(`${lockfile}: ${name} must resolve from crates.io, got ${entries[0].source ?? "path"}`);
    }
    if (entries[0].version !== expected) {
      failures.push(`${lockfile}: ${name} resolved ${entries[0].version}; expected ${expected}`);
    }
  }
  for (const pkg of packages) {
    if (REQUIRED_WASMER_PACKAGES.has(pkg.name)) continue;
    const versionKey = optionalWasmerVersionKey(pkg.name);
    const isWasmerPackage = pkg.name === "wasmer" || pkg.name.startsWith("wasmer-");
    if (isWasmerPackage && pkg.source !== CRATES_IO_SOURCE) {
      failures.push(`${lockfile}: ${pkg.name} must resolve from crates.io, got ${pkg.source ?? "path"}`);
    }
    if (versionKey !== null && pkg.version !== toolchainVersions?.[versionKey]) {
      failures.push(`${lockfile}: ${pkg.name} resolved ${pkg.version}; expected ${toolchainVersions?.[versionKey]}`);
    } else if (versionKey === null && isWasmerPackage) {
      const parsed = semverParts(pkg.version);
      if (parsed === null) {
        failures.push(`${lockfile}: ${pkg.name} has invalid semantic version ${pkg.version}`);
      } else if (parsed.prerelease !== null) {
        failures.push(`${lockfile}: ${pkg.name} must not resolve prerelease ${pkg.version}`);
      }
    }
  }
  return failures;
}

export {
  candidateRegistryDigest,
  candidateRegistryPackages,
  verifyCandidateRegistryPackage,
};

export function validateCandidateRegistry(indexDir) {
  const packages = candidateRegistryPackages(indexDir);
  const context = catalogContext();
  const failures = [];
  for (const entry of packages) {
    try {
      const expected = expectedCarrierVersion(entry.name, context);
      if (entry.vers !== expected) {
        failures.push(`${entry.name} candidate version ${entry.vers}; expected catalog version ${expected}`);
      }
      verifyCandidateRegistryPackage(indexDir, entry);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length > 0) fail(failures.join("\n"));
  return {
    packages,
    sha256: candidateRegistryDigest(packages),
  };
}

export function validateCandidateSourceSelection(lockfile, packages, candidateRows) {
  const failures = [];
  const byName = packageByName(packages);
  const candidateByName = new Map(candidateRows.map((entry) => [entry.name, entry]));
  for (const [name, candidate] of candidateByName) {
    const resolved = byName.get(name) ?? [];
    if (resolved.length === 0) continue;
    if (resolved.length !== 1) {
      failures.push(`${lockfile}: selected candidate ${name}@${candidate.vers} resolved ${resolved.length} package rows`);
      continue;
    }
    const pkg = resolved[0];
    if (pkg.source !== EXAMPLE_CARGO_REGISTRY_SOURCE) {
      failures.push(
        `${lockfile}: selected candidate ${name}@${candidate.vers} resolved from ${pkg.source ?? "path"}; expected ${EXAMPLE_CARGO_REGISTRY_SOURCE}`,
      );
    }
    if (pkg.version !== candidate.vers) {
      failures.push(`${lockfile}: selected candidate ${name} resolved ${pkg.version}; index has ${candidate.vers}`);
    }
    if (!HEX_SHA256.test(pkg.checksum ?? "")) {
      failures.push(`${lockfile}: ${name}@${pkg.version} must have an exact candidate checksum`);
    } else if (pkg.checksum !== candidate.cksum) {
      failures.push(`${lockfile}: ${name}@${pkg.version} lock checksum differs from candidate index`);
    }
  }
  for (const pkg of packages) {
    if (pkg.source !== EXAMPLE_CARGO_REGISTRY_SOURCE) continue;
    const candidate = candidateByName.get(pkg.name);
    if (candidate === undefined) {
      failures.push(`${lockfile}: local candidate ${pkg.name}@${pkg.version} is not present in the candidate index`);
    }
  }
  return failures;
}

export function validateCandidateLock(policyId, lockfile, indexDir, { registryVerified = false } = {}) {
  const policy = exampleCargoPolicyById(policyId);
  const data = readToml(lockfile);
  const packages = Array.isArray(data.package) ? data.package : [];
  const failures = validateResolvedPackagePolicy(lockfile, packages, {
    wasixToolchain: policy.wasixToolchain,
    toolchainVersions: wasixToolchainVersions(),
  });
  const context = catalogContext();
  const byName = packageByName(packages);
  const candidateRows = candidateRegistryPackages(indexDir);
  const candidateByName = new Map(candidateRows.map((entry) => [entry.name, entry]));
  failures.push(...validateCandidateSourceSelection(lockfile, packages, candidateRows));
  for (const required of policy.requiredPackages) {
    const resolved = byName.get(required) ?? [];
    if (resolved.length !== 1) {
      failures.push(`${lockfile}: expected exactly one required Oliphaunt package ${required}, found ${resolved.length}`);
    }
  }
  for (const pkg of packages) {
    if (!isOliphauntCargoName(pkg.name) || pkg.source === undefined) continue;
    let expectedVersion;
    try {
      expectedVersion = expectedCarrierVersion(pkg.name, context);
    } catch (error) {
      failures.push(`${lockfile}: ${error.message}`);
      continue;
    }
    if (pkg.version !== expectedVersion) {
      failures.push(`${lockfile}: ${pkg.name} resolved ${pkg.version}; expected catalog version ${expectedVersion}`);
    }
    const candidate = candidateByName.get(pkg.name);
    if (candidate === undefined) {
      if (pkg.source === EXAMPLE_CARGO_REGISTRY_SOURCE) {
        failures.push(`${lockfile}: ${pkg.name}@${pkg.version} uses the candidate source but is absent from its index`);
      } else if (pkg.source !== CRATES_IO_SOURCE) {
        failures.push(`${lockfile}: unchanged ${pkg.name}@${pkg.version} must resolve from crates.io, got ${pkg.source}`);
      }
      continue;
    }
    if (!registryVerified) {
      try {
        verifyCandidateRegistryPackage(indexDir, candidate);
      } catch (error) {
        failures.push(error.message);
      }
    }
  }
  if (failures.length > 0) {
    fail(failures.join("\n"));
  }
  return {
    policy: policy.id,
    packages: packages.length,
    candidatePackages: packages.filter((pkg) => pkg.source === EXAMPLE_CARGO_REGISTRY_SOURCE).length,
    sha256: sha256File(lockfile),
  };
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
