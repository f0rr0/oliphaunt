#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);

function fail(message) {
  console.error(`list-helper-reference-candidates.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`usage: tools/policy/list-helper-reference-candidates.mjs [--max-refs N] [--json]

Lists tracked shell, Python, and JavaScript helper entrypoints with few textual
references. The output is advisory: each candidate still needs manual review
before removal because some entrypoints are intentionally invoked by humans or
external tools.`);
}

let maxRefs = 1;
let json = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--max-refs") {
    const raw = args[index + 1];
    if (!raw || raw.startsWith("--")) {
      fail("--max-refs requires a numeric value");
    }
    maxRefs = Number(raw);
    if (!Number.isInteger(maxRefs) || maxRefs < 0) {
      fail("--max-refs must be a non-negative integer");
    }
    index += 1;
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  return result;
}

function gitOutput(gitArgs) {
  const result = run("git", gitArgs);
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${gitArgs.join(" ")} failed`);
  }
  return result.stdout;
}

const root = gitOutput(["rev-parse", "--show-toplevel"]).trim();
if (!root) {
  fail("must run inside the Oliphaunt git checkout");
}
process.chdir(root);

function trackedHelpers() {
  return gitOutput([
    "ls-files",
    "-z",
    "--",
    "*.sh",
    "*.mjs",
    "*.py",
  ])
    .split("\0")
    .filter(Boolean)
    .filter((path) => isFile(path))
    .filter((path) => !path.includes("/node_modules/"))
    .filter((path) => !path.startsWith("target/"))
    .sort();
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function grepFixed(pattern) {
  const result = run("git", ["grep", "-n", "-F", "--", pattern, "--", "."], {
    cwd: root,
  });
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git grep failed for ${pattern}`);
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

function externalReferenceCount(path, pattern) {
  return grepFixed(pattern).filter((line) => !line.startsWith(`${path}:`)).length;
}

const candidates = trackedHelpers()
  .map((path) => {
    const pathReferences = externalReferenceCount(path, path);
    const basenameReferences = externalReferenceCount(path, basename(path));
    return {
      path,
      basename: basename(path),
      pathReferences,
      basenameReferences,
    };
  })
  .filter((candidate) => candidate.pathReferences <= maxRefs && candidate.basenameReferences <= maxRefs)
  .sort((left, right) => {
    const byPathReferences = left.pathReferences - right.pathReferences;
    if (byPathReferences !== 0) {
      return byPathReferences;
    }
    const byBasenameReferences = left.basenameReferences - right.basenameReferences;
    if (byBasenameReferences !== 0) {
      return byBasenameReferences;
    }
    return left.path.localeCompare(right.path);
  });

if (json) {
  console.log(JSON.stringify({ maxRefs, candidates }, null, 2));
} else {
  console.log(`Low-reference helper candidates (maxRefs=${maxRefs}):`);
  if (candidates.length === 0) {
    console.log("  none");
  }
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.path} pathRefs=${candidate.pathReferences} basenameRefs=${candidate.basenameReferences}`,
    );
  }
}
