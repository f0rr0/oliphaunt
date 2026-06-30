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

const TOOL = "prepare-rust-release-source.mjs";
const LIBOLIPHAUNT_NATIVE_PRODUCT = "liboliphaunt-native";
const LIBOLIPHAUNT_TOOLS_PRODUCT = "oliphaunt-tools";
const BROKER_PRODUCT = "oliphaunt-broker";
const RUST_PRODUCT = "oliphaunt-rust";

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

function rustArtifactCargoTargetCfg(target) {
  if (target.target === "linux-arm64-gnu") {
    return 'all(target_os = "linux", target_arch = "aarch64", target_env = "gnu")';
  }
  if (target.target === "linux-x64-gnu") {
    return 'all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")';
  }
  if (target.target === "macos-arm64") {
    return 'all(target_os = "macos", target_arch = "aarch64")';
  }
  if (target.target === "windows-x64-msvc") {
    return 'all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")';
  }
  fail(`unsupported Cargo target cfg for ${target.id}`);
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

function renderReleaseCargoToml(source, nativeVersion, brokerVersion) {
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

  for (const target of publishedArtifactTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: "native-runtime",
    surface: "rust-native-direct",
  })) {
    const cfg = rustArtifactCargoTargetCfg(target);
    addTargetDependency(cfg, `${liboliphauntCargoPackageName(target.target)} = { version = "=${nativeVersion}" }`);
    addTargetDependency(cfg, `${LIBOLIPHAUNT_TOOLS_PRODUCT} = { version = "=${nativeVersion}" }`);
  }
  for (const target of publishedArtifactTargets({
    product: BROKER_PRODUCT,
    kind: "broker-helper",
    surface: "rust-broker",
  })) {
    const cfg = rustArtifactCargoTargetCfg(target);
    addTargetDependency(cfg, `${brokerCargoPackageName(target.target)} = { version = "=${brokerVersion}" }`);
  }

  for (const cfg of [...targetDependencies.keys()].sort(compareText)) {
    lines.push("", `[target.'cfg(${cfg})'.dependencies]`);
    lines.push(...targetDependencies.get(cfg).sort(compareText));
  }
  return `${text.trimEnd()}\n${lines.join("\n")}\n`;
}

function validateReleaseArtifactCoverage(manifest, nativeVersion) {
  const brokerCrates = registryPackageRows({ product: BROKER_PRODUCT, packageKind: "crates" }, TOOL)
    .map((row) => row.packageName);
  const missingBroker = brokerCrates.filter((crate) => !manifest.includes(`${crate} = `));
  if (missingBroker.length > 0) {
    fail(`generated oliphaunt release source is missing broker Cargo artifact dependencies: ${missingBroker.join(", ")}`);
  }

  const nativeTargets = publishedArtifactTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: "native-runtime",
    surface: "rust-native-direct",
  });
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

function prepareRustReleaseSource() {
  const version = currentProductVersionSync(RUST_PRODUCT, TOOL);
  const nativeVersion = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  const brokerVersion = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  const sourceDir = path.join(ROOT, "src/sdks/rust");
  const stageDir = path.join(ROOT, "target/release/cargo-package-sources/oliphaunt");
  rmSync(stageDir, { recursive: true, force: true });
  cpSync(sourceDir, stageDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== "target",
  });
  rmSync(path.join(stageDir, "crates/oliphaunt-build"), { recursive: true, force: true });

  const cargoToml = path.join(stageDir, "Cargo.toml");
  const rendered = renderReleaseCargoToml(readFileSync(cargoToml, "utf8"), nativeVersion, brokerVersion);
  writeFileSync(cargoToml, rendered, "utf8");
  if (!packageSection(rendered).includes(`version = "${version}"`)) {
    fail(`generated oliphaunt release source must keep SDK version ${version}`);
  }
  validateReleaseArtifactCoverage(rendered, nativeVersion);
  console.log(rel(cargoToml));
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

main(Bun.argv.slice(2));
