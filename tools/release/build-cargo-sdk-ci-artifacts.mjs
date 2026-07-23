#!/usr/bin/env bun
import path from "node:path";

import { verifyPackagedCargoTestClosure } from "./check-cargo-package-test-closure.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { ROOT, run } from "./release-cli-utils.mjs";

const TOOL = "build-cargo-sdk-ci-artifacts.mjs";
const PRODUCTS = ["oliphaunt-rust", "oliphaunt-wasix-rust"];

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

export function cargoSdkPackageClosure(product) {
  if (!PRODUCTS.includes(product)) {
    throw new Error(`${TOOL}: unsupported Cargo SDK product: ${product}`);
  }
  const version = currentProductVersionSync(product, TOOL);
  const artifactRoot = path.join(ROOT, "target/sdk-artifacts", product);
  if (product === "oliphaunt-rust") {
    return {
      cratePath: path.join(artifactRoot, `oliphaunt-${version}.crate`),
      allFeatures: true,
      stubDependencies: ["oliphaunt-tools"],
      stubDependencyPrefixes: ["liboliphaunt-native-", "oliphaunt-broker-"],
    };
  }
  if (product === "oliphaunt-wasix-rust") {
    return {
      cratePath: path.join(artifactRoot, `oliphaunt-wasix-${version}.crate`),
      pathDependencyManifests: [
        path.join(ROOT, "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"),
      ],
      noDefaultFeatures: true,
      features: ["extensions", "tools", "icu"],
    };
  }
  throw new Error(`${TOOL}: missing Cargo SDK package-closure configuration: ${product}`);
}

function main() {
  const product = Bun.argv[2] ?? "";
  if (product === "--help" || product === "-h") {
    console.log(`usage: tools/release/${TOOL} <${PRODUCTS.join("|")}>`);
    process.exit(0);
  }
  if (!PRODUCTS.includes(product) || Bun.argv.length !== 3) {
    fail(`usage: tools/release/${TOOL} <${PRODUCTS.join("|")}>`);
  }

  run(TOOL, [process.execPath, "tools/release/build-sdk-ci-artifacts.mjs", product]);
  verifyPackagedCargoTestClosure(cargoSdkPackageClosure(product));
  console.log(`Built and verified exact ${product} Cargo SDK artifacts`);
}

if (import.meta.main) {
  main();
}
