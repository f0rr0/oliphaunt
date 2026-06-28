#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

import { ROOT, run } from "./release-cli-utils.mjs";
import {
  SUPPORTED_BUN_PRODUCT_DRY_RUNS,
  runBunProductDryRun,
} from "./release-product-dry-run.mjs";

const TOOL = "release-publish.mjs";
const COMMANDS = new Set(["publish", "publish-dry-run"]);

function usage() {
  console.log(`usage: tools/release/release-publish.mjs <publish|publish-dry-run> [publish args]

Runs protected release publish and publish dry-run operations through the Bun
release command surface. The public no-product publish dry-run and product
dry-runs are handled in Bun, including the legacy --wasm shortcut for the WASIX
Rust SDK dry-run. Protected publish dispatch still delegates to release.py while
the protected implementation is ported.
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

const argv = Bun.argv.slice(2);
const command = argv[0];
const LEGACY_WASM_DRY_RUN_PRODUCT = "oliphaunt-wasix-rust";

if (command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

if (!COMMANDS.has(command)) {
  usage();
  fail(`expected publish or publish-dry-run, got ${command ?? "<missing>"}`);
}

function isNoProductPublishDryRun(command, args) {
  return command === "publish-dry-run" && noProductPublishDryRunPassthrough(args) !== null;
}

function selectsProducts(args) {
  return args.some((arg) => arg === "--products-json" || arg.startsWith("--products-json="));
}

function flagValue(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      if (index + 1 >= args.length) {
        fail(`${flag} requires a value`);
      }
      return args[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return null;
}

function noProductPublishDryRunPassthrough(args) {
  if (args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return args.filter((arg) => arg !== "--allow-dirty");
}

function legacyWasmPublishDryRunPlan(args) {
  if (!args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    product: LEGACY_WASM_DRY_RUN_PRODUCT,
  };
}

function jsonOutput(args) {
  const result = spawnSync("tools/dev/bun.sh", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error !== undefined) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function productPublishDryRunPlan(args) {
  const productsJson = flagValue(args, "--products-json");
  if (productsJson === null) {
    return null;
  }
  let requested;
  try {
    requested = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((item) => typeof item === "string")) {
    fail("--products-json must be a non-empty JSON string array");
  }
  const unsupportedRequested = requested.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedRequested.length > 0) {
    fail(`unsupported Bun product publish dry-run selection: ${unsupportedRequested.join(", ")}`);
  }
  const ordered = jsonOutput([
    "tools/release/release_graph_query.mjs",
    "release-order",
    "--products-json",
    JSON.stringify(requested),
  ]);
  if (!Array.isArray(ordered) || ordered.length === 0 || !ordered.every((item) => typeof item === "string")) {
    fail("release graph could not resolve the selected publish dry-run products");
  }
  const unsupportedOrdered = ordered.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedOrdered.length > 0) {
    fail(`release graph selected unsupported Bun product publish dry-run dependencies: ${unsupportedOrdered.join(", ")}`);
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    products: ordered,
  };
}

if (isNoProductPublishDryRun(command, argv.slice(1))) {
  const passthrough = noProductPublishDryRunPassthrough(argv.slice(1));
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  process.exit(0);
}

const productDryRunPlan = command === "publish-dry-run" ? productPublishDryRunPlan(argv.slice(1)) : null;
if (productDryRunPlan !== null) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...productDryRunPlan.passthrough]);
  for (const product of productDryRunPlan.products) {
    await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });
  }
  process.exit(0);
}

const legacyWasmDryRunPlan = command === "publish-dry-run" ? legacyWasmPublishDryRunPlan(argv.slice(1)) : null;
if (legacyWasmDryRunPlan !== null) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (legacyWasmDryRunPlan.passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...legacyWasmDryRunPlan.passthrough]);
  }
  await runBunProductDryRun(legacyWasmDryRunPlan.product, { allowDirty: legacyWasmDryRunPlan.allowDirty });
  process.exit(0);
}

if (command === "publish-dry-run") {
  fail("publish-dry-run is Bun-owned; unsupported arguments must fail before the protected release.py publish fallback");
}

const result = spawnSync("tools/release/release.py", argv, {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error !== undefined) {
  console.error(`${TOOL}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
