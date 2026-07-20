import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import {
  extensionRegistryPackageTargetSets,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import { compareText, loadGraph, ROOT } from "./release-graph.mjs";
import {
  nativeExtensionCargoPackageName,
} from "./extension-registry-packages.mjs";
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";
import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from "./rust-native-targets.mjs";

function fail(message) {
  throw new Error(`package-extension-cargo-facades: ${message}`);
}

function dependencyFeature(name) {
  return `dep:${name}`;
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
    feature: "native",
    featureLabel: "default native feature",
    guidance: 'use default-features = false with feature "wasix" or a declared "wasix-aot-*" feature on other targets.',
  });
}

export function writeFacadeSource(product, outputRoot, { dependencyPaths = {} } = {}) {
  const graph = loadGraph("package-extension-cargo-facades");
  const config = graph.products[product];
  if (!["exact-extension-artifact", "exact-extension-bundle"].includes(config?.kind)) {
    fail(`${product} is not an exact extension product`);
  }
  const version = config.version;
  const sqlNames = extensionSqlNames(product, "package-extension-cargo-facades");
  const targets = extensionRegistryPackageTargetSets(product, "package-extension-cargo-facades");
  const wasixAotTargets = targets.includeWasixAot ? expectedExtensionAotTargets() : [];
  const sourceDir = path.join(outputRoot, "sources", product);
  mkdirSync(path.join(sourceDir, "src"), { recursive: true });

  const nativeNames = targets.nativeCargoTargets.map((target) => nativeExtensionCargoPackageName(product, target));
  const wasixName = wasixExtensionPackageName(product);
  const aotNames = wasixAotTargets.map((target) => wasixExtensionAotPackageName(product, target));
  const features = [
    `default = ["native"]`,
    `native = [${nativeNames.map((name) => JSON.stringify(dependencyFeature(name))).join(", ")}]`,
    `wasix = [${JSON.stringify(dependencyFeature(wasixName))}]`,
    ...aotNames.map((name, index) => `${JSON.stringify(`wasix-aot-${wasixAotTargets[index]}`)} = [${JSON.stringify(dependencyFeature(wasixName))}, ${JSON.stringify(dependencyFeature(name))}]`),
  ];
  const targetDependencies = [];
  const nativeCfgs = [];
  for (const target of targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const name = nativeExtensionCargoPackageName(product, target);
    nativeCfgs.push(cfg);
    targetDependencies.push(
      `[target.'cfg(${cfg})'.dependencies]\n${name} = { version = "=${version}", optional = true${dependencyPaths[name] ? `, path = ${JSON.stringify(dependencyPaths[name])}` : ""} }`,
    );
  }
  const optionalDependencies = [wasixName, ...aotNames]
    .map((name) => `${name} = { version = "=${version}", optional = true${dependencyPaths[name] ? `, path = ${JSON.stringify(dependencyPaths[name])}` : ""} }`)
    .join("\n");
  const unsupportedNativeGuard = renderUnsupportedNativeGuard(
    product,
    targets.nativeCargoTargets,
    nativeCfgs,
  );
  writeFileSync(path.join(sourceDir, "Cargo.toml"), `[package]
name = ${JSON.stringify(product)}
version = ${JSON.stringify(version)}
edition = "2024"
rust-version = "1.93"
description = ${JSON.stringify(`Target-selecting Cargo facade for ${sqlNames.length} Oliphaunt PostgreSQL extension member${sqlNames.length === 1 ? "" : "s"}.`)}
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = ${JSON.stringify(facadeLinksName(product))}
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**"]

[lib]
path = "src/lib.rs"

[features]
${features.join("\n")}

[dependencies]
${optionalDependencies}

${targetDependencies.join("\n\n")}

[workspace]
`);
  writeFileSync(path.join(sourceDir, "build.rs"), FACADE_BUILD_RS);
  writeFileSync(path.join(sourceDir, "README.md"), `# ${product}

Target-selecting Cargo facade for ${sqlNames.length === 1 ? `the \`${sqlNames[0]}\` PostgreSQL extension` : `the PostgreSQL 18 contrib bundle (${sqlNames.length} exact SQL members)`}.

The default \`native\` feature selects the matching native artifact leaf. Use
\`default-features = false, features = ["wasix"]\` (or a host-specific
\`wasix-aot-*\` feature) for WASIX artifacts.
`);
  writeFileSync(path.join(sourceDir, "src/lib.rs"), `#![forbid(unsafe_code)]

${unsupportedNativeGuard}

pub const PRODUCT: &str = ${JSON.stringify(product)};
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EXTENSION_SQL_NAMES: &[&str] = &[${sqlNames.map((sqlName) => JSON.stringify(sqlName)).join(", ")}];
${sqlNames.length === 1 ? `pub const EXTENSION_SQL_NAME: &str = ${JSON.stringify(sqlNames[0])};` : ""}
`);
  return { product, version, sourceDir };
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
