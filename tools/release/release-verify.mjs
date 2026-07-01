#!/usr/bin/env bun
import { fail, run } from "./release-cli-utils.mjs";

const TOOL = "release-verify.mjs";

function consumerShapeScopeArgs(args) {
  const scoped = [];
  for (let index = 0; index < args.length;) {
    const value = args[index];
    if (value === "--products-json") {
      if (index + 1 >= args.length) {
        fail(TOOL, "--products-json requires a value", 2);
      }
      scoped.push(value, args[index + 1]);
      index += 2;
      continue;
    }
    if (value.startsWith("--products-json=")) {
      scoped.push(value);
    }
    index += 1;
  }
  return scoped;
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("usage: tools/release/release-verify.mjs [--products-json JSON] [--head-ref REF]");
    process.exit(0);
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_versions.mjs", ...argv, "--check-registries"], { failExitCode: 2 });
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-consumer-shape.mjs", "--require-ready", ...consumerShapeScopeArgs(argv)], { failExitCode: 2 });
  run(TOOL, ["tools/dev/bun.sh", "tools/release/verify_github_release_attestations.mjs", ...argv], { failExitCode: 2 });
}

main(Bun.argv.slice(2));
