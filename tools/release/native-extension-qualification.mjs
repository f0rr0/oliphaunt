#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = "native-extension-qualification.mjs";
const DEFAULT_ROOT = path.resolve(import.meta.dir, "../..");
const UPGRADE_SCHEMA = "oliphaunt-extension-upgrade-qualification-v1";
const UPSTREAM_SCHEMA = "oliphaunt-extension-upstream-tests-v1";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_NAME = /^[a-z][a-z0-9_-]*$/u;
const SAFE_LOCALE = /^[A-Za-z0-9._@-]+$/u;
const SAFE_TARGET = /^[A-Za-z0-9._-]+$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function readRegularText(root, file) {
  const label = relative(root, file);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return readFileSync(file, "utf8");
}

function readToml(root, file) {
  try {
    return Bun.TOML.parse(readRegularText(root, file));
  } catch (cause) {
    fail(`${relative(root, file)} is not valid TOML: ${cause.message}`);
  }
}

function nonEmptyString(value, label, pattern = undefined) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    fail(`${label} has invalid value ${JSON.stringify(value)}`);
  }
  return value;
}

function exactStringList(value, label, { allowEmpty = false, pattern = undefined } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string list`);
  }
  const items = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, pattern));
  const canonical = [...new Set(items)].sort(compareText);
  if (JSON.stringify(items) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted and unique`);
  }
  return items;
}

function repositoryRelativeFile(root, extensionRoot, value, label) {
  const relativeFile = nonEmptyString(value, label);
  if (path.isAbsolute(relativeFile) || relativeFile.includes("\\")) {
    fail(`${label} must be a repository-relative POSIX path`);
  }
  const file = path.resolve(extensionRoot, relativeFile);
  const extensionPrefix = `${path.resolve(extensionRoot)}${path.sep}`;
  if (!file.startsWith(extensionPrefix)) {
    fail(`${label} must remain beneath ${relative(root, extensionRoot)}`);
  }
  readRegularText(root, file);
  return relative(root, file);
}

function safeRelativePath(value, label) {
  const relativePath = nonEmptyString(value, label);
  if (
    path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath === ".."
    || relativePath.startsWith("../")
  ) {
    fail(`${label} must be a normalized relative POSIX path`);
  }
  return relativePath;
}

function extensionIdentity(root, extensionRoot) {
  const file = path.join(extensionRoot, "source.toml");
  const source = readToml(root, file);
  const control = source["extension-control"];
  if (control === null || typeof control !== "object" || Array.isArray(control)) {
    fail(`${relative(root, file)} must define [extension-control]`);
  }
  return Object.freeze({
    sqlName: nonEmptyString(control["sql-name"], `${relative(root, file)} extension-control.sql-name`, SAFE_NAME),
    sourceName: nonEmptyString(source.name, `${relative(root, file)} name`, SAFE_NAME),
    sourceCommit: nonEmptyString(source.commit, `${relative(root, file)} commit`, FULL_GIT_SHA),
  });
}

function selectedNames(value) {
  const names = typeof value === "string" ? value.split(",").filter(Boolean) : value;
  if (!Array.isArray(names)) fail("selectedSqlNames must be a CSV string or string list");
  const selected = new Set();
  for (const [index, name] of names.entries()) {
    selected.add(nonEmptyString(name, `selectedSqlNames[${index}]`, SAFE_NAME));
  }
  return selected;
}

function upgradePlanRow(root, extensionRoot, identity, target) {
  const manifestFile = path.join(extensionRoot, "tests/upgrade/source.toml");
  if (!existsSync(manifestFile)) return undefined;
  const source = readToml(root, manifestFile);
  const qualification = source.qualification;
  if (qualification === null || typeof qualification !== "object" || Array.isArray(qualification)) {
    fail(`${relative(root, manifestFile)} must define [qualification]`);
  }
  if (qualification.schema !== UPGRADE_SCHEMA) {
    fail(`${relative(root, manifestFile)} qualification.schema must be ${UPGRADE_SCHEMA}`);
  }
  const control = source["extension-control"];
  if (control === null || typeof control !== "object" || Array.isArray(control)) {
    fail(`${relative(root, manifestFile)} must define [extension-control]`);
  }
  const sqlName = nonEmptyString(
    control["sql-name"],
    `${relative(root, manifestFile)} extension-control.sql-name`,
    SAFE_NAME,
  );
  if (sqlName !== identity.sqlName) {
    fail(`${relative(root, manifestFile)} extension-control.sql-name must equal ${identity.sqlName}`);
  }
  const targets = exactStringList(
    qualification.targets,
    `${relative(root, manifestFile)} qualification.targets`,
    { pattern: SAFE_TARGET },
  );
  if (!targets.includes(target)) return undefined;
  const fromVersion = nonEmptyString(
    control["default-version"],
    `${relative(root, manifestFile)} extension-control.default-version`,
    SAFE_VERSION,
  );
  const sourceControlPath = safeRelativePath(
    control["source-path"],
    `${relative(root, manifestFile)} extension-control.source-path`,
  );
  const sourceName = nonEmptyString(source.name, `${relative(root, manifestFile)} name`, SAFE_NAME);
  const sourceCommit = nonEmptyString(source.commit, `${relative(root, manifestFile)} commit`, FULL_GIT_SHA);
  const runner = repositoryRelativeFile(
    root,
    extensionRoot,
    qualification.runner,
    `${relative(root, manifestFile)} qualification.runner`,
  );
  return Object.freeze({
    kind: "upgrade",
    sqlName,
    target,
    runner,
    sourceName,
    sourceCommit,
    sourceControlPath,
    fromVersion,
    manifest: relative(root, manifestFile),
  });
}

function upstreamPlanRow(root, extensionRoot, identity, target) {
  const manifestFile = path.join(extensionRoot, "tests/upstream.toml");
  if (!existsSync(manifestFile)) return undefined;
  const manifest = readToml(root, manifestFile);
  if (manifest.schema !== UPSTREAM_SCHEMA) {
    fail(`${relative(root, manifestFile)} schema must be ${UPSTREAM_SCHEMA}`);
  }
  const status = nonEmptyString(manifest.status, `${relative(root, manifestFile)} status`);
  if (status !== "required") return undefined;
  const targets = exactStringList(manifest.targets, `${relative(root, manifestFile)} targets`, {
    pattern: SAFE_TARGET,
  });
  if (!targets.includes(target)) return undefined;
  const runner = nonEmptyString(manifest.runner, `${relative(root, manifestFile)} runner`, SAFE_NAME);
  if (runner !== "pgxs-installcheck") {
    fail(`${relative(root, manifestFile)} required runner ${runner} is unsupported`);
  }
  const includedSuites = exactStringList(
    manifest.included_suites,
    `${relative(root, manifestFile)} included_suites`,
    { pattern: SAFE_NAME },
  );
  const excludedSuites = exactStringList(
    manifest.excluded_suites,
    `${relative(root, manifestFile)} excluded_suites`,
    { allowEmpty: true, pattern: SAFE_NAME },
  );
  const suiteTargetPrefix = nonEmptyString(
    manifest.suite_target_prefix,
    `${relative(root, manifestFile)} suite_target_prefix`,
    SAFE_NAME,
  );
  const aggregateSuites = exactStringList(
    manifest.aggregate_suites,
    `${relative(root, manifestFile)} aggregate_suites`,
    { pattern: SAFE_NAME },
  );
  const declaredMakeSuites = [...aggregateSuites, ...excludedSuites];
  if (declaredMakeSuites.some((suite) => !suite.startsWith(suiteTargetPrefix))) {
    fail(`${relative(root, manifestFile)} aggregate/excluded suites must start with ${suiteTargetPrefix}`);
  }
  if (new Set(declaredMakeSuites).size !== declaredMakeSuites.length) {
    fail(`${relative(root, manifestFile)} aggregate_suites and excluded_suites must not overlap`);
  }
  const preloadLibraries = exactStringList(
    manifest.shared_preload_libraries ?? [],
    `${relative(root, manifestFile)} shared_preload_libraries`,
    { allowEmpty: true, pattern: SAFE_NAME },
  );
  const locale = nonEmptyString(manifest.locale, `${relative(root, manifestFile)} locale`, SAFE_LOCALE);
  return Object.freeze({
    kind: "upstream",
    sqlName: identity.sqlName,
    target,
    runner,
    sourceName: identity.sourceName,
    sourceCommit: identity.sourceCommit,
    locale,
    includedSuites: Object.freeze(includedSuites),
    suiteTargetPrefix,
    aggregateSuites: Object.freeze(aggregateSuites),
    excludedSuites: Object.freeze(excludedSuites),
    preloadLibraries: Object.freeze(preloadLibraries),
    manifest: relative(root, manifestFile),
  });
}

export function nativeExtensionQualificationPlan({
  root = DEFAULT_ROOT,
  target,
  selectedSqlNames,
} = {}) {
  const checkedTarget = nonEmptyString(target, "target", SAFE_TARGET);
  const selected = selectedNames(selectedSqlNames);
  if (selected.size === 0) return [];
  const externalRoot = path.join(root, "src/extensions/external");
  const rows = [];
  for (const entry of readdirSync(externalRoot, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => compareText(left.name, right.name))) {
    const extensionRoot = path.join(externalRoot, entry.name);
    if (!existsSync(path.join(extensionRoot, "source.toml"))) continue;
    const identity = extensionIdentity(root, extensionRoot);
    if (!selected.has(identity.sqlName)) continue;
    const upgrade = upgradePlanRow(root, extensionRoot, identity, checkedTarget);
    const upstream = upstreamPlanRow(root, extensionRoot, identity, checkedTarget);
    if (upgrade !== undefined) rows.push(upgrade);
    if (upstream !== undefined) rows.push(upstream);
  }
  return Object.freeze(rows.sort((left, right) =>
    compareText(`${left.sqlName}\0${left.kind}`, `${right.sqlName}\0${right.kind}`)));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "run") {
    fail("usage: native-extension-qualification.mjs <plan|run> --target TARGET --selected-sql-names CSV [--runtime DIR] [--format json|count]");
  }
  const options = { command, format: "json" };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) fail(`${flag} requires a value`);
    if (flag === "--target") options.target = value;
    else if (flag === "--selected-sql-names") options.selectedSqlNames = value;
    else if (flag === "--runtime") options.runtime = value;
    else if (flag === "--format") options.format = value;
    else fail(`unknown argument ${flag}`);
  }
  if (options.format !== "json" && options.format !== "count") {
    fail("--format must be json or count");
  }
  if (command === "run" && options.runtime === undefined) fail("run requires --runtime");
  return options;
}

function runProcess(command, args, { cwd, env, label }) {
  process.stdout.write(`==> ${label}\n`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? "unknown"}`);
}

function runPlan(root, rows, runtime) {
  const runtimeRoot = path.resolve(runtime);
  const runtimeStat = lstatSync(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    fail(`runtime must be a real directory: ${runtime}`);
  }
  for (const row of rows) {
    const commonEnv = {
      ...process.env,
      OLIPHAUNT_EXTENSION_CURRENT_RUNTIME: runtimeRoot,
      OLIPHAUNT_EXTENSION_SQL_NAME: row.sqlName,
      OLIPHAUNT_EXTENSION_SOURCE_NAME: row.sourceName,
      OLIPHAUNT_EXTENSION_SOURCE_COMMIT: row.sourceCommit,
    };
    if (row.kind === "upgrade") {
      runProcess("bash", [path.join(root, row.runner)], {
        cwd: root,
        env: {
          ...commonEnv,
          OLIPHAUNT_EXTENSION_UPGRADE_FROM_VERSION: row.fromVersion,
          OLIPHAUNT_EXTENSION_SOURCE_CONTROL_PATH: row.sourceControlPath,
        },
        label: `${row.sqlName} ${row.fromVersion} pinned-version upgrade`,
      });
      continue;
    }
    runProcess("bash", [path.join(root, "src/extensions/artifacts/native/tools/run-pgxs-installcheck.sh")], {
      cwd: root,
      env: {
        ...commonEnv,
        OLIPHAUNT_EXTENSION_INCLUDED_SUITES: row.includedSuites.join(","),
        OLIPHAUNT_EXTENSION_SUITE_TARGET_PREFIX: row.suiteTargetPrefix,
        OLIPHAUNT_EXTENSION_AGGREGATE_SUITES: row.aggregateSuites.join(","),
        OLIPHAUNT_EXTENSION_EXCLUDED_SUITES: row.excludedSuites.join(","),
        OLIPHAUNT_EXTENSION_TEST_LOCALE: row.locale,
        OLIPHAUNT_EXTENSION_SHARED_PRELOAD_LIBRARIES: row.preloadLibraries.join(","),
      },
      label: `${row.sqlName} exact-candidate upstream PGXS installcheck`,
    });
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const rows = nativeExtensionQualificationPlan(options);
  if (options.command === "run") runPlan(DEFAULT_ROOT, rows, options.runtime);
  if (options.format === "count") process.stdout.write(`${rows.length}\n`);
  else process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
