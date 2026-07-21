#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const TOOL = "assert-ordinal-release-ordering.mjs";
const PRODUCTION_SOURCE = /[.](?:bash|cjs|js|mjs|sh|ts|tsx|yaml|yml|zsh)$/u;
const NON_PRODUCTION_PATH = /(?:^|\/)(?:__fixtures__|__tests__|fixtures|generated|node_modules|target|testdata)(?:\/|$)|[.](?:spec|test)[.]/u;
const RELEASE_CRITICAL_PATH = /^(?:[.]github\/(?:actions|scripts|workflows)\/|tools\/(?:graph|policy|release)\/|src\/(?:extensions|runtimes)\/.*\/tools\/|src\/sdks\/[^/]+\/tools\/|src\/sdks\/js\/src\/native\/|src\/shared\/contracts\/tools\/)/u;
const RELEASE_CRITICAL_FILES = new Set([
  "src/sdks/react-native/app.plugin.js",
  "src/sdks/react-native/src/mobileExtensionProof.ts",
]);
const LOCALE_COMPARE = new RegExp(["locale", "Compare"].join(""), "gu");
const INTL_COLLATOR = new RegExp(["Intl", "Collator"].join("[.]"), "gu");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function isReleaseCriticalProductionPath(file) {
  const normalized = file.split(path.sep).join("/");
  return PRODUCTION_SOURCE.test(normalized)
    && !NON_PRODUCTION_PATH.test(normalized)
    && (RELEASE_CRITICAL_PATH.test(normalized) || RELEASE_CRITICAL_FILES.has(normalized));
}

export function localeSensitiveOrderingViolations(sources) {
  const violations = [];
  for (const { file, text } of sources) {
    if (!isReleaseCriticalProductionPath(file)) continue;
    for (const [kind, pattern] of [
      ["locale-dependent string comparison", LOCALE_COMPARE],
      ["locale-dependent collator", INTL_COLLATOR],
    ]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        violations.push({ file, line: lineNumber(text, match.index ?? 0), kind });
      }
    }
  }
  return violations.sort((left, right) =>
    compareText(left.file, right.file) || left.line - right.line || compareText(left.kind, right.kind));
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function repositoryReleaseCriticalSources(root) {
  return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .filter(isReleaseCriticalProductionPath)
    .sort(compareText)
    .flatMap((file) => {
      const absolute = path.join(root, file);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return [];
      return [{ file, text: readFileSync(absolute, "utf8") }];
    });
}

function workspaceRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("must run inside the Oliphaunt git checkout");
  }
  return result.stdout.trim();
}

function main() {
  const violations = localeSensitiveOrderingViolations(
    repositoryReleaseCriticalSources(workspaceRoot()),
  );
  if (violations.length > 0) {
    const details = violations
      .map(({ file, line, kind }) => `${file}:${line}: ${kind}`)
      .join("\n");
    throw new Error(
      `release-critical ordering must use an ordinal comparator:\n${details}\n`
      + "Serialized manifests, inventories, artifact plans, and policy identities must not depend on host locale or ICU data.",
    );
  }
  console.log("release-critical ordinal ordering boundary passed");
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`${TOOL}: ${error.message ?? String(error)}`);
    process.exit(1);
  }
}
