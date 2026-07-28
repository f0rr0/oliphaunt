#!/usr/bin/env bun
import { statSync } from "node:fs";
import { basename, extname } from "node:path";

import { captureCommandBytes } from "../dev/capture-command-output.mjs";

const args = process.argv.slice(2);
const TEXT_SEARCH_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cjs",
  ".cpp",
  ".gradle",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".kt",
  ".lock",
  ".m",
  ".md",
  ".mdx",
  ".mjs",
  ".mm",
  ".podspec",
  ".ps1",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

function fail(message) {
  console.error(`list-source-reference-candidates.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`usage: tools/policy/list-source-reference-candidates.mjs [--max-refs N] [--json] [--surface all|typescript|rust]

Lists tracked SDK/runtime source modules with few textual references. The output
is advisory: each candidate still needs manual review because public entrypoints,
package exports, generated code, and platform bridges can be intentionally
referenced indirectly.`);
}

let maxRefs = 0;
let json = false;
let surface = "all";
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
  } else if (arg === "--surface") {
    surface = args[index + 1] ?? "";
    if (!["all", "typescript", "rust"].includes(surface)) {
      fail("--surface must be one of: all, typescript, rust");
    }
    index += 1;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

function run(command, commandArgs) {
  const result = captureCommandBytes(command, commandArgs, {
    label: `${command} ${commandArgs.join(" ")}`,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(result.stderr.toString("utf8").trim() || `${command} ${commandArgs.join(" ")} failed`);
  }
  return result.stdout;
}

const root = run("git", ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
if (!root) {
  fail("must run inside the Oliphaunt git checkout");
}
process.chdir(root);

function gitLsFiles() {
  return run("git", ["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function fileText(path) {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    fail(`failed to read ${path}: ${error.message}`);
  }
}

function isTypeScriptSource(path) {
  if (!/\.(ts|tsx|js|mjs|cjs)$/u.test(path)) {
    return false;
  }
  if (
    path.includes("/__tests__/") ||
    path.includes("/generated/") ||
    path.endsWith(".d.ts") ||
    path.endsWith(".config.ts") ||
    path.endsWith(".config.js") ||
    path.endsWith(".config.mjs")
  ) {
    return false;
  }
  return (
    path.startsWith("src/sdks/js/src/") ||
    path.startsWith("src/sdks/react-native/src/") ||
    path.startsWith("src/shared/js-core/src/")
  );
}

function isRustSource(path) {
  if (!path.endsWith(".rs")) {
    return false;
  }
  if (
    path.includes("/tests/") ||
    path.includes("/generated/") ||
    path.endsWith("/lib.rs") ||
    path.endsWith("/mod.rs")
  ) {
    return false;
  }
  return (
    path.startsWith("src/sdks/rust/src/") ||
    path.startsWith("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/")
  );
}

function sourceKind(path) {
  if (isTypeScriptSource(path)) {
    return "typescript";
  }
  if (isRustSource(path)) {
    return "rust";
  }
  return null;
}

function isTextSearchPath(path) {
  return TEXT_SEARCH_EXTENSIONS.has(extname(path).toLowerCase());
}

function countOccurrences(text, pattern) {
  if (!pattern) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = text.indexOf(pattern, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + pattern.length;
  }
}

function referencePatterns(path) {
  const name = basename(path);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const withoutExtension = path.slice(0, -extname(path).length);
  const patterns = new Set([path, withoutExtension, name, stem]);
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    patterns.add(`${stem}.js`);
  }
  if (path.endsWith(".rs")) {
    patterns.add(stem.replaceAll("-", "_"));
  }
  return [...patterns].filter((pattern) => pattern.length > 1);
}

const trackedFiles = gitLsFiles().filter((path) => isFile(path));
const corpus = await Promise.all(
  trackedFiles
    .filter((path) => isTextSearchPath(path))
    .map(async (path) => ({
      path,
      text: await fileText(path),
    })),
);
const sourceFiles = trackedFiles
  .map((path) => ({ path, kind: sourceKind(path) }))
  .filter((entry) => entry.kind !== null && (surface === "all" || entry.kind === surface));

const candidates = [];
for (const sourceFile of sourceFiles) {
  const patternCounts = referencePatterns(sourceFile.path).map((pattern) => {
    let references = 0;
    for (const file of corpus) {
      if (file.path === sourceFile.path) {
        continue;
      }
      references += countOccurrences(file.text, pattern);
    }
    return { pattern, references };
  });
  const strongestReferenceCount = Math.max(...patternCounts.map((entry) => entry.references));
  if (strongestReferenceCount <= maxRefs) {
    candidates.push({
      path: sourceFile.path,
      kind: sourceFile.kind,
      strongestReferenceCount,
      patternCounts,
    });
  }
}

candidates.sort((left, right) => {
  const byReferences = left.strongestReferenceCount - right.strongestReferenceCount;
  if (byReferences !== 0) {
    return byReferences;
  }
  const byKind = left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
  if (byKind !== 0) {
    return byKind;
  }
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
});

if (json) {
  console.log(JSON.stringify({ maxRefs, surface, candidates }, null, 2));
} else {
  console.log(`Low-reference source candidates (surface=${surface}, maxRefs=${maxRefs}):`);
  if (candidates.length === 0) {
    console.log("  none");
  }
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.path} kind=${candidate.kind} refs=${candidate.strongestReferenceCount}`,
    );
  }
}
