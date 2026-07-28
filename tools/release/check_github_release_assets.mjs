#!/usr/bin/env bun
// Verify product-scoped GitHub release assets without requiring attestations.

import { currentVersion } from "./product-version.mjs";
import {
  expectedAssets,
  verifyReleaseAssets,
} from "./verify_github_release_attestations.mjs";

function fail(message) {
  console.error(`check_github_release_assets.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    asset: [],
    defaultAssets: false,
    product: undefined,
    version: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--asset") {
      const asset = argv[++index];
      if (!asset) {
        fail("--asset requires a value");
      }
      args.asset.push(asset);
    } else if (value.startsWith("--asset=")) {
      args.asset.push(value.slice("--asset=".length));
    } else if (value === "--default-assets") {
      args.defaultAssets = true;
    } else if (value === "--version") {
      args.version = argv[++index];
      if (!args.version) {
        fail("--version requires a value");
      }
    } else if (value.startsWith("--version=")) {
      args.version = value.slice("--version=".length);
    } else if (value === "--help" || value === "-h") {
      console.log("usage: tools/release/check_github_release_assets.mjs <product> [--version VERSION] [--default-assets] [--asset NAME...]");
      process.exit(0);
    } else if (value.startsWith("--")) {
      fail(`unknown argument ${value}`);
    } else if (args.product === undefined) {
      args.product = value;
    } else {
      fail(`unexpected positional argument ${value}`);
    }
  }
  if (args.product === undefined) {
    fail("product is required");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const version = args.version ?? await currentVersion(args.product);
  const assets = [...args.asset];
  if (args.defaultAssets) {
    assets.push(...await expectedAssets(args.product, version));
  }
  const uniqueAssets = [...new Set(assets)].sort();
  if (uniqueAssets.length === 0) {
    fail("pass --default-assets or at least one --asset");
  }
  await verifyReleaseAssets(args.product, version, uniqueAssets);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
