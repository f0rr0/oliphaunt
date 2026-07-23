#!/usr/bin/env bun
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { electronReleaseDependencies } from "../../examples/tools/example-release-dependencies.mjs";
import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import { typescriptOptionalRuntimePackageProducts } from "./release-artifact-targets.mjs";
import { compatibilityVersionEntries, loadGraph } from "./release-graph.mjs";
import {
  RELEASE_SEMANTIC_FINGERPRINT_SCHEMA,
  RELEASE_SEMANTIC_INPUT_SCHEMA,
  RELEASE_SEMANTIC_INPUTS_PATH,
  releaseSemanticFingerprintDigest,
  releaseSemanticFingerprintText,
} from "./release-semantic-inputs.mjs";
import {
  releaseDerivedPathInventory,
  releaseSemanticFingerprintDerivedEntries,
} from "./sync-release-pr.mjs";
import { RELEASE_PLEASE_BOOTSTRAP_SHA } from "./release-please-bootstrap.mjs";

const TOOL = "verify-release-commit.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const SEMVER = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:[.](?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/u;
const CARGO_DEPENDENCY_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);
let cachedDerivedRules;

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort(compareText)) === JSON.stringify([...right].sort(compareText));
}

function git(
  repo,
  args,
  { allowEmptyOutput = false, check = true, stdoutTerminator = undefined } = {},
) {
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput,
    cwd: repo,
    label: `git ${args.join(" ")}`,
    stdoutTerminator,
  });
  if (result.error !== undefined) {
    throw error(result.error.message);
  }
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return { status: result.status, stdout: result.stdout.trimEnd() };
}

function show(repo, commit, file) {
  return git(repo, ["show", `${commit}:${file}`]).stdout;
}

function showBytes(repo, commit, file) {
  const args = ["show", `${commit}:${file}`];
  const result = captureCommandBytes("git", args, {
    cwd: repo,
    label: `git ${args.join(" ")}`,
    maxOutputBytes: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw error(result.error.message);
  }
  if (result.status !== 0) {
    const detail = (result.stderr.toString("utf8") || result.stdout.toString("utf8") || "").trim();
    throw error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function showJson(repo, commit, file) {
  let value;
  try {
    value = JSON.parse(show(repo, commit, file));
  } catch (cause) {
    throw error(`${file} at ${commit} is not valid JSON: ${cause.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${file} at ${commit} must contain a JSON object`);
  }
  return value;
}

function relativeFile(packagePath, file, context) {
  if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file)) {
    throw error(`${context} must be a non-empty relative path`);
  }
  const normalized = path.posix.normalize(path.posix.join(packagePath, file));
  if (normalized === ".." || normalized.startsWith("../") || !(normalized === packagePath || normalized.startsWith(`${packagePath}/`))) {
    throw error(`${context} must stay inside ${packagePath}`);
  }
  return normalized;
}

function canonicalVersionFile(packagePath, config, product) {
  if (typeof config["version-file"] === "string" && config["version-file"].length > 0) {
    return relativeFile(packagePath, config["version-file"], `${product}.version-file`);
  }
  if (config["release-type"] === "rust") {
    return relativeFile(packagePath, "Cargo.toml", `${product}.Cargo.toml`);
  }
  if (config["release-type"] === "node" || config["release-type"] === "expo") {
    return relativeFile(packagePath, "package.json", `${product}.package.json`);
  }
  throw error(`${product} has no canonical version file`);
}

function versionFromCanonicalFile(text, config, file, product) {
  if (config["release-type"] === "node" || config["release-type"] === "expo") {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (cause) {
      throw error(`${file} for ${product} is invalid JSON: ${cause.message}`);
    }
    return manifest?.version;
  }
  if (config["release-type"] === "rust" && !config["version-file"]) {
    const packageBlock = text.match(/(?:^|\n)\[package\][ \t]*\n([\s\S]*?)(?=\n\[|$)/u)?.[1] ?? "";
    return packageBlock.match(/(?:^|\n)[ \t]*version[ \t]*=[ \t]*["']([^"']+)["']/u)?.[1];
  }
  return text.trim();
}

function changelogMentionsVersion(text, version) {
  return text.split(/\r?\n/u).some((line) => {
    const heading = line.match(/^##[ \t]+(?:\[)?([^\] (]+)(?:\])?(?:[ \t(]|$)/u)?.[1];
    return heading === version;
  });
}

function changedFiles(repo, parent, commit) {
  return new Set(
    git(
      repo,
      ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRT", "-z", parent, commit],
      { stdoutTerminator: "\0" },
    ).stdout
      .split("\0")
      .filter(Boolean),
  );
}

function jsonPath(expression, context) {
  if (typeof expression !== "string" || !/^[$][.][A-Za-z0-9_.-]+$/u.test(expression)) {
    throw error(`${context} must use a simple $.path.to.field expression`);
  }
  return expression.slice(2).split(".");
}

function pathKey(parts) {
  return parts.map(String).join("\0");
}

function semanticDiffs(before, after, parts = []) {
  if (Object.is(before, after)) return [];
  const beforeObject = before !== null && typeof before === "object";
  const afterObject = after !== null && typeof after === "object";
  if (beforeObject && afterObject && Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set(Array.isArray(before)
      ? Array.from({ length: Math.max(before.length, after.length) }, (_value, index) => index)
      : [...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => semanticDiffs(before[key], after[key], [...parts, key]));
  }
  return [{ parts, before, after }];
}

function parseStructured(text, type, file, commit) {
  try {
    const value = type === "json" ? JSON.parse(text) : type === "toml" ? Bun.TOML.parse(text) : Bun.YAML.parse(text);
    if (value === null || typeof value !== "object") {
      throw new TypeError("root must be an object or array");
    }
    return value;
  } catch (cause) {
    throw error(`${file} at ${commit} is invalid ${type.toUpperCase()}: ${cause.message}`);
  }
}

function requireExactObjectKeys(value, expected, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  const actual = Object.keys(value);
  if (!sameStrings(actual, expected)) {
    throw error(`${context} keys must be exactly ${expected.join(", ")}; got ${actual.join(", ") || "none"}`);
  }
}

function requireRepositoryBlobPath(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../") ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error(`${context} must be a canonical repository-relative path`);
  }
  return value;
}

function releaseSemanticFingerprintSnapshot({ repo, commit, file, expectedProduct }) {
  const raw = showBytes(repo, commit, file).toString("utf8");
  let record;
  try {
    record = JSON.parse(raw);
  } catch (cause) {
    throw error(`${file} at ${commit} is not valid JSON: ${cause.message}`);
  }
  requireExactObjectKeys(
    record,
    ["schema", "product", "ownershipSchema", "ownershipManifest", "rules", "sha256"],
    `${file} at ${commit}`,
  );
  if (
    record.schema !== RELEASE_SEMANTIC_FINGERPRINT_SCHEMA ||
    record.product !== expectedProduct ||
    record.ownershipSchema !== RELEASE_SEMANTIC_INPUT_SCHEMA ||
    record.ownershipManifest !== RELEASE_SEMANTIC_INPUTS_PATH ||
    !Array.isArray(record.rules) ||
    record.rules.length === 0 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256)
  ) {
    throw error(`${file} at ${commit} has invalid release-semantic fingerprint identity`);
  }

  const inputDigests = new Map();
  const rules = record.rules.map((rule, ruleIndex) => {
    const ruleContext = `${file} at ${commit} rules[${ruleIndex}]`;
    requireExactObjectKeys(rule, ["id", "paths", "inputs"], ruleContext);
    if (
      typeof rule.id !== "string" ||
      rule.id.length === 0 ||
      !Array.isArray(rule.paths) ||
      rule.paths.length === 0 ||
      rule.paths.some((candidate) => typeof candidate !== "string" || candidate.length === 0) ||
      !Array.isArray(rule.inputs) ||
      rule.inputs.length === 0
    ) {
      throw error(`${ruleContext} has invalid ownership topology`);
    }
    const inputs = rule.inputs.map((input, inputIndex) => {
      const inputContext = `${ruleContext}.inputs[${inputIndex}]`;
      requireExactObjectKeys(input, ["path", "sha256"], inputContext);
      const inputPath = requireRepositoryBlobPath(input.path, `${inputContext}.path`);
      if (inputDigests.has(inputPath)) {
        throw error(`${file} at ${commit} repeats release-semantic input ${inputPath}`);
      }
      if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.sha256)) {
        throw error(`${inputContext}.sha256 must be a lowercase SHA-256 digest`);
      }
      const actual = createHash("sha256").update(showBytes(repo, commit, inputPath)).digest("hex");
      if (input.sha256 !== actual) {
        throw error(`${file} at ${commit} records forged release-semantic input digest for ${inputPath}`);
      }
      inputDigests.set(inputPath, input.sha256);
      return { path: inputPath, sha256: input.sha256 };
    });
    return { id: rule.id, paths: [...rule.paths], inputs };
  });
  const owned = {
    schema: record.schema,
    product: record.product,
    ownershipSchema: record.ownershipSchema,
    ownershipManifest: record.ownershipManifest,
    rules,
  };
  const expectedDigest = releaseSemanticFingerprintDigest(owned);
  if (record.sha256 !== expectedDigest) {
    throw error(`${file} at ${commit} has forged top-level release-semantic digest`);
  }
  const canonical = { ...owned, sha256: expectedDigest };
  if (raw !== releaseSemanticFingerprintText(canonical)) {
    throw error(`${file} at ${commit} is not the canonical generated release-semantic fingerprint`);
  }
  const structure = {
    ...owned,
    rules: rules.map((rule) => ({
      id: rule.id,
      paths: rule.paths,
      inputs: rule.inputs.map(({ path: inputPath }) => ({ path: inputPath })),
    })),
  };
  return { structure, inputDigests };
}

function validateReleaseSemanticFingerprintChange({
  repo,
  parent,
  commit,
  file,
  expectedProduct,
  changed,
}) {
  const before = releaseSemanticFingerprintSnapshot({ repo, commit: parent, file, expectedProduct });
  const after = releaseSemanticFingerprintSnapshot({ repo, commit, file, expectedProduct });
  if (JSON.stringify(before.structure) !== JSON.stringify(after.structure)) {
    throw error(`${file} changes release-semantic ownership topology in a release-bump commit`);
  }
  let changedInputCount = 0;
  for (const [inputPath, beforeDigest] of before.inputDigests) {
    const afterDigest = after.inputDigests.get(inputPath);
    if (afterDigest === beforeDigest) continue;
    changedInputCount += 1;
    if (!changed.has(inputPath)) {
      throw error(`${file} changes the digest for unchanged release-semantic input ${inputPath}`);
    }
  }
  if (changedInputCount === 0) {
    throw error(`${file} changed without a changed release-semantic input`);
  }
}

function versionTransition(before, after, transitions) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  return transitions.some((transition) => {
    if (!before.includes(transition.before) || !after.includes(transition.after)) return false;
    return before.replaceAll(transition.before, "<release-version>") ===
      after.replaceAll(transition.after, "<release-version>");
  });
}

function structuredRuleKey(type, file, parts) {
  return `${type}\0${file}\0${pathKey(parts)}`;
}

function derivedVersionRules() {
  if (cachedDerivedRules !== undefined) return cachedDerivedRules;
  const products = loadGraph(TOOL).products;
  const structured = new Map();
  const text = new Map();
  const addStructured = (type, file, parts, sourceProduct, wrapped = false) => {
    const key = structuredRuleKey(type, file, parts);
    const prior = structured.get(key);
    if (prior !== undefined && (prior.sourceProduct !== sourceProduct || prior.wrapped !== wrapped)) {
      throw error(`conflicting derived version rules for ${file}:${parts.join(".")}`);
    }
    structured.set(key, { sourceProduct, wrapped });
  };
  const addText = (file, rule) => {
    const prior = text.get(file);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(rule)) {
      throw error(`conflicting derived text version rules for ${file}`);
    }
    text.set(file, rule);
  };

  for (const entry of compatibilityVersionEntries(products, { requireSourceProduct: true, prefix: TOOL })) {
    const separator = entry.parser.indexOf(":");
    const parser = separator === -1 ? entry.parser : entry.parser.slice(0, separator);
    const expression = separator === -1 ? "" : entry.parser.slice(separator + 1);
    if (parser === "json" || parser === "toml") {
      addStructured(parser, entry.path, expression.split("."), entry.sourceProduct);
    } else if (parser === "raw") {
      addText(entry.path, { type: "raw", sourceProduct: entry.sourceProduct });
    } else if (parser === "rust-const") {
      addText(entry.path, { type: "rust-const", name: expression, sourceProduct: entry.sourceProduct });
    } else {
      throw error(`${entry.id} uses unsupported compatibility parser ${JSON.stringify(entry.parser)}`);
    }
  }

  for (const { packageName, product } of typescriptOptionalRuntimePackageProducts(TOOL)) {
    addStructured("json", "src/sdks/js/package.json", ["optionalDependencies", packageName], product, true);
    addStructured(
      "yaml",
      "pnpm-lock.yaml",
      ["importers", "src/sdks/js", "optionalDependencies", packageName, "specifier"],
      product,
      true,
    );
  }

  const npmProducts = new Map();
  for (const [product, config] of Object.entries(products)) {
    for (const carrier of config.registry_packages ?? []) {
      if (!carrier.startsWith("npm:")) continue;
      const packageName = carrier.slice("npm:".length);
      npmProducts.set(packageName, [...(npmProducts.get(packageName) ?? []), product]);
    }
  }
  for (const { packageName } of electronReleaseDependencies(ROOT)) {
    const candidates = npmProducts.get(packageName) ?? [];
    if (candidates.length !== 1) {
      throw error(`Electron release dependency ${packageName} must map to exactly one release product; got ${candidates.join(", ") || "none"}`);
    }
    addStructured("json", "examples/electron/package.json", ["dependencies", packageName], candidates[0]);
  }

  cachedDerivedRules = { structured, text };
  return cachedDerivedRules;
}

function productTransition(rule, before, after, transitions) {
  const transition = transitions.find(({ product }) => product === rule.sourceProduct);
  if (transition === undefined) return false;
  return rule.wrapped
    ? versionTransition(before, after, [transition])
    : before === transition.before && after === transition.after;
}

function valueAt(root, parts) {
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function cargoDependencyEntryPath(parts) {
  const names = parts.map(String);
  if (names.length === 3 && CARGO_DEPENDENCY_TABLES.has(names[0]) && names[2] === "version") {
    return names.slice(0, 2);
  }
  if (names.length === 5 && names[0] === "target" && CARGO_DEPENDENCY_TABLES.has(names[2]) && names[4] === "version") {
    return names.slice(0, 4);
  }
  return undefined;
}

function parseCargoManifest(repo, commit, file) {
  return parseStructured(show(repo, commit, file), "toml", file, commit);
}

function cargoDependencyVersionChange({ repo, parent, commit, file, parts, beforeRoot, afterRoot, before, after }) {
  if (path.posix.basename(file) !== "Cargo.toml") return false;
  const entryPath = cargoDependencyEntryPath(parts);
  if (entryPath === undefined) return false;
  const priorEntry = valueAt(beforeRoot, entryPath);
  const nextEntry = valueAt(afterRoot, entryPath);
  if (
    priorEntry === null || Array.isArray(priorEntry) || typeof priorEntry !== "object" ||
    nextEntry === null || Array.isArray(nextEntry) || typeof nextEntry !== "object" ||
    typeof priorEntry.path !== "string" || priorEntry.path !== nextEntry.path
  ) {
    return false;
  }
  const dependencyManifest = path.posix.normalize(path.posix.join(path.posix.dirname(file), priorEntry.path, "Cargo.toml"));
  if (dependencyManifest === ".." || dependencyManifest.startsWith("../") || path.posix.isAbsolute(dependencyManifest)) return false;
  const priorPackage = parseCargoManifest(repo, parent, dependencyManifest).package;
  const nextPackage = parseCargoManifest(repo, commit, dependencyManifest).package;
  if (
    priorPackage === null || Array.isArray(priorPackage) || typeof priorPackage !== "object" ||
    nextPackage === null || Array.isArray(nextPackage) || typeof nextPackage !== "object" ||
    typeof priorPackage.version !== "string" || typeof nextPackage.version !== "string" ||
    priorPackage.name !== nextPackage.name
  ) {
    return false;
  }
  const exact = typeof before === "string" && before.startsWith("=");
  return before === `${exact ? "=" : ""}${priorPackage.version}` && after === `${exact ? "=" : ""}${nextPackage.version}`;
}

function localCargoPackageVersions(repo, commit, cache) {
  if (cache.has(commit)) return cache.get(commit);
  const versions = new Map();
  const manifests = git(
    repo,
    ["ls-tree", "-r", "-z", "--name-only", commit],
    { allowEmptyOutput: true, stdoutTerminator: "\0" },
  ).stdout
    .split("\0")
    .filter((file) => file === "Cargo.toml" || file.endsWith("/Cargo.toml"));
  for (const file of manifests) {
    const packageConfig = parseCargoManifest(repo, commit, file).package;
    if (
      packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object" ||
      typeof packageConfig.name !== "string" || typeof packageConfig.version !== "string"
    ) {
      continue;
    }
    const packageVersions = versions.get(packageConfig.name) ?? new Set();
    packageVersions.add(packageConfig.version);
    versions.set(packageConfig.name, packageVersions);
  }
  cache.set(commit, versions);
  return versions;
}

function cargoLockVersionChange({ repo, parent, commit, file, parts, beforeRoot, afterRoot, before, after, cargoVersions }) {
  const names = parts.map(String);
  if (path.posix.basename(file) !== "Cargo.lock" || names.length !== 3 || names[0] !== "package" || !/^[0-9]+$/u.test(names[1]) || names[2] !== "version") {
    return false;
  }
  const priorPackage = valueAt(beforeRoot, ["package", Number(names[1])]);
  const nextPackage = valueAt(afterRoot, ["package", Number(names[1])]);
  if (
    priorPackage === null || Array.isArray(priorPackage) || typeof priorPackage !== "object" ||
    nextPackage === null || Array.isArray(nextPackage) || typeof nextPackage !== "object" ||
    typeof priorPackage.name !== "string" || priorPackage.name !== nextPackage.name ||
    priorPackage.source !== undefined || nextPackage.source !== undefined
  ) {
    return false;
  }
  return localCargoPackageVersions(repo, parent, cargoVersions).get(priorPackage.name)?.has(before) === true &&
    localCargoPackageVersions(repo, commit, cargoVersions).get(priorPackage.name)?.has(after) === true;
}

function authorizedDerivedStructuredChange(context, rules) {
  if (
    context.type === "json" &&
    context.file === "release-please-config.json" &&
    pathKey(context.parts) === "bootstrap-sha" &&
    context.before === RELEASE_PLEASE_BOOTSTRAP_SHA &&
    context.after === undefined &&
    context.transitions.length > 0
  ) {
    return true;
  }
  const rule = rules.structured.get(structuredRuleKey(context.type, context.file, context.parts));
  if (rule !== undefined) return productTransition(rule, context.before, context.after, context.transitions);
  if (context.type !== "toml") return false;
  return cargoDependencyVersionChange(context) || cargoLockVersionChange(context);
}

function structuredType(file) {
  const basename = path.posix.basename(file);
  if (file === "release-please-config.json" || basename === "package.json" || basename === "jsr.json") return "json";
  if (basename === "pnpm-lock.yaml") return "yaml";
  if (basename === "Cargo.toml" || basename === "Cargo.lock" || file.endsWith(".toml")) return "toml";
  return undefined;
}

function maskGenericVersion(text, file, commit) {
  const single = text.split(/\r?\n/u).filter((line) => line.includes("x-release-please-version"));
  if (single.length === 1) {
    const versions = single[0].match(/[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?/gu) ?? [];
    if (versions.length !== 1) throw error(`${file} at ${commit} release version marker must contain exactly one version`);
    return { version: versions[0], text: text.replace(single[0], single[0].replace(versions[0], "<release-version>")) };
  }
  const block = /x-release-please-start-version(?<body>[\s\S]*?)x-release-please-end/u.exec(text)?.groups?.body;
  if (single.length !== 0 || block === undefined) throw error(`${file} at ${commit} must contain one Release Please version marker`);
  const versions = block.match(/[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?/gu) ?? [];
  if (versions.length !== 1) throw error(`${file} at ${commit} release version block must contain exactly one version`);
  return { version: versions[0], text: text.replace(block, block.replace(versions[0], "<release-version>")) };
}

function validateTextSemanticDiff({ repo, parent, commit, file, fields, derived, transitions, derivedRules }) {
  const before = show(repo, parent, file);
  const after = show(repo, commit, file);
  if (fields.some(({ type }) => type === "raw")) {
    const field = fields.find(({ type }) => type === "raw");
    if (before.trim() !== field.before || after.trim() !== field.after) {
      throw error(`canonical version file ${file} contains a non-version semantic change`);
    }
    return;
  }
  if (fields.some(({ type }) => type === "generic")) {
    const prior = maskGenericVersion(before, file, parent);
    const next = maskGenericVersion(after, file, commit);
    if (prior.text !== next.text || !fields.some(({ before: oldVersion, after: newVersion }) => prior.version === oldVersion && next.version === newVersion)) {
      throw error(`Release Please generic file ${file} contains a non-version semantic change`);
    }
    return;
  }
  const derivedRule = derived ? derivedRules.text.get(file) : undefined;
  if (derivedRule?.type === "rust-const") {
    const pattern = new RegExp(`(const\\s+${derivedRule.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:\\s*&str\\s*=\\s*")([^"]+)(";)`, "u");
    const prior = pattern.exec(before);
    const next = pattern.exec(after);
    if (
      prior === null || next === null || !productTransition(derivedRule, prior[2], next[2], transitions) ||
      before.replace(pattern, "$1<release-version>$3") !== after.replace(pattern, "$1<release-version>$3")
    ) {
      throw error(`derived file ${file} contains a non-version semantic change`);
    }
    return;
  }
  if (
    derivedRule?.type === "raw" && productTransition(derivedRule, before.trim(), after.trim(), transitions) &&
    before.replace(before.trim(), "<release-version>") === after.replace(after.trim(), "<release-version>")
  ) {
    return;
  }
  throw error(`${derived ? "derived file" : "release file"} ${file} contains a non-version semantic change`);
}

function validateAllowedFileSemantics({
  repo,
  parent,
  commit,
  changed,
  changelogs,
  fieldsByFile,
  derivedFiles,
  semanticFingerprintProducts,
  transitions,
}) {
  const derivedRules = derivedVersionRules();
  const cargoVersions = new Map();
  for (const file of changed) {
    if (file === ".release-please-manifest.json" || changelogs.has(file)) continue;
    const semanticFingerprintProduct = semanticFingerprintProducts.get(file);
    if (semanticFingerprintProduct !== undefined) {
      validateReleaseSemanticFingerprintChange({
        repo,
        parent,
        commit,
        file,
        expectedProduct: semanticFingerprintProduct,
        changed,
      });
      continue;
    }
    const fields = fieldsByFile.get(file) ?? [];
    const derived = derivedFiles.has(file);
    const type = structuredType(file);
    if (type === undefined) {
      validateTextSemanticDiff({ repo, parent, commit, file, fields, derived, transitions, derivedRules });
      continue;
    }
    const before = parseStructured(show(repo, parent, file), type, file, parent);
    const after = parseStructured(show(repo, commit, file), type, file, commit);
    const releaseFields = new Map(fields.filter(({ parts }) => parts !== undefined).map((field) => [pathKey(field.parts), field]));
    for (const difference of semanticDiffs(before, after)) {
      const releaseField = releaseFields.get(pathKey(difference.parts));
      if (releaseField !== undefined) {
        if (difference.before !== releaseField.before || difference.after !== releaseField.after) {
          throw error(`${releaseField.role} ${file} contains a non-version semantic change at ${difference.parts.join(".")}`);
        }
        continue;
      }
      if (derived && authorizedDerivedStructuredChange({
        repo,
        parent,
        commit,
        file,
        type,
        parts: difference.parts,
        beforeRoot: before,
        afterRoot: after,
        before: difference.before,
        after: difference.after,
        transitions,
        cargoVersions,
      }, derivedRules)) continue;
      const label = fields.some(({ role }) => role === "canonical version file") ? "canonical version file" : derived ? "derived file" : "release file";
      throw error(`${label} ${file} contains a non-version semantic change at ${difference.parts.join(".") || "<root>"}`);
    }
  }
}

export function deriveReleaseProducts({ repo = ROOT, headRef = "HEAD" } = {}) {
  const commit = git(repo, ["rev-parse", "--verify", `${headRef}^{commit}`]).stdout;
  const ancestry = git(repo, ["rev-list", "--parents", "-n", "1", commit]).stdout.split(/\s+/u);
  if (ancestry.length !== 2) {
    throw error(`release commit ${commit} must have exactly one parent, found ${Math.max(0, ancestry.length - 1)}`);
  }
  const parent = ancestry[1];
  const config = showJson(repo, commit, "release-please-config.json");
  const packageConfigs = config.packages;
  if (packageConfigs === null || Array.isArray(packageConfigs) || typeof packageConfigs !== "object") {
    throw error("release-please-config.json must define a packages object");
  }
  const byPath = new Map();
  const products = new Set();
  for (const [packagePath, packageConfig] of Object.entries(packageConfigs)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      throw error(`release-please package ${packagePath} must be an object`);
    }
    const product = packageConfig.component;
    if (typeof product !== "string" || product.length === 0 || products.has(product)) {
      throw error(`release-please package ${packagePath} has a missing or duplicate component`);
    }
    products.add(product);
    byPath.set(packagePath, product);
  }
  const before = showJson(repo, parent, ".release-please-manifest.json");
  const after = showJson(repo, commit, ".release-please-manifest.json");
  const changedProducts = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((packagePath) => before[packagePath] !== after[packagePath])
    .map((packagePath) => {
      const product = byPath.get(packagePath);
      if (product === undefined) {
        throw error(`release manifest changed unknown package path ${packagePath}`);
      }
      return product;
    })
    .sort(compareText);
  if (changedProducts.length === 0) {
    throw error("release commit must advance at least one release-please manifest version");
  }
  return { commit, parent, products: changedProducts };
}

export function verifyReleaseCommit({ repo = ROOT, headRef = "HEAD", products }) {
  if (!Array.isArray(products) || products.length === 0 || products.some((item) => typeof item !== "string" || item.length === 0)) {
    throw error("products must be a non-empty product string list");
  }
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length !== products.length) {
    throw error("products must not contain duplicates");
  }

  const commit = git(repo, ["rev-parse", "--verify", `${headRef}^{commit}`]).stdout;
  const ancestry = git(repo, ["rev-list", "--parents", "-n", "1", commit]).stdout.split(/\s+/u);
  if (ancestry.length !== 2) {
    throw error(`release commit ${commit} must have exactly one parent, found ${Math.max(0, ancestry.length - 1)}`);
  }
  const parent = ancestry[1];
  const subject = git(repo, ["show", "-s", "--format=%s", commit]).stdout;
  if (!/^chore\(release\): .+/u.test(subject)) {
    throw error(`release commit ${commit} subject must start with "chore(release): "; got ${JSON.stringify(subject)}`);
  }

  const config = showJson(repo, commit, "release-please-config.json");
  const packageConfigs = config.packages;
  if (packageConfigs === null || Array.isArray(packageConfigs) || typeof packageConfigs !== "object") {
    throw error("release-please-config.json must define a packages object");
  }
  const byProduct = new Map();
  const byPath = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packageConfigs)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      throw error(`release-please package ${packagePath} must be an object`);
    }
    const product = packageConfig.component;
    if (typeof product !== "string" || product.length === 0 || byProduct.has(product)) {
      throw error(`release-please package ${packagePath} has a missing or duplicate component`);
    }
    byProduct.set(product, { packagePath, config: packageConfig });
    byPath.set(packagePath, product);
  }
  for (const product of selected) {
    if (!byProduct.has(product)) {
      throw error(`selected release product ${product} is absent from release-please-config.json`);
    }
  }

  const before = showJson(repo, parent, ".release-please-manifest.json");
  const after = showJson(repo, commit, ".release-please-manifest.json");
  const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((packagePath) => before[packagePath] !== after[packagePath])
    .sort(compareText);
  const changedProducts = changedPaths.map((packagePath) => {
    const product = byPath.get(packagePath);
    if (product === undefined) {
      throw error(`release manifest changed unknown package path ${packagePath}`);
    }
    return product;
  }).sort(compareText);
  if (!sameStrings(changedProducts, selected)) {
    throw error(`selected products do not exactly match this commit's release bumps: selected=${JSON.stringify(selected)}, bumped=${JSON.stringify(changedProducts)}`);
  }

  const changed = changedFiles(repo, parent, commit);
  if (!changed.has(".release-please-manifest.json")) {
    throw error("release commit must change .release-please-manifest.json");
  }
  const versions = {};
  const semanticFingerprintProducts = new Map(
    releaseSemanticFingerprintDerivedEntries().map(({ path: file, product }) => [file, product]),
  );
  const derivedFiles = new Set(releaseDerivedPathInventory());
  const allowedChangedFiles = new Set([".release-please-manifest.json", ...derivedFiles]);
  const fieldsByFile = new Map();
  const changelogs = new Set();
  const transitions = [];
  const addField = (file, field) => fieldsByFile.set(file, [...(fieldsByFile.get(file) ?? []), field]);
  for (const product of selected) {
    const { packagePath, config: packageConfig } = byProduct.get(product);
    const version = after[packagePath];
    const priorVersion = before[packagePath];
    if (
      typeof priorVersion !== "string" || !SEMVER.test(priorVersion) ||
      typeof version !== "string" || !SEMVER.test(version) ||
      Bun.semver.order(version, priorVersion) <= 0
    ) {
      throw error(`${product} must advance to a semver version in .release-please-manifest.json`);
    }
    const versionFile = canonicalVersionFile(packagePath, packageConfig, product);
    const changelogFile = relativeFile(
      packagePath,
      packageConfig["changelog-path"] ?? "CHANGELOG.md",
      `${product}.changelog-path`,
    );
    if (!changed.has(versionFile)) {
      throw error(`${product} release commit did not change canonical version file ${versionFile}`);
    }
    if (!changed.has(changelogFile)) {
      throw error(`${product} release commit did not change changelog ${changelogFile}`);
    }
    allowedChangedFiles.add(versionFile);
    allowedChangedFiles.add(changelogFile);
    changelogs.add(changelogFile);
    transitions.push({ product, before: priorVersion, after: version });
    if (packageConfig["release-type"] === "node" || packageConfig["release-type"] === "expo") {
      addField(versionFile, { type: "json", parts: ["version"], before: priorVersion, after: version, role: "canonical version file" });
    } else if (packageConfig["release-type"] === "rust" && !packageConfig["version-file"]) {
      addField(versionFile, { type: "toml", parts: ["package", "version"], before: priorVersion, after: version, role: "canonical version file" });
    } else {
      addField(versionFile, { type: "raw", before: priorVersion, after: version, role: "canonical version file" });
    }
    for (const [index, entry] of (packageConfig["extra-files"] ?? []).entries()) {
      const extraPath = typeof entry === "string" ? entry : entry?.path;
      const file = relativeFile(packagePath, extraPath, `${product}.extra-files[${index}]`);
      allowedChangedFiles.add(file);
      const type = typeof entry === "string" ? "generic" : entry.type ?? "generic";
      const field = { type, before: priorVersion, after: version, role: `${product} extra file` };
      if (type === "json" || type === "toml") {
        field.parts = jsonPath(entry.jsonpath, `${product}.extra-files[${index}].jsonpath`);
      }
      addField(file, field);
    }
    const fileVersion = versionFromCanonicalFile(show(repo, commit, versionFile), packageConfig, versionFile, product);
    if (fileVersion !== version) {
      throw error(`${product} canonical version file ${versionFile} contains ${JSON.stringify(fileVersion)}, expected ${version}`);
    }
    if (!changelogMentionsVersion(show(repo, commit, changelogFile), version)) {
      throw error(`${product} changelog ${changelogFile} has no release heading for ${version}`);
    }
    versions[product] = version;
  }

  const unexpected = [...changed].filter((file) => !allowedChangedFiles.has(file)).sort(compareText);
  if (unexpected.length > 0) {
    throw error(
      `release-bump commit contains non-release-derived path(s): ${unexpected.join(", ")}; ` +
      "only Release Please version/changelog/extra-file outputs and sync-release-pr's structured derived-path inventory are allowed",
    );
  }

  validateAllowedFileSemantics({
    repo,
    parent,
    commit,
    changed,
    changelogs,
    fieldsByFile,
    derivedFiles,
    semanticFingerprintProducts,
    transitions,
  });

  return {
    commit,
    parent,
    products: selected,
    versions,
    verifiedDerivedPaths: [...changed].filter((file) => derivedFiles.has(file)).sort(compareText),
  };
}

function parseArgs(argv) {
  let productsJson = "";
  let headRef = "HEAD";
  let deriveProducts = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--products-json") {
      productsJson = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--derive-products") {
      deriveProducts = true;
    } else if (arg === "--head-ref") {
      headRef = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw error(`unknown argument ${arg}`);
    }
  }
  if (!headRef || deriveProducts === Boolean(productsJson)) {
    throw error("usage: verify-release-commit.mjs (--products-json JSON | --derive-products) [--head-ref REF]");
  }
  if (deriveProducts) return { deriveProducts, headRef };
  let products;
  try {
    products = JSON.parse(productsJson);
  } catch (cause) {
    throw error(`--products-json must be valid JSON: ${cause.message}`);
  }
  return { deriveProducts, headRef, products };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.deriveProducts) {
      console.log(JSON.stringify(deriveReleaseProducts(args).products));
    } else {
      const verified = verifyReleaseCommit(args);
      console.log(`verified release-bump commit ${verified.commit} for ${verified.products.length} product(s): ${verified.products.join(", ")}`);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
