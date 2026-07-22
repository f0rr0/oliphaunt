#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "build-sdk-ci-artifacts.mjs";
const SDK_PRODUCT_MODULES = new Map([
  ["oliphaunt-rust", "./sdk-artifacts/rust.mjs"],
  ["oliphaunt-swift", "./sdk-artifacts/swift.mjs"],
  ["oliphaunt-kotlin", "./sdk-artifacts/kotlin.mjs"],
  ["oliphaunt-js", "./sdk-artifacts/js.mjs"],
  ["oliphaunt-react-native", "./sdk-artifacts/react-native.mjs"],
  ["oliphaunt-wasix-rust", "./sdk-artifacts/wasix-rust.mjs"],
]);

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeArtifactIndex(artifactRoot) {
  const entries = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name))
    .sort(compareText);
  if (entries.length === 0) {
    fail("no SDK artifacts were staged");
  }
  const index = path.join(artifactRoot, "artifacts.txt");
  const lines = [...entries, index].sort(compareText).map((entry) => rel(entry));
  writeFileSync(index, `${lines.join("\n")}\n`);
}

function checkStagedArtifacts(product) {
  const result = spawnSync(process.execPath, [
    "tools/release/check-staged-artifacts.mjs",
    "--require-sdk-product",
    product,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`check staged SDK artifacts failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail("check staged SDK artifacts failed");
  }
}

async function main() {
  const product = Bun.argv[2] ?? "";
  const products = [...SDK_PRODUCT_MODULES.keys()];
  if (product === "--help" || product === "-h") {
    console.log(`usage: tools/release/build-sdk-ci-artifacts.mjs <${products.join("|")}>`);
    process.exit(0);
  }
  if (!product) {
    fail(`usage: tools/release/build-sdk-ci-artifacts.mjs <${products.join("|")}>`);
  }
  const moduleSpecifier = SDK_PRODUCT_MODULES.get(product);
  if (!moduleSpecifier) {
    fail(`unsupported SDK product: ${product}`);
  }

  const artifactRoot = path.join(ROOT, "target/sdk-artifacts", product);
  const workRoot = path.join(ROOT, "target/sdk-artifacts-work", product);
  rmSync(artifactRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  const productModule = await import(moduleSpecifier);
  if (typeof productModule.stageArtifacts !== "function") {
    fail(`SDK artifact module for ${product} does not export stageArtifacts`);
  }
  await productModule.stageArtifacts(artifactRoot, workRoot);

  writeArtifactIndex(artifactRoot);
  checkStagedArtifacts(product);
  console.log(`Staged ${product} SDK artifacts under ${rel(artifactRoot)}`);
}

if (import.meta.main) {
  await main();
}
