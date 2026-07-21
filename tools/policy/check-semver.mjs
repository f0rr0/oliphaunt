#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { chdirRepoRoot, run } from "./lib/run-command.mjs";

const PREFIX = "check-semver.mjs";
const PRODUCT_PATH = "src/bindings/wasix-rust/crates/oliphaunt-wasix";
const MANIFEST_PATH = `${PRODUCT_PATH}/Cargo.toml`;
const RELEASE_MANIFEST = ".release-please-manifest.json";

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function parentReleaseVersion() {
  const parentManifest = commandOutput("git", ["show", `HEAD^:${RELEASE_MANIFEST}`]);
  return JSON.parse(parentManifest)[PRODUCT_PATH];
}

export function semverCheckPlan({
  currentVersion,
  initialVersion,
  parentVersion = null,
  publicTags = [],
}) {
  if (typeof currentVersion !== "string" || typeof initialVersion !== "string") {
    throw new Error("current and initial versions must be strings");
  }

  if (publicTags.length > 0) {
    if (currentVersion === "0.0.0") {
      throw new Error("public product tags exist while the release manifest still says 0.0.0");
    }
    return { kind: "registry" };
  }

  if (currentVersion === "0.0.0") {
    return { kind: "unreleased" };
  }

  if (currentVersion !== initialVersion || parentVersion !== "0.0.0") {
    throw new Error(
      "no public product tag exists, but this is not the exact first-release transition " +
        `(parent ${parentVersion ?? "<missing>"}, current ${currentVersion}, initial ${initialVersion})`,
    );
  }

  return { kind: "first-release", baselineRev: "HEAD^" };
}

function main() {
  chdirRepoRoot(PREFIX);

  const releaseManifest = readJson(RELEASE_MANIFEST);
  const releaseConfig = readJson("release-please-config.json");
  const productConfig = releaseConfig.packages?.[PRODUCT_PATH];
  if (!productConfig?.component) {
    throw new Error(`${PRODUCT_PATH} is missing a Release Please component`);
  }

  const currentVersion = releaseManifest[PRODUCT_PATH];
  const publicTags = commandOutput("git", [
    "tag",
    "--list",
    `${productConfig.component}-v[0-9]*`,
  ])
    .split("\n")
    .filter(Boolean);
  const parentVersion =
    publicTags.length === 0 && currentVersion !== "0.0.0" ? parentReleaseVersion() : null;
  const plan = semverCheckPlan({
    currentVersion,
    initialVersion: releaseConfig["initial-version"],
    parentVersion,
    publicTags,
  });

  if (plan.kind === "unreleased") {
    console.log(
      "SemVer check passed: oliphaunt-wasix is explicitly unreleased at 0.0.0 and has no public API baseline.",
    );
    return;
  }

  const args = [
    "semver-checks",
    "check-release",
    "--package",
    "oliphaunt-wasix",
    "--manifest-path",
    MANIFEST_PATH,
  ];
  if (plan.kind === "first-release") {
    args.push("--baseline-rev", plan.baselineRev);
  }
  run(PREFIX, "cargo", args);
}

if (import.meta.main) main();
