#!/usr/bin/env bun
import { fail, run } from "./release-cli-utils.mjs";

const TOOL = "release-verify.mjs";

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("usage: tools/release/release-verify.mjs [--products-json JSON] [--head-ref REF]");
    process.exit(0);
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_versions.mjs", ...argv, "--check-registries"], { failExitCode: 2 });
  run(TOOL, ["tools/dev/bun.sh", "tools/release/verify_github_release_attestations.mjs", ...argv], { failExitCode: 2 });
}

main(Bun.argv.slice(2));
