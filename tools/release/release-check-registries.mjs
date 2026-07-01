#!/usr/bin/env bun
import { fail, run } from "./release-cli-utils.mjs";

const TOOL = "release-check-registries.mjs";

function productsJsonArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--products-json") {
      if (index + 1 >= args.length) {
        fail(TOOL, "--products-json requires a value", 2);
      }
      return args[index + 1];
    }
    if (value.startsWith("--products-json=")) {
      return value.slice("--products-json=".length);
    }
  }
  return null;
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("usage: tools/release/release-check-registries.mjs [--products-json JSON] [--head-ref REF] [--require-identities]");
    process.exit(0);
  }

  const requireIdentities = argv.includes("--require-identities");
  const passthrough = argv.filter((value) => value !== "--require-identities");
  if (passthrough.length === 0) {
    console.log("No release products selected; registry publication checks skipped.");
    return;
  }

  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_versions.mjs", ...passthrough, "--check-registries"], { failExitCode: 2 });
  if (!requireIdentities) {
    return;
  }

  const productsJson = productsJsonArg(passthrough);
  if (productsJson === null) {
    fail(TOOL, "check-registries --require-identities requires --products-json", 2);
  }
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/check_registry_publication.mjs",
    "--products-json",
    productsJson,
    "--require-identities",
  ], { failExitCode: 2 });
}

main(Bun.argv.slice(2));
