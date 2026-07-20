#!/usr/bin/env bun
import { fail, run } from "./release-cli-utils.mjs";

const TOOL = "release-verify.mjs";

function removeValueFlag(argv, flag) {
  const output = [];
  let value = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) {
      if (index + 1 >= argv.length) fail(TOOL, `${flag} requires a value`);
      value = argv[index + 1];
      index += 1;
    } else if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      output.push(arg);
    }
  }
  return { argv: output, value };
}

function flagValue(argv, flag) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) return argv[index + 1] ?? "";
    if (argv[index].startsWith(`${flag}=`)) return argv[index].slice(flag.length + 1);
  }
  return "";
}

function main(rawArgv) {
  const githubReceipt = removeValueFlag(rawArgv, "--github-release-receipt");
  const receipts = removeValueFlag(githubReceipt.argv, "--registry-receipts");
  const lock = removeValueFlag(receipts.argv, "--publication-lock");
  const argv = lock.argv;
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("usage: tools/release/release-verify.mjs [--products-json JSON] [--head-ref REF] [--publication-lock FILE --registry-receipts FILE --github-release-receipt FILE]");
    process.exit(0);
  }
  if (new Set([Boolean(lock.value), Boolean(receipts.value), Boolean(githubReceipt.value)]).size !== 1) {
    fail(TOOL, "--publication-lock, --registry-receipts, and --github-release-receipt must be supplied together");
  }
  if (receipts.value) {
    const productsJson = flagValue(argv, "--products-json");
    if (!productsJson) fail(TOOL, "--products-json is required with immutable registry receipt evidence");
    run(TOOL, [
      process.execPath,
      "tools/release/registry-integrity.mjs",
      "--lock",
      lock.value,
      "--products-json",
      productsJson,
      "--verify-receipts",
      receipts.value,
    ], { failExitCode: 2 });
    run(TOOL, [process.execPath, "tools/release/check_release_versions.mjs", ...argv], { failExitCode: 2 });
    run(TOOL, [
      process.execPath,
      "tools/release/verify_github_release_attestations.mjs",
      "finalize",
      "--publication-lock",
      lock.value,
      ...argv,
      "--receipt",
      githubReceipt.value,
    ], { failExitCode: 2 });
  } else {
    run(TOOL, [process.execPath, "tools/release/check_release_versions.mjs", ...argv, "--check-registries"], { failExitCode: 2 });
    run(TOOL, [process.execPath, "tools/release/verify_github_release_attestations.mjs", ...argv], { failExitCode: 2 });
  }
}

main(Bun.argv.slice(2));
