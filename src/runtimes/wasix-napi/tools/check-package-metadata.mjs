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
  const header = source.match(/^\[package\]\s*$/mu);
  assert(header !== null, "Cargo product must declare a [package] table");
  const afterHeader = source.slice((header.index ?? 0) + header[0].length);
  const nextTable = afterHeader.search(/^\[[^\n]+\]\s*$/mu);
  const packageTable = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);
  const version = packageTable?.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  assert(version !== undefined, "Cargo product must declare [package].version");
  return version;
}

function cargoExactDependencyVersion(source, dependency) {
  const line = source
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(`${dependency} =`));
  const version = line?.match(/\bversion\s*=\s*"=([^"]+)"/u)?.[1];
  assert(version !== undefined, `Cargo dependency ${dependency} must use an exact =version`);
  return stableVersion(version, `Cargo dependency ${dependency}`);
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
  assertCanonicalVersionContract({
    npmVersion: rootManifest.version,
    cargoVersion: cargoPackageVersion(cargo),
    carrierVersions,
    changelogBytes: readFileSync(path.join(PRODUCT_ROOT, "CHANGELOG.md")),
  });
  assert(cargo.includes('napi = { version = "=3.12.2"'), "Cargo must pin napi-rs exactly");
  assert(
    cargo.includes('features = ["__internal-napi", "icu"]'),
    "Cargo must embed the ICU-capable Rust runtime in the one addon",
  );
  assert(cargo.includes('oliphaunt-icu = { version = "='), "Cargo must embed the ICU data payload");
  assert(cargo.includes("release = ["), "Cargo must define the complete release payload feature");

  const portableRuntimeCargo = readFileSync(
    path.join(WORKSPACE_ROOT, "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml"),
    "utf8",
  );
  const portableRuntimeVersion = cargoPackageVersion(portableRuntimeCargo);
  const declaredPortableRuntimeVersion = cargoExactDependencyVersion(
    cargo,
    "liboliphaunt-wasix-portable",
  );
  const rustBindingCargo = readFileSync(
    path.join(WORKSPACE_ROOT, "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"),
    "utf8",
  );
  const rustBindingVersion = cargoPackageVersion(rustBindingCargo);
  const declaredRustBindingVersion = cargoExactDependencyVersion(cargo, "oliphaunt-wasix");
  assert(
    rootManifest.oliphaunt?.runtimeVersion === declaredPortableRuntimeVersion
      && declaredPortableRuntimeVersion === portableRuntimeVersion,
    "canonical runtime compatibility and dependency must match liboliphaunt-wasix-portable",
  );
  assert(
    rootManifest.oliphaunt?.rustBindingVersion === declaredRustBindingVersion
      && declaredRustBindingVersion === rustBindingVersion,
    "canonical Rust-binding compatibility and dependency must match oliphaunt-wasix",
  );

  const source = readFileSync(path.join(PRODUCT_ROOT, "src/lib.rs"), "utf8");
  for (const symbol of [
    "NativeWasixActorDatabase",
    "NativeWasixDatabase",
    "NativeWasixServer",
    'js_name = "addonAbiVersion"',
    'js_name = "nodeApiVersion"',
    'js_name = "runtimeVersion"',
    'env!("OLIPHAUNT_WASIX_RUNTIME_VERSION")',
    'js_name = "supportedProfiles"',
    'js_name = "extensionIdentity"',
    'js_name = "toolIdentity"',
    'js_name = "payloadIdentity"',
    'js_name = "restoreDirect"',
    "Option<Oliphaunt>",
    "impl Drop for NativeWasixDatabase",
    "impl ObjectFinalize for NativeWasixActorDatabase",
    "impl ObjectFinalize for NativeWasixServer",
  ]) {
    assert(source.includes(symbol), `Rust boundary is missing ${symbol}`);
  }
  const sourceLines = source.split(/\r?\n/u);
  const exportedCallAttributes = sourceLines.filter(
    (line, index) => /^\s*#\[napi\(/u.test(line)
      && /^\s*pub fn /u.test(sourceLines[index + 1] ?? ""),
  );
  assert(exportedCallAttributes.length > 0, "Rust boundary must have exported calls");
  assert(
    exportedCallAttributes.every((line) => line.includes("catch_unwind")),
    "every exported Rust call must opt into napi-rs catch_unwind",
  );
  const buildScript = readFileSync(path.join(PRODUCT_ROOT, "build.rs"), "utf8");
  for (const contract of [
    'exact_dependency_version(&manifest, "liboliphaunt-wasix-portable")',
    'exact_dependency_version(&manifest, "oliphaunt-wasix")',
    "OLIPHAUNT_WASIX_RUNTIME_VERSION",
    "OLIPHAUNT_WASIX_RUST_BINDING_VERSION",
    "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD",
    "OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR",
    "OLIPHAUNT_WASM_GENERATED_AOT_DIR",
    "OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT",
    "OLIPHAUNT_ICU_DATA_DIR",
    "OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS",
  ]) {
    assert(buildScript.includes(contract), `build.rs is missing release input contract ${contract}`);
  }
  const nativeBuildScript = readFileSync(
    path.join(PRODUCT_ROOT, "tools/build-native.sh"),
    "utf8",
  );
  for (const contract of [
    "tools/detect-linux-libc.mjs",
    "do not support Linux musl",
    "tools/release/build-linux-wasix-napi-baseline.sh",
    '"NativeWasixActorDatabase"',
    '"restoreDirect"',
    "expected_runtime_version",
    "toolIdentity(tool.name)",
    "extensionIdentity(extension.sqlName)",
  ]) {
    assert(
      nativeBuildScript.includes(contract),
      `build-native.sh is missing host/smoke contract ${contract}`,
    );
  }
  const linuxBaselineBuild = readFileSync(
    path.join(WORKSPACE_ROOT, "tools/release/build-linux-wasix-napi-baseline.sh"),
    "utf8",
  );
  for (const contract of [
    "rust@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea",
    'expected_builder_glibc="glibc 2.36"',
    "docker_cargo none",
    "--read-only",
    "--cap-drop ALL",
    "OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS",
  ]) {
    assert(
      linuxBaselineBuild.includes(contract),
      `Linux baseline builder is missing sealed-build contract ${contract}`,
    );
  }
  const packageScript = readFileSync(path.join(PRODUCT_ROOT, "tools/package-platform.mjs"), "utf8");
  assert(packageScript.includes("buildInputs,"), "artifact provenance must embed validated build inputs");
  for (const contract of [
    "localWindowsTarInvocation",
    "stageWindowsVcRuntime({",
    "sourceDirectory: packagePrebuilds",
    "WINDOWS_VC_RUNTIME_RECEIPT",
  ]) {
    assert(
      packageScript.includes(contract),
      `platform packaging is missing Windows carrier contract ${contract}`,
    );
  }
  assert(
    !packageScript.includes("write_checksum_manifest"),
    "per-target packaging must not emit the aggregate checksum manifest",
  );
  const packagedSmoke = readFileSync(
    path.join(PRODUCT_ROOT, "tools/smoke-packaged-addon.mjs"),
    "utf8",
  );
  assert(
    packagedSmoke.includes('"**/prebuilds/**"'),
    "Electron ASAR smoke must unpack the addon and all platform loader companions",
  );
  process.stdout.write("oliphaunt-wasix-napi package metadata validated\n");
}

try {
  if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
} catch (error) {
  console.error(`check-wasix-napi-package-metadata: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
