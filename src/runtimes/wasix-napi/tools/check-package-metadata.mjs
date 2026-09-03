#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseProfilePackageLicense } from "../../../../tools/release/release-notices.mjs";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRODUCT_ROOT = path.join(WORKSPACE_ROOT, "src/runtimes/wasix-napi");
const EXPECTED_LICENSE = releaseProfilePackageLicense("wasix-napi-addon").spdx;
const STABLE_SEMVER = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;
const BINARY = "oliphaunt_wasix_napi.node";
const CARRIERS = Object.freeze({
  "darwin-arm64": {
    name: "@oliphaunt/wasix-napi-darwin-arm64",
    target: "macos-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
  },
  "linux-arm64-gnu": {
    name: "@oliphaunt/wasix-napi-linux-arm64-gnu",
    target: "linux-arm64-gnu",
    os: ["linux"],
    cpu: ["arm64"],
    libc: ["glibc"],
  },
  "linux-x64-gnu": {
    name: "@oliphaunt/wasix-napi-linux-x64-gnu",
    target: "linux-x64-gnu",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
  },
  "win32-x64-msvc": {
    name: "@oliphaunt/wasix-napi-win32-x64-msvc",
    target: "windows-x64-msvc",
    os: ["win32"],
    cpu: ["x64"],
  },
});

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stableVersion(value, label) {
  assert(
    typeof value === "string" && STABLE_SEMVER.test(value),
    `${label} must be a stable SemVer X.Y.Z version`,
  );
  assert(
    value.split(".").every((part) => Number.isSafeInteger(Number.parseInt(part, 10))),
    `${label} contains a numeric component outside JavaScript's safe integer range`,
  );
  return value;
}

function cargoPackageVersion(source) {
  const version = Bun.TOML.parse(source)?.package?.version;
  assert(typeof version === "string", "Cargo product must declare [package].version");
  return version;
}

function assertWorkspaceDependency(dependencies, name) {
  const dependency = dependencies?.[name];
  assert(
    dependency !== null
      && typeof dependency === "object"
      && dependency.version === "*"
      && typeof dependency.path === "string",
    `Cargo dependency ${name} must use its workspace path without a release-version constraint`,
  );
  return dependency;
}

export function assertCanonicalVersionContract({
  npmVersion,
  cargoVersion,
  carrierVersions,
  changelogBytes,
}) {
  const canonical = stableVersion(npmVersion, "canonical npm package version");
  assert(
    stableVersion(cargoVersion, "canonical Cargo package version") === canonical,
    "canonical npm and Cargo package versions must match",
  );
  for (const [carrier, version] of Object.entries(carrierVersions)) {
    assert(
      stableVersion(version, `${carrier} version`) === canonical,
      `${carrier} must match the canonical product version`,
    );
  }
  const changelogEmpty = changelogBytes.length === 0;
  assert(
    changelogEmpty === (canonical === "0.0.0"),
    canonical === "0.0.0"
      ? "new product CHANGELOG.md must remain byte-empty until its first generated release"
      : "released product CHANGELOG.md must not remain byte-empty",
  );
  return canonical;
}

function main() {
  const rootManifest = readJson(path.join(PRODUCT_ROOT, "package.json"));
  assert(rootManifest.name === "@oliphaunt/wasix-napi", "canonical package has the wrong name");
  assert(rootManifest.private === true, "canonical WASIX N-API package must remain private");
  assert(
    rootManifest.oliphaunt?.runtimeProduct === "liboliphaunt-wasix",
    "canonical package must identify the portable WASIX runtime product",
  );
  assert(
    rootManifest.oliphaunt?.rustBindingProduct === "oliphaunt-wasix-rust",
    "canonical package must identify the WASIX Rust binding product",
  );
  assert(rootManifest.oliphaunt?.addonAbiVersion === 1, "canonical package must pin addon ABI 1");
  assert(rootManifest.oliphaunt?.nodeApiVersion === 8, "canonical package must pin Node-API 8");
  assert(
    equal(rootManifest.oliphaunt?.profiles, ["standard", "icu"]),
    "canonical package must declare the standard and ICU profiles",
  );

  const carrierVersions = {};
  for (const [directory, expected] of Object.entries(CARRIERS)) {
    const file = path.join(PRODUCT_ROOT, "packages", directory, "package.json");
    const manifest = readJson(file);
    const label = path.relative(WORKSPACE_ROOT, file);
    assert(manifest.name === expected.name, `${label} has the wrong package name`);
    carrierVersions[label] = manifest.version;
    assert(manifest.license === EXPECTED_LICENSE, `${label} has the wrong embedded-runtime license`);
    assert(manifest.optional === true, `${label} must be optional`);
    assert(equal(manifest.os, expected.os), `${label} has the wrong os selector`);
    assert(equal(manifest.cpu, expected.cpu), `${label} has the wrong cpu selector`);
    assert(equal(manifest.libc, expected.libc), `${label} has the wrong libc selector`);
    assert(manifest.oliphaunt?.target === expected.target, `${label} has the wrong target`);
    assert(
      manifest.oliphaunt?.runtimeProduct === rootManifest.oliphaunt.runtimeProduct,
      `${label} must match the canonical WASIX runtime product`,
    );
    assert(
      manifest.oliphaunt?.runtimeVersion === rootManifest.oliphaunt.runtimeVersion,
      `${label} must match the canonical WASIX runtime version`,
    );
    assert(manifest.oliphaunt?.addonAbiVersion === 1, `${label} has the wrong addon ABI`);
    assert(manifest.oliphaunt?.nodeApiVersion === 8, `${label} has the wrong Node-API floor`);
    assert(equal(manifest.oliphaunt?.profiles, ["standard", "icu"]), `${label} must carry both profiles`);
    assert(!Object.hasOwn(manifest, "scripts"), `${label} must not have lifecycle scripts`);
    assert(
      manifest.exports?.[`./${BINARY}`] === `./prebuilds/${BINARY}`,
      `${label} must export ${BINARY} at its stable package subpath`,
    );
    assert(
      equal(Object.keys(manifest.exports ?? {}), [
        `./${BINARY}`,
        "./artifact-provenance.json",
        "./package.json",
      ]),
      `${label} must expose one addon binary plus provenance and package metadata`,
    );
    for (const member of [
      "prebuilds",
      "artifact-provenance.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
      "THIRD_PARTY_LICENSES",
    ]) {
      assert(manifest.files?.includes(member), `${label} files must include ${member}`);
    }
  }

  assert(
    !Object.hasOwn(rootManifest, "optionalDependencies"),
    "private build package must leave carrier selection to the public TypeScript facade",
  );

  const cargo = readFileSync(path.join(PRODUCT_ROOT, "Cargo.toml"), "utf8");
  const cargoManifest = Bun.TOML.parse(cargo);
  assertCanonicalVersionContract({
    npmVersion: rootManifest.version,
    cargoVersion: cargoPackageVersion(cargo),
    carrierVersions,
    changelogBytes: readFileSync(path.join(PRODUCT_ROOT, "CHANGELOG.md")),
  });
  assert(cargoManifest.dependencies?.napi?.version === "=3.12.2", "Cargo must pin napi-rs exactly");
  assert(
    equal(cargoManifest.dependencies?.["oliphaunt-wasix"]?.features, ["__internal-napi", "icu"]),
    "Cargo must embed the ICU-capable Rust runtime in the one addon",
  );
  for (const dependency of [
    "liboliphaunt-wasix-portable",
    "oliphaunt-icu",
    "oliphaunt-wasix",
    "oliphaunt-wasix-tools",
  ]) assertWorkspaceDependency(cargoManifest.dependencies, dependency);
  assert(Array.isArray(cargoManifest.features?.release), "Cargo must define the complete release payload feature");
  stableVersion(rootManifest.oliphaunt?.runtimeVersion, "canonical runtime compatibility");
  stableVersion(rootManifest.oliphaunt?.rustBindingVersion, "canonical Rust-binding compatibility");
  process.stdout.write("oliphaunt-wasix-napi package metadata validated\n");
}

try {
  if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
} catch (error) {
  console.error(`check-wasix-napi-package-metadata: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
