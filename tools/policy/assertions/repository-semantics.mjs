#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { loadGraph } from "../../release/release-graph.mjs";

const TOOL = "repository-semantics.mjs";
const ROOT = path.resolve(import.meta.dir, "../../..");
const MODES = new Set(["tooling", "structure", "all"]);

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function nulFields(value) {
  return value.split("\0").filter(Boolean);
}

function trackedFiles() {
  return nulFields(git(["ls-files", "-z"]));
}

function presentRepositoryFiles() {
  return nulFields(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .filter((file) => existsSync(path.join(ROOT, file)));
}

function trackedEntries() {
  return nulFields(git(["ls-files", "-s", "-z"])).map((record) => {
    const match = /^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/u.exec(record);
    assert(match !== null, `could not parse git index record ${JSON.stringify(record)}`);
    return { mode: match[1], file: match[2] };
  });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
}

function readToml(file) {
  try {
    return Bun.TOML.parse(readFileSync(path.join(ROOT, file), "utf8"));
  } catch (error) {
    fail(`${file} is not valid TOML: ${error.message}`);
  }
}

function readYaml(file) {
  try {
    return Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf8"));
  } catch (error) {
    fail(`${file} is not valid YAML: ${error.message}`);
  }
}

function requireFiles(files) {
  const missing = files.filter((file) => !existsSync(path.join(ROOT, file)));
  assert(missing.length === 0, `missing required files: ${missing.join(", ")}`);
}

function requireDirectories(directories) {
  const missing = directories.filter((directory) => {
    const absolute = path.join(ROOT, directory);
    return !existsSync(absolute) || !statSync(absolute).isDirectory();
  });
  assert(missing.length === 0, `missing repository domains: ${missing.join(", ")}`);
}

function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function stableVersion(value, label) {
  assert(typeof value === "string" && /^\d+[.]\d+[.]\d+$/u.test(value), `${label} must pin x.y.z, got ${JSON.stringify(value)}`);
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function versionSatisfiesNodeBand(version, range) {
  const [major, minor] = stableVersion(version, ".prototools node");
  const match = /^>=([0-9]+)[.]([0-9]+) <([0-9]+)$/u.exec(range);
  if (match === null) {
    return false;
  }
  const lowerMajor = Number.parseInt(match[1], 10);
  const lowerMinor = Number.parseInt(match[2], 10);
  const upperMajor = Number.parseInt(match[3], 10);
  return (major > lowerMajor || (major === lowerMajor && minor >= lowerMinor)) && major < upperMajor;
}

function assertCheckoutEol(files) {
  const output = execFileSync("git", ["check-attr", "-z", "--stdin", "text", "eol"], {
    cwd: ROOT,
    encoding: "utf8",
    input: `${files.join("\0")}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  assert(fields.length === files.length * 6, "git check-attr returned an incomplete tracked-file result");
  const failures = [];
  for (let index = 0; index < fields.length; index += 6) {
    const [textFile, textAttribute, textValue, eolFile, eolAttribute, eolValue] =
      fields.slice(index, index + 6);
    if (
      textFile !== eolFile
      || textAttribute !== "text"
      || (textValue !== "auto" && textValue !== "set")
      || eolAttribute !== "eol"
      || eolValue !== "lf"
    ) {
      failures.push(textFile);
    }
  }
  assert(
    failures.length === 0,
    `tracked files must use text=auto (or explicit text) with eol=lf: ${failures.join(", ")}`,
  );
}

function checkTooling() {
  requireFiles([
    ".prototools",
    ".moon/toolchains.yml",
    ".moon/workspace.yml",
    ".github/actions/setup-moon/action.yml",
    ".github/actions/setup-node-runtime/action.yml",
    ".github/actions/setup-node-pnpm/action.yml",
    ".github/actions/setup-npm-publisher/action.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "biome.json",
    "docs/maintainers/tooling.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tools/dev/bun.sh",
    "tools/dev/deno.sh",
    "tools/policy/helper-entrypoints.allowlist",
    "tools/policy/python-entrypoints.allowlist",
    "tools/policy/rust-helper-crates.allowlist",
  ]);

  const pins = object(readToml(".prototools"), ".prototools");
  for (const tool of ["moon", "node", "pnpm", "bun", "deno"]) {
    stableVersion(pins[tool], `.prototools ${tool}`);
  }

  const packageJson = object(readJson("package.json"), "package.json");
  assert(packageJson.private === true, "root package.json must remain private");
  assert(
    packageJson.packageManager === `pnpm@${pins.pnpm}`,
    "package.json packageManager must match the .prototools pnpm pin",
  );
  assert(packageJson.engines?.pnpm === pins.pnpm, "package.json engines.pnpm must match .prototools");
  assert(
    versionSatisfiesNodeBand(pins.node, packageJson.engines?.node),
    "the pinned Node version must satisfy package.json engines.node",
  );
  assert(Object.keys(packageJson.scripts ?? {}).length === 0, "root package.json scripts are not an orchestration API; use Moon tasks");

  const toolchains = object(readYaml(".moon/toolchains.yml"), ".moon/toolchains.yml");
  assert(toolchains.javascript?.packageManager === "pnpm", "Moon must use pnpm for JavaScript projects");
  assert(toolchains.javascript?.installDependencies === false, "Moon must not perform implicit dependency installs");
  assert(toolchains.node?.versionFromPrototools === true, "Moon Node must use .prototools");
  assert(toolchains.pnpm?.versionFromPrototools === true, "Moon pnpm must use .prototools");

  const workspace = object(readYaml(".moon/workspace.yml"), ".moon/workspace.yml");
  assert(workspace.vcs?.defaultBranch === "main", "Moon defaultBranch must be main");
  assert(workspace.telemetry === false, "Moon telemetry must remain disabled");
  assert(Array.isArray(workspace.projects?.globs) && workspace.projects.globs.length > 0, "Moon must discover projects from globs");
  assert(workspace.projects?.sources?.["ci-workflows"] === ".github", "Moon must model .github as the ci-workflows project");

  const pnpm = object(readYaml("pnpm-workspace.yaml"), "pnpm-workspace.yaml");
  assert(Array.isArray(pnpm.packages) && pnpm.packages.length > 0, "pnpm workspace must declare package globs");
  assert(Number.isInteger(pnpm.minimumReleaseAge) && pnpm.minimumReleaseAge >= 1440, "pnpm minimumReleaseAge must be at least one day");
  assert(pnpm.nodeLinker === "isolated", "pnpm must isolate workspace dependency trees to prevent duplicate native-module contexts");
  for (const dependency of ["@vitest/coverage-v8", "tsx", "typedoc", "typescript", "vitest"]) {
    assert(typeof pnpm.catalog?.[dependency] === "string", `pnpm catalog must centrally version ${dependency}`);
  }
  for (const [dependency, allowed] of Object.entries(object(pnpm.allowBuilds, "pnpm-workspace.yaml allowBuilds"))) {
    assert(typeof allowed === "boolean", `pnpm allowBuilds.${dependency} must explicitly be true or false`);
  }

  for (const file of trackedFiles().filter((candidate) => candidate.endsWith("moon.yml"))) {
    object(readYaml(file), file);
  }
  assertCheckoutEol(trackedFiles());

  const unsafeRootFallback = /git\s+rev-parse\s+--show-toplevel[^\n]*(?:\|\||or)\s+pwd/u;
  const unsafe = [];
  for (const file of trackedFiles().filter((candidate) => /(?:[.]sh|[.]mjs|[.]js|[.]py)$/u.test(candidate))) {
    const absolute = path.join(ROOT, file);
    if (existsSync(absolute) && lstatSync(absolute).isFile() && unsafeRootFallback.test(readFileSync(absolute, "utf8"))) {
      unsafe.push(file);
    }
  }
  assert(unsafe.length === 0, `repo entrypoints must fail closed outside a checkout: ${unsafe.join(", ")}`);
}

function isGeneratedPath(file) {
  const parts = file.split("/");
  const forbiddenParts = new Set([
    ".build",
    ".cxx",
    ".expo",
    ".gradle",
    ".kotlin",
    ".next",
    ".source",
    "DerivedData",
    "Pods",
    "__pycache__",
    "node_modules",
    "target",
  ]);
  if (parts.some((part) => forbiddenParts.has(part)) || file.endsWith(".pyc") || file.endsWith("/.DS_Store")) {
    return true;
  }
  return (
    /^src\/docs\/(?:build|out|[.]docusaurus)\//u.test(file) ||
    /^src\/sdks\/(?:js|react-native)\/lib\//u.test(file) ||
    /^src\/sdks\/react-native\/(?:android|ios)\/(?:build|Pods|DerivedData)\//u.test(file)
  );
}

function executableOwned(file) {
  return (
    /^tools\//u.test(file) ||
    /^\.github\/(?:scripts|actions)\//u.test(file) ||
    /^examples\/(?:[^/]+\/)*tools\//u.test(file) ||
    /^src\/(?:[^/]+\/)*?(?:bin|tools)\//u.test(file) ||
    /^src\/(?:[^/]+\/)*assets\/build\//u.test(file) ||
    file.endsWith("/gradlew")
  );
}

function assertSymlinksStayInside(entries) {
  const escaping = [];
  for (const { mode, file } of entries.filter((entry) => entry.mode === "120000")) {
    const absolute = path.join(ROOT, file);
    const resolved = path.resolve(path.dirname(absolute), readlinkSync(absolute));
    const relative = path.relative(ROOT, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      escaping.push(file);
    }
  }
  assert(escaping.length === 0, `tracked symlinks must stay inside the checkout: ${escaping.join(", ")}`);
}

function checkReleaseProductLayout(files) {
  const config = object(readJson("release-please-config.json"), "release-please-config.json");
  const packages = object(config.packages, "release-please-config.json packages");
  const manifest = object(readJson(".release-please-manifest.json"), ".release-please-manifest.json");
  const packagePaths = Object.keys(packages).sort();
  const manifestPaths = Object.keys(manifest).sort();
  assert(JSON.stringify(packagePaths) === JSON.stringify(manifestPaths), "release-please package paths and manifest paths must match exactly");

  const releaseTomlPaths = files
    .filter((file) => file.startsWith("src/") && file.endsWith("/release.toml"))
    .map((file) => path.dirname(file))
    .sort();
  assert(JSON.stringify(packagePaths) === JSON.stringify(releaseTomlPaths), "every and only release products must have release.toml and release-please entries");

  const components = new Set();
  for (const packagePath of packagePaths) {
    const packageConfig = object(packages[packagePath], `release-please ${packagePath}`);
    const component = packageConfig.component;
    assert(typeof component === "string" && component.length > 0, `${packagePath} must declare a release component`);
    assert(!components.has(component), `duplicate release component ${component}`);
    components.add(component);
    const metadata = object(readToml(`${packagePath}/release.toml`), `${packagePath}/release.toml`);
    assert(metadata.id === component, `${packagePath}/release.toml id must equal release-please component ${component}`);
    assert(existsSync(path.join(ROOT, packagePath, "CHANGELOG.md")), `${packagePath} must own CHANGELOG.md`);
    let projectPath = packagePath;
    while (projectPath.startsWith("src/") && !existsSync(path.join(ROOT, projectPath, "moon.yml"))) {
      projectPath = path.dirname(projectPath);
    }
    assert(
      projectPath.startsWith("src/") && existsSync(path.join(ROOT, projectPath, "moon.yml")),
      `${packagePath} must belong to a Moon project`,
    );
    stableVersion(manifest[packagePath], `.release-please-manifest.json ${packagePath}`);
  }

  const graph = loadGraph(TOOL);
  const graphProducts = Object.keys(object(graph.products, "release graph products")).sort();
  assert(JSON.stringify(graphProducts) === JSON.stringify([...components].sort()), "release graph products must equal release-please components");
}

function checkStructure() {
  requireDirectories([".github", ".moon", "docs", "src", "tools"]);
  requireFiles([
    ".release-please-manifest.json",
    "Cargo.lock",
    "Cargo.toml",
    "README.md",
    "docs/internal/README.md",
    "docs/maintainers/README.md",
    "release-please-config.json",
    "src/extensions/evidence/matrix.toml",
    "src/extensions/generated/docs/extensions.json",
    "src/extensions/generated/sdk/rust.json",
    "tools/release/publication-catalog.schema.json",
    "tools/release/release-graph.mjs",
  ]);

  const files = trackedFiles();
  const ignoredTracked = nulFields(git(["ls-files", "-ci", "-z", "--exclude-standard"]));
  assert(ignoredTracked.length === 0, `ignored generated files must not be tracked: ${ignoredTracked.join(", ")}`);

  const rootAliases = files.filter((file) => /^(?:assets\/wasix-build|crates|liboliphaunt|sdks)\//u.test(file));
  assert(rootAliases.length === 0, `product source belongs under src/: ${rootAliases.join(", ")}`);
  const generated = files.filter(isGeneratedPath);
  assert(generated.length === 0, `generated dependency/build output must not be tracked: ${generated.join(", ")}`);

  const entries = trackedEntries();
  const misplacedExecutables = entries
    .filter((entry) => entry.mode === "100755" && !executableOwned(entry.file))
    .map((entry) => entry.file);
  assert(misplacedExecutables.length === 0, `executables must live in an owning tools/bin domain: ${misplacedExecutables.join(", ")}`);
  assertSymlinksStayInside(entries);
  // Release metadata is deliberately checked before changes are staged. Use the
  // intended worktree here so removed products do not linger through the index
  // and newly added products cannot remain invisible to the local gate.
  checkReleaseProductLayout(presentRepositoryFiles());
}

function selfTest() {
  assert(isGeneratedPath("src/sdks/swift/.build/a") === true, "self-test: Swift build path");
  assert(isGeneratedPath("src/extensions/external/vector/targets/artifacts.toml") === false, "self-test: target metadata");
  assert(isGeneratedPath("src/runtimes/liboliphaunt/wasix/assets/build/script.sh") === false, "self-test: source build recipe");
  assert(versionSatisfiesNodeBand("22.22.3", ">=22.13 <25") === true, "self-test: Node range acceptance");
  assert(versionSatisfiesNodeBand("25.0.0", ">=22.13 <25") === false, "self-test: Node range rejection");
  console.log(`${TOOL}: self-test passed`);
}

function main() {
  const [mode = "all", ...rest] = Bun.argv.slice(2);
  if (mode === "--self-test") {
    assert(rest.length === 0, "--self-test does not accept arguments");
    selfTest();
    return;
  }
  assert(MODES.has(mode), `usage: ${TOOL} [tooling|structure|all|--self-test]`);
  assert(rest.length === 0, `unexpected arguments: ${rest.join(" ")}`);
  realpathSync(ROOT);
  if (mode === "tooling" || mode === "all") {
    checkTooling();
  }
  if (mode === "structure" || mode === "all") {
    checkStructure();
  }
  console.log(`${TOOL}: ${mode} checks passed`);
}

try {
  main();
} catch (error) {
  console.error(error.message ?? String(error));
  process.exit(1);
}
