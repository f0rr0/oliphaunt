import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import {
  extensionRegistryPackageTargetSets,
  extensionSqlName,
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

function writeFacadeSource(product, outputRoot) {
  const graph = loadGraph("package-extension-cargo-facades");
  const config = graph.products[product];
  if (config?.kind !== "exact-extension-artifact") {
    fail(`${product} is not an exact extension product`);
  }
  const version = config.version;
  const sqlName = extensionSqlName(product, "package-extension-cargo-facades");
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
    ...aotNames.map((name) => `${JSON.stringify(name.replace(`${product}-wasix-`, "wasix-"))} = [${JSON.stringify(dependencyFeature(name))}]`),
  ];
  const targetDependencies = [];
  const nativeCfgs = [];
  for (const target of targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const name = nativeExtensionCargoPackageName(product, target);
    nativeCfgs.push(cfg);
    targetDependencies.push(
      `[target.'cfg(${cfg})'.dependencies]\n${name} = { version = "=${version}", optional = true }`,
    );
  }
  const optionalDependencies = [wasixName, ...aotNames]
    .map((name) => `${name} = { version = "=${version}", optional = true }`)
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
description = ${JSON.stringify(`Target-selecting Cargo facade for the ${sqlName} Oliphaunt PostgreSQL extension.`)}
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
include = ["Cargo.toml", "README.md", "src/**"]

[lib]
path = "src/lib.rs"

[features]
${features.join("\n")}

[dependencies]
${optionalDependencies}

${targetDependencies.join("\n\n")}

[workspace]
`);
  writeFileSync(path.join(sourceDir, "README.md"), `# ${product}

Target-selecting Cargo facade for the \`${sqlName}\` Oliphaunt PostgreSQL extension.

The default \`native\` feature selects the matching native artifact leaf. Use
\`default-features = false, features = ["wasix"]\` (or a host-specific
\`wasix-aot-*\` feature) for WASIX artifacts.
`);
  writeFileSync(path.join(sourceDir, "src/lib.rs"), `#![forbid(unsafe_code)]

${unsupportedNativeGuard}

pub const PRODUCT: &str = ${JSON.stringify(product)};
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EXTENSION_SQL_NAME: &str = ${JSON.stringify(sqlName)};
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
