#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../../dev/capture-command-output.mjs";

const ROOT = path.resolve(import.meta.dir, "../../..");

function assert(condition, message) {
  if (!condition) throw new Error(`repository-semantics.mjs: ${message}`);
}

function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function stableVersion(value, label) {
  assert(typeof value === "string" && /^\d+[.]\d+[.]\d+$/u.test(value), `${label} must pin x.y.z`);
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function versionSatisfiesNodeBand(version, range) {
  const [major, minor] = stableVersion(version, ".prototools node");
  const match = /^>=([0-9]+)[.]([0-9]+) <([0-9]+)$/u.exec(range);
  if (match === null) return false;
  const lowerMajor = Number.parseInt(match[1], 10);
  const lowerMinor = Number.parseInt(match[2], 10);
  const upperMajor = Number.parseInt(match[3], 10);
  return (major > lowerMajor || (major === lowerMajor && minor >= lowerMinor)) && major < upperMajor;
}

function readToml(file) {
  return Bun.TOML.parse(readFileSync(path.join(ROOT, file), "utf8"));
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
}

function trackedFiles() {
  const result = captureCommandOutput("git", ["ls-files", "-z"], {
    allowEmptyOutput: true,
    cwd: ROOT,
    label: "git ls-files",
    stdoutTerminator: "\0",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim());
  }
  return result.stdout.split("\0").filter(Boolean);
}

function main() {
  assert(Bun.argv.length === 3 && Bun.argv[2] === "tooling", "usage: repository-semantics.mjs tooling");

  const pins = object(readToml(".prototools"), ".prototools");
  const packageJson = object(readJson("package.json"), "package.json");
  const pnpm = object(Bun.YAML.parse(readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8")), "pnpm-workspace.yaml");

  assert(packageJson.packageManager === `pnpm@${pins.pnpm}`, "packageManager must match the pinned pnpm version");
  assert(packageJson.engines?.pnpm === pins.pnpm, "engines.pnpm must match the pinned pnpm version");
  assert(versionSatisfiesNodeBand(pins.node, packageJson.engines?.node), "the pinned Node version must satisfy engines.node");
  assert(pnpm.minimumReleaseAge >= 1440, "dependencies must age for at least one day before installation");
  assert(pnpm.nodeLinker === "isolated", "workspace dependencies must use isolated linking");
  for (const [dependency, allowed] of Object.entries(object(pnpm.allowBuilds, "pnpm allowBuilds"))) {
    assert(typeof allowed === "boolean", `pnpm allowBuilds.${dependency} must be explicit`);
  }

  const unsafeRootFallback = /git\s+rev-parse\s+--show-toplevel[^\n]*(?:\|\||or)\s+pwd/u;
  const unsafe = trackedFiles().filter((file) => {
    if (!/(?:[.]sh|[.]mjs|[.]js|[.]py)$/u.test(file)) return false;
    const absolute = path.join(ROOT, file);
    return existsSync(absolute) && unsafeRootFallback.test(readFileSync(absolute, "utf8"));
  });
  assert(unsafe.length === 0, `entrypoints must fail closed outside a checkout: ${unsafe.join(", ")}`);

  console.log("tooling safety checks passed");
}

try {
  main();
} catch (error) {
  console.error(error.message ?? String(error));
  process.exit(1);
}
