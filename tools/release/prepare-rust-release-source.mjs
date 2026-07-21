#!/usr/bin/env bun
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  allArtifactTargets,
  compareText,
  currentProductVersionSync,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import { ROOT } from "./release-cli-utils.mjs";
import {
  assertSameNativeTargetSet,
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from "./rust-native-targets.mjs";

const TOOL = "prepare-rust-release-source.mjs";
const LIBOLIPHAUNT_NATIVE_PRODUCT = "liboliphaunt-native";
const LIBOLIPHAUNT_TOOLS_PRODUCT = "oliphaunt-tools";
const BROKER_PRODUCT = "oliphaunt-broker";
const RUST_PRODUCT = "oliphaunt-rust";
const DEFAULT_STAGE_DIR = path.join(ROOT, "target/release/cargo-package-sources/oliphaunt");

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(2);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function liboliphauntCargoPackageName(targetId, packageBase = LIBOLIPHAUNT_NATIVE_PRODUCT) {
  return `${packageBase}-${targetId}`;
}

function brokerCargoPackageName(targetId) {
  return `${BROKER_PRODUCT}-${targetId}`;
}

function packageSection(text) {
  const parts = text.split("[package]");
  if (parts.length < 2) {
    fail("generated oliphaunt release source is missing [package]");
  }
  return parts[1].split("\n[", 1)[0];
}

function publishedArtifactTargets({ product, kind, surface }) {
  return allArtifactTargets({ product, kind, surface, publishedOnly: true }, TOOL);
}

function nativeSdkArtifactTargets() {
  const nativeTargets = publishedArtifactTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: "native-runtime",
    surface: "rust-native-direct",
  });
  const toolsTargets = publishedArtifactTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: "native-tools",
    surface: "rust-native-direct",
  });
  const brokerTargets = publishedArtifactTargets({
    product: BROKER_PRODUCT,
    kind: "broker-helper",
    surface: "rust-broker",
  });
  const nativeTargetIds = nativeTargets.map((target) => target.target);
  assertSameNativeTargetSet(
    "oliphaunt Rust SDK native runtime/tools",
    nativeTargetIds,
    toolsTargets.map((target) => target.target),
  );
  assertSameNativeTargetSet(
    "oliphaunt Rust SDK native runtime/broker",
    nativeTargetIds,
    brokerTargets.map((target) => target.target),
  );
  return { nativeTargets, brokerTargets };
}

export function renderRustSdkNativeTargetGuard(nativeTargets) {
  const targetIds = nativeTargets.map((target) => typeof target === "string" ? target : target.target);
  return renderUnsupportedNativeTargetGuard({
    product: "oliphaunt",
    nativeTargets: targetIds,
    nativeCfgs: targetIds.map((target) => rustNativeTargetCfg(target)),
    guidance: "use the separately versioned oliphaunt-wasix crate for WASIX environments.",
  });
}

function renderReleaseCargoToml(source, nativeVersion, brokerVersion, artifactTargets) {
  let text = source
    .replace("repository.workspace = true", 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replace("homepage.workspace = true", 'homepage = "https://oliphaunt.dev"');
  if (!text.includes("[workspace]")) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }

  const lines = [
    "",
    "# Generated for crates.io publishing. Source checkouts keep native runtime",
    "# and broker artifact crates out of the local dependency graph until those",
    "# artifacts are published and indexed.",
  ];
  const targetDependencies = new Map();
  const addTargetDependency = (cfg, dependency) => {
    const dependencies = targetDependencies.get(cfg) ?? [];
    dependencies.push(dependency);
    targetDependencies.set(cfg, dependencies);
  };

  for (const target of artifactTargets.nativeTargets) {
    const cfg = rustNativeTargetCfg(target);
    addTargetDependency(cfg, `${liboliphauntCargoPackageName(target.target)} = { version = "=${nativeVersion}" }`);
    addTargetDependency(cfg, `${LIBOLIPHAUNT_TOOLS_PRODUCT} = { version = "=${nativeVersion}" }`);
  }
  for (const target of artifactTargets.brokerTargets) {
    const cfg = rustNativeTargetCfg(target);
    addTargetDependency(cfg, `${brokerCargoPackageName(target.target)} = { version = "=${brokerVersion}" }`);
  }

  for (const cfg of [...targetDependencies.keys()].sort(compareText)) {
    lines.push("", `[target.'cfg(${cfg})'.dependencies]`);
    lines.push(...targetDependencies.get(cfg).sort(compareText));
  }
  return `${text.trimEnd()}\n${lines.join("\n")}\n`;
}

function validateReleaseArtifactCoverage(manifest, nativeVersion, nativeTargets) {
  const brokerCrates = registryPackageRows({ product: BROKER_PRODUCT, packageKind: "crates" }, TOOL)
    .map((row) => row.packageName);
  const missingBroker = brokerCrates.filter((crate) => !manifest.includes(`${crate} = `));
  if (missingBroker.length > 0) {
    fail(`generated oliphaunt release source is missing broker Cargo artifact dependencies: ${missingBroker.join(", ")}`);
  }

  const nativeRuntimeCrates = nativeTargets.map((target) => liboliphauntCargoPackageName(target.target));
  const nativeCrates = registryPackageRows({ product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: "crates" }, TOOL)
    .map((row) => row.packageName);
  if (nativeCrates.length === 0) {
    fail(
      "oliphaunt-rust cannot publish a working native Cargo consumer path: "
      + "oliphaunt-build requires Cargo-resolved liboliphaunt-native native-runtime "
      + `artifacts for ${nativeTargets.map((target) => target.target).join(", ")}, but liboliphaunt-native declares no crates.io `
      + "artifact packages. Split/size native runtime artifacts into crates.io-sized packages before publishing oliphaunt-rust.",
    );
  }

  const missingNative = nativeRuntimeCrates.filter(
    (crate) => !manifest.includes(`${crate} = { version = "=${nativeVersion}" }`),
  );
  if (missingNative.length > 0) {
    fail(`generated oliphaunt release source is missing native runtime Cargo artifact dependencies: ${missingNative.join(", ")}`);
  }
  if (!manifest.includes(`${LIBOLIPHAUNT_TOOLS_PRODUCT} = { version = "=${nativeVersion}" }`)) {
    fail(`generated oliphaunt release source is missing native tools facade dependency ${LIBOLIPHAUNT_TOOLS_PRODUCT}`);
  }
  const directToolDeps = nativeCrates
    .filter((crate) => crate.startsWith(`${LIBOLIPHAUNT_TOOLS_PRODUCT}-`) && manifest.includes(`${crate} = `))
    .sort(compareText);
  if (directToolDeps.length > 0) {
    fail(`generated oliphaunt release source must depend on oliphaunt-tools, not target tools crates: ${directToolDeps.join(", ")}`);
  }
}

function releaseStageDir(stageDir) {
  const resolved = path.resolve(ROOT, stageDir);
  const relative = path.relative(ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`generated Rust release stage must be a repository-contained directory, got ${stageDir}`);
  }
  return resolved;
}

export function prepareRustReleaseSource({ stageDir = DEFAULT_STAGE_DIR, log = true } = {}) {
  const version = currentProductVersionSync(RUST_PRODUCT, TOOL);
  const nativeVersion = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  const brokerVersion = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  const artifactTargets = nativeSdkArtifactTargets();
  const sourceDir = path.join(ROOT, "src/sdks/rust");
  const outputDir = releaseStageDir(stageDir);
  rmSync(outputDir, { recursive: true, force: true });
  cpSync(sourceDir, outputDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== "target",
  });
  rmSync(path.join(outputDir, "crates/oliphaunt-build"), { recursive: true, force: true });

  const cargoToml = path.join(outputDir, "Cargo.toml");
  const rendered = renderReleaseCargoToml(
    readFileSync(cargoToml, "utf8"),
    nativeVersion,
    brokerVersion,
    artifactTargets,
  );
  writeFileSync(cargoToml, rendered, "utf8");
  if (!packageSection(rendered).includes(`version = "${version}"`)) {
    fail(`generated oliphaunt release source must keep SDK version ${version}`);
  }
  validateReleaseArtifactCoverage(rendered, nativeVersion, artifactTargets.nativeTargets);
  const libRs = path.join(outputDir, "src/lib.rs");
  writeFileSync(
    libRs,
    `${readFileSync(libRs, "utf8").trimEnd()}\n\n// Generated release-only native target guard.\n`
      + `${renderRustSdkNativeTargetGuard(artifactTargets.nativeTargets)}\n`,
    "utf8",
  );
  if (log) console.log(rel(cargoToml));
  return cargoToml;
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("usage: tools/release/prepare-rust-release-source.mjs");
    process.exit(0);
  }
  if (argv.length > 0) {
    fail(`prepare-rust-release-source does not accept extra arguments: ${argv.join(" ")}`);
  }
  prepareRustReleaseSource();
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
