#!/usr/bin/env bun
import { currentProductVersion } from "./release-artifact-targets.mjs";

const TOOL = "product-version.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(2);
}

function usage() {
  fail("usage: tools/release/product-version.mjs version <product-id>");
}

function ensureSemver(product, version) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    fail(`${product} version is not semver-like: ${JSON.stringify(version)}`);
  }
  return version;
}

export async function currentVersion(product) {
  if (typeof product !== "string" || product.length === 0) {
    fail("product id must be a non-empty string");
  }
  return ensureSemver(product, await currentProductVersion(product, TOOL));
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "version") {
    usage();
  }
  console.log(await currentVersion(argv[1]));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
