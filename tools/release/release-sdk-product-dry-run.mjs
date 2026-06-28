#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT, run } from "./release-cli-utils.mjs";

const TOOL = "release-sdk-product-dry-run.mjs";

export const SUPPORTED_SDK_PRODUCT_DRY_RUNS = new Set(["oliphaunt-js", "oliphaunt-react-native"]);

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function usage() {
  console.log(`usage: tools/release/release-sdk-product-dry-run.mjs --product PRODUCT [--allow-dirty]

Runs Bun-owned low-risk SDK product publish dry-run checks. Release-wide checks
and registry dependency checks are owned by release-publish.mjs before this
helper is invoked from the public publish dry-run command surface.
`);
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function requireFile(file, message) {
  try {
    if (statSync(file).isFile()) {
      return;
    }
  } catch {
    // handled below
  }
  fail(message);
}

function requireDirectory(file, message) {
  if (!isDirectory(file)) {
    fail(message);
  }
}

function sdkArtifactDir(product) {
  return path.join(ROOT, "target", "sdk-artifacts", product);
}

function requireStagedSdkArtifact(product, description, suffixes) {
  const directory = sdkArtifactDir(product);
  requireDirectory(
    directory,
    `${product} requires staged ${description} artifact(s) under target/sdk-artifacts/${product}; download the CI workflow SDK package artifacts before release validation or publishing`,
  );
  const matches = readdirSync(directory)
    .filter((name) => name !== "artifacts.txt" && suffixes.some((suffix) => name.endsWith(suffix)))
    .sort();
  if (matches.length === 0) {
    fail(
      `${product} requires staged ${description} artifact(s) under target/sdk-artifacts/${product}; download the CI workflow SDK package artifacts before release validation or publishing`,
    );
  }
  return matches;
}

function stagedJsrSourceDir(product) {
  const directory = path.join(sdkArtifactDir(product), "jsr-source");
  requireDirectory(
    directory,
    `${product} requires staged JSR source under target/sdk-artifacts/${product}/jsr-source; download the CI workflow SDK package artifacts before release validation or publishing`,
  );
  for (const name of ["jsr.json", "package.json", "src"]) {
    const candidate = path.join(directory, name);
    if (name === "src") {
      requireDirectory(candidate, `${product} staged JSR source is missing: ${name}`);
    } else {
      requireFile(candidate, `${product} staged JSR source is missing: ${name}`);
    }
  }
  return directory;
}

export function runSdkProductDryRun(product, { allowDirty = false } = {}) {
  if (!SUPPORTED_SDK_PRODUCT_DRY_RUNS.has(product)) {
    fail(`no Bun publish dry-run handler for ${product}`, 2);
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product]);
  if (product === "oliphaunt-react-native") {
    requireStagedSdkArtifact(product, "npm package", [".tgz"]);
    return;
  }
  if (product === "oliphaunt-js") {
    requireStagedSdkArtifact(product, "npm package", [".tgz"]);
    const command = ["pnpm", "exec", "jsr", "publish", "--dry-run"];
    if (allowDirty) {
      command.push("--allow-dirty");
    }
    run(TOOL, command, { cwd: stagedJsrSourceDir(product) });
  }
}

function parseArgs(argv) {
  const args = {
    allowDirty: false,
    product: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value", 2);
      }
      args.product = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--product=")) {
      args.product = arg.slice("--product=".length);
    } else if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (!args.product) {
    fail("--product is required", 2);
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  runSdkProductDryRun(args.product, { allowDirty: args.allowDirty });
}
