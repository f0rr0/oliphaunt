import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import {
  exactExtensionProducts,
  currentProductVersionSync,
  extensionMetadata,
  extensionReleaseProduct,
  extensionReleaseVersion,
  extensionRegistryPackageTargetSets,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import { compareText, ROOT } from "./release-graph.mjs";
import {
  nativeExtensionCargoPackageName,
} from "./extension-registry-packages.mjs";

import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from "./rust-native-targets.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";

const FACADE_NOTICE_OPTIONS = Object.freeze({ profile: "code-facade" });

function fail(message) {
  throw new Error(`package-extension-cargo-facades: ${message}`);
}

function facadeLinksName(product) {
  return `oliphaunt_artifact_relay_extension_${product
    .replace(/^oliphaunt-extension-/u, "")
    .replaceAll("-", "_")}`;
}

const FACADE_BUILD_RS = `use std::collections::BTreeMap;
use std::env;

const PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const RELAY_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_RELAY_";
const SUFFIX: &str = "_MANIFEST";

fn main() {
    let embedded = oliphaunt_build::embed_resolved_artifacts().expect("validate and embed extension resources");
    println!("cargo::rustc-env=OLIPHAUNT_EMBEDDED_RESOURCES_RS={}", embedded.display());
    let mut manifests = BTreeMap::new();
    for (key, value) in env::vars() {
        if value.is_empty() || key.starts_with(RELAY_PREFIX) {
            continue;
        }
        let Some(stem) = key.strip_prefix(PREFIX).and_then(|value| value.strip_suffix(SUFFIX)) else {
            continue;
        };
        if stem.is_empty() {
            panic!("empty Oliphaunt artifact metadata stem");
        }
        if let Some(previous) = manifests.insert(stem.to_ascii_lowercase(), value.clone()) {
            if previous != value {
                panic!("conflicting Oliphaunt extension leaf manifests for {stem}");
            }
        }
        println!("cargo::rerun-if-changed={value}");
    }
    if manifests.is_empty() && env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("extension facade resolved no target-leaf artifact manifest");
    }
    for (stem, manifest) in manifests {
        println!("cargo::metadata={stem}_manifest={manifest}");
    }
}
`;

export function renderUnsupportedNativeGuard(product, nativeTargets, nativeCfgs) {
  return renderUnsupportedNativeTargetGuard({
    product,
    nativeTargets,
    nativeCfgs,
    guidance: "use a declared native target leaf, or depend on the WASIX carrier directly for WASIX builds.",
  });
}

export function writeFacadeSource(product, outputRoot, { dependencyPaths = {} } = {}) {
  if (!exactExtensionProducts("package-extension-cargo-facades").includes(product)) {
    fail(`${product} is not an exact extension product`);
  }
  const nativeOwner = extensionReleaseProduct(product, "native", "package-extension-cargo-facades");
  const version = extensionReleaseVersion(product, "native", "package-extension-cargo-facades");
  const sqlNames = extensionSqlNames(product, "package-extension-cargo-facades");
  const sdkVersion = currentProductVersionSync("oliphaunt-rust");
  const buildVersion = sdkVersion;
  const runtimeVersion = extensionMetadata(product).compatibility.nativeRuntimeVersion;
  const targets = extensionRegistryPackageTargetSets(product, "package-extension-cargo-facades");
  const sourceDir = path.join(outputRoot, "sources", product);
  mkdirSync(path.join(sourceDir, "src"), { recursive: true });

  const targetDependencies = [];
  const nativeCfgs = [];
  for (const target of targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const name = nativeExtensionCargoPackageName(product, target);
    nativeCfgs.push(cfg);
    targetDependencies.push(
      `[target.'cfg(${cfg})'.dependencies]\n${name} = { version = "=${version}"${dependencyPaths[name] ? `, path = ${JSON.stringify(dependencyPaths[name])}` : ""} }`,
    );
  }
  const unsupportedNativeGuard = renderUnsupportedNativeGuard(
    product,
    targets.nativeCargoTargets,
    nativeCfgs,
  );
  const legalMembers = releaseNoticeRows(FACADE_NOTICE_OPTIONS).map((row) => row.member);
  writeFileSync(path.join(sourceDir, "Cargo.toml"), `[package]
name = ${JSON.stringify(product)}
version = ${JSON.stringify(version)}
edition = "2024"
rust-version = "1.93"
description = ${JSON.stringify(`Target-selecting Cargo facade for ${sqlNames.length} Oliphaunt PostgreSQL extension member${sqlNames.length === 1 ? "" : "s"}.`)}
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = ${JSON.stringify(releaseProfilePackageLicense("code-facade").spdx)}
links = ${JSON.stringify(facadeLinksName(product))}
build = "build.rs"
include = ${JSON.stringify(["Cargo.toml", "README.md", "build.rs", "src/**", ...legalMembers])}

[lib]
path = "src/lib.rs"

[dependencies]
oliphaunt-resources = { version = ${JSON.stringify(sdkVersion)}${dependencyPaths["oliphaunt-resources"] ? `, path = ${JSON.stringify(dependencyPaths["oliphaunt-resources"])}` : ""} }

[build-dependencies]
oliphaunt-build = { version = ${JSON.stringify(buildVersion)}${dependencyPaths["oliphaunt-build"] ? `, path = ${JSON.stringify(dependencyPaths["oliphaunt-build"])}` : ""} }

${targetDependencies.join("\n\n")}

[workspace]
`);
  writeFileSync(path.join(sourceDir, "build.rs"), FACADE_BUILD_RS);
  writeFileSync(path.join(sourceDir, "README.md"), `# ${product}

Target-selecting Cargo facade for ${sqlNames.length === 1 ? `the \`${sqlNames[0]}\` PostgreSQL extension` : `the PostgreSQL 18 contrib bundle (${sqlNames.length} exact SQL members)`}.

Cargo selects the matching native artifact automatically. For WASIX, use
\`${product}-wasix\` and its exported descriptors.
`);
  writeFileSync(path.join(sourceDir, "src/lib.rs"), `#![forbid(unsafe_code)]

${unsupportedNativeGuard}

pub const PRODUCT: &str = ${JSON.stringify(product)};
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EXTENSION_SQL_NAMES: &[&str] = &[${sqlNames.map((sqlName) => JSON.stringify(sqlName)).join(", ")}];
${sqlNames.length === 1 ? `pub const EXTENSION_SQL_NAME: &str = ${JSON.stringify(sqlNames[0])};` : ""}
const RESOURCES: &[oliphaunt_resources::EmbeddedResource] = include!(env!("OLIPHAUNT_EMBEDDED_RESOURCES_RS"));
${sqlNames.map((sqlName) => `pub const ${sqlName.replaceAll("-", "_").toUpperCase()}: oliphaunt_resources::ExtensionDescriptor = oliphaunt_resources::ExtensionDescriptor {
    sql_name: ${JSON.stringify(sqlName)}, product: PRODUCT, version: Some(VERSION),
    runtime_version: ${JSON.stringify(runtimeVersion)}, resources: RESOURCES,
};`).join("\n")}

`);
  stageReleaseNotices(sourceDir, FACADE_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(sourceDir, FACADE_NOTICE_OPTIONS);
  return { product, releaseProduct: nativeOwner, version, sourceDir };
}

export function packageExtensionCargoFacades(products, outputRoot) {
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length !== products.length || selected.length === 0) {
    fail("products must be a non-empty duplicate-free list");
  }
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(path.join(outputRoot, "crates"), { recursive: true });
  const packages = [];
  for (const product of selected) {
    const source = writeFacadeSource(product, outputRoot);
    const cratePath = manualCargoPackageSource(
      path.join(source.sourceDir, "Cargo.toml"),
      path.join(outputRoot, "crates"),
      { root: ROOT, fail: (_prefix, message) => { throw new Error(message); }, rel: String },
    );
    assertReleaseNoticesInArchive(cratePath, {
      ...FACADE_NOTICE_OPTIONS,
      prefix: path.basename(cratePath, ".crate"),
    });
    packages.push({
      product,
      name: product,
      version: source.version,
      cratePath,
      manifestPath: path.join(source.sourceDir, "Cargo.toml"),
      kind: "extension-facade",
    });
  }
  return packages;
}
