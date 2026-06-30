#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const ALLOWLIST = "tools/policy/helper-entrypoints.allowlist";

function fail(message) {
  console.error(`list-helper-reference-candidates.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`usage: tools/policy/list-helper-reference-candidates.mjs [--max-refs N] [--active-only] [--include-allowlisted] [--json]

Lists tracked shell and Python helpers plus entrypoint-shaped JavaScript helpers
with few textual references. JavaScript modules must have a shebang or explicit
Bun.argv/process.argv handling to be treated as entrypoints, so shared modules
and config files do not drown out real cleanup candidates. The output is
advisory: each candidate still needs manual review before removal because some
entrypoints are intentionally invoked by humans or external tools.

Use --active-only to ignore Markdown/docs references and focus on code, CI, and
tooling callers. By default, entries in ${ALLOWLIST} are hidden; pass
--include-allowlisted when auditing intentional human or readiness entrypoints.`);
}

let maxRefs = 1;
let json = false;
let activeOnly = false;
let includeAllowlisted = false;
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
  } else if (arg === "--active-only") {
    activeOnly = true;
  } else if (arg === "--include-allowlisted") {
    includeAllowlisted = true;
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
    .filter((path) => helperLooksLikeEntrypoint(path))
    .filter((path) => !path.includes("/node_modules/"))
    .filter((path) => !path.startsWith("target/"))
    .sort();
}

function helperLooksLikeEntrypoint(path) {
  if (!path.endsWith(".mjs")) {
    return true;
  }
  const text = readFileSync(path, "utf8");
  return text.startsWith("#!") || /\b(?:Bun|process)\.argv\b/u.test(text);
}

function parseAllowlist() {
  const entries = new Map();
  const text = readFileSync(ALLOWLIST, "utf8");
  const tracked = new Set(trackedHelpers());
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== 4) {
      fail(`${ALLOWLIST}:${index + 1} must use path<TAB>domain<TAB>decision<TAB>rationale`);
    }
    const [path, domain, decision, rationale] = fields;
    if (path.startsWith("/") || path.includes("..") || !/\.(?:mjs|py|sh)$/u.test(path)) {
      fail(`${ALLOWLIST}:${index + 1} is not a repo-relative helper path: ${path}`);
    }
    if (!tracked.has(path)) {
      fail(`${ALLOWLIST}:${index + 1} references an untracked helper: ${path}`);
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(domain)) {
      fail(`${ALLOWLIST}:${index + 1} has invalid domain ${JSON.stringify(domain)}`);
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(decision)) {
      fail(`${ALLOWLIST}:${index + 1} has invalid decision ${JSON.stringify(decision)}`);
    }
    if (rationale.length < 24) {
      fail(`${ALLOWLIST}:${index + 1} needs a concrete rationale`);
    }
    if (entries.has(path)) {
      fail(`${ALLOWLIST}:${index + 1} duplicates ${path}`);
    }
    entries.set(path, { path, domain, decision, rationale });
  }
  const paths = [...entries.keys()];
  const sorted = [...paths].sort();
  if (paths.join("\n") !== sorted.join("\n")) {
    fail(`${ALLOWLIST} must be sorted lexicographically`);
  }
  return entries;
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

function grepLinePath(line) {
  const separator = line.indexOf(":");
  return separator === -1 ? line : line.slice(0, separator);
}

function isActiveReference(line) {
  if (!activeOnly) {
    return true;
  }
  const file = grepLinePath(line);
  return !file.endsWith(".md") && !file.startsWith("docs/");
}

function externalReferenceCount(path, pattern) {
  return grepFixed(pattern).filter((line) => !line.startsWith(`${path}:`) && isActiveReference(line)).length;
}

function referenceSuffixes(path) {
  const parts = path.split("/");
  if (parts.length <= 2) {
    return [];
  }
  const suffixes = [];
  for (let index = 1; index < parts.length - 1; index += 1) {
    suffixes.push(parts.slice(index).join("/"));
  }
  return suffixes;
}

function strongestSuffixReference(path) {
  let best = { pattern: null, references: 0 };
  for (const pattern of referenceSuffixes(path)) {
    const references = externalReferenceCount(path, pattern);
    if (references > best.references) {
      best = { pattern, references };
    }
  }
  return best;
}

const allowlisted = parseAllowlist();
const candidates = trackedHelpers()
  .map((path) => {
    const pathReferences = externalReferenceCount(path, path);
    const basenameReferences = externalReferenceCount(path, basename(path));
    const suffixReference = strongestSuffixReference(path);
    return {
      path,
      basename: basename(path),
      allowlisted: allowlisted.has(path),
      pathReferences,
      basenameReferences,
      suffixPattern: suffixReference.pattern,
      suffixReferences: suffixReference.references,
    };
  })
  .filter(
    (candidate) =>
      (includeAllowlisted || !candidate.allowlisted) &&
      candidate.pathReferences <= maxRefs &&
      candidate.basenameReferences <= maxRefs &&
      candidate.suffixReferences <= maxRefs,
  )
  .sort((left, right) => {
    const byPathReferences = left.pathReferences - right.pathReferences;
    if (byPathReferences !== 0) {
      return byPathReferences;
    }
    const bySuffixReferences = left.suffixReferences - right.suffixReferences;
    if (bySuffixReferences !== 0) {
      return bySuffixReferences;
    }
    const byBasenameReferences = left.basenameReferences - right.basenameReferences;
    if (byBasenameReferences !== 0) {
      return byBasenameReferences;
    }
    return left.path.localeCompare(right.path);
  });

if (json) {
  console.log(JSON.stringify({ maxRefs, activeOnly, includeAllowlisted, candidates }, null, 2));
} else {
  console.log(
    `Low-reference helper candidates (maxRefs=${maxRefs}, activeOnly=${activeOnly}, includeAllowlisted=${includeAllowlisted}):`,
  );
  if (candidates.length === 0) {
    console.log("  none");
  }
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.path} pathRefs=${candidate.pathReferences} suffixRefs=${candidate.suffixReferences} basenameRefs=${candidate.basenameReferences} allowlisted=${candidate.allowlisted}`,
    );
  }
}
