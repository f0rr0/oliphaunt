#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { extensionQualificationCandidates } from "./extension-qualification-candidates.mjs";
import { exactExtensionProducts } from "./release-artifact-targets.mjs";

const TOOL = "check-extension-publication-legal-clearance.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const SCHEMA = "oliphaunt-extension-publication-blocker-v2";
const SAFE_PRODUCT = /^[A-Za-z0-9._-]+$/u;
const SAFE_RESOLUTION = /^[A-Za-z0-9._-]+$/u;
const DEFER_RESOLUTION = "defer-product-from-publication-catalog";
const FORBIDDEN_DEFERRED_FILES = [
  ".release-semantic-inputs.json",
  "CHANGELOG.md",
  "VERSION",
  "release.toml",
];
const PUBLIC_GENERATED_JSON = [
  "src/extensions/generated/mobile/static-registry.json",
  "src/extensions/generated/sdk/js.json",
  "src/extensions/generated/sdk/kotlin.json",
  "src/extensions/generated/sdk/react-native.json",
  "src/extensions/generated/sdk/rust.json",
  "src/extensions/generated/sdk/swift.json",
  "src/extensions/generated/wasix/extensions.json",
  "src/sdks/kotlin/oliphaunt/src/generated/extensions.json",
  "src/sdks/react-native/src/generated/extensions.json",
];
const PUBLIC_GENERATED_TEXT = [
  "src/extensions/generated/mobile/static-extensions.tsv",
  "src/sdks/js/src/generated/extensions.ts",
  "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/extensions.properties",
  "src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/GeneratedExtensions.kt",
  "src/sdks/react-native/src/generated/extensions.ts",
  "src/sdks/rust/src/generated/extensions.rs",
];

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function readRegularText(root, file, label = rel(root, file)) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return readFileSync(file, "utf8");
}

function readToml(root, file, label = rel(root, file)) {
  try {
    return Bun.TOML.parse(readRegularText(root, file, label));
  } catch (cause) {
    fail(`${label} is not valid TOML: ${cause.message}`);
  }
}

function readJson(root, file, label = rel(root, file)) {
  try {
    return JSON.parse(readRegularText(root, file, label));
  } catch (cause) {
    fail(`${label} is not valid JSON: ${cause.message}`);
  }
}

function readYaml(root, file, label = rel(root, file)) {
  try {
    return Bun.YAML.parse(readRegularText(root, file, label));
  } catch (cause) {
    fail(`${label} is not valid YAML: ${cause.message}`);
  }
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertDeferredRepositoryBoundary(root, row, activeProducts) {
  const extensionRoot = path.join(root, "src/extensions/external", row.extensionId);
  for (const name of FORBIDDEN_DEFERRED_FILES) {
    if (existsSync(path.join(extensionRoot, name))) {
      fail(`${rel(root, path.join(extensionRoot, name))} is forbidden while publication is deferred`);
    }
  }

  const packagePath = `src/extensions/external/${row.extensionId}`;
  const config = object(readJson(root, path.join(root, "release-please-config.json")), "release-please-config.json");
  const packages = object(config.packages, "release-please-config.json packages");
  if (Object.hasOwn(packages, packagePath)) fail(`${packagePath} must not be registered with Release Please while deferred`);
  for (const [configuredPath, packageConfig] of Object.entries(packages)) {
    if (packageConfig?.component === row.product) {
      fail(`${configuredPath} reserves active Release Please component ${row.product} while it is deferred`);
    }
  }
  const manifest = object(readJson(root, path.join(root, ".release-please-manifest.json")), ".release-please-manifest.json");
  if (Object.hasOwn(manifest, packagePath)) fail(`${packagePath} must not be in .release-please-manifest.json while deferred`);

  const moonFile = path.join(extensionRoot, "moon.yml");
  const moon = object(readYaml(root, moonFile), rel(root, moonFile));
  const tags = Array.isArray(moon.tags) ? moon.tags : [];
  if (tags.includes("release-product")) fail(`${rel(root, moonFile)} must not carry release-product while deferred`);
  if (moon.project?.release !== undefined) fail(`${rel(root, moonFile)} must not declare project.release while deferred`);
  if (moon.tasks?.["assemble-release"] !== undefined) fail(`${rel(root, moonFile)} must not declare assemble-release while deferred`);
  if (activeProducts.has(row.product)) fail(`${row.product} is legally blocked but remains in the active release graph`);

  for (const relativePath of PUBLIC_GENERATED_JSON) {
    const file = path.join(root, relativePath);
    if (!existsSync(file)) continue;
    const serialized = JSON.stringify(readJson(root, file));
    if (serialized.includes(JSON.stringify(row.sqlName)) || serialized.includes(JSON.stringify(row.product))) {
      fail(`${relativePath} leaks deferred extension ${row.sqlName} into a public generated surface`);
    }
  }
  const token = new RegExp(`(^|[^A-Za-z0-9_])${row.sqlName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^A-Za-z0-9_]|$)`, "u");
  for (const relativePath of PUBLIC_GENERATED_TEXT) {
    const file = path.join(root, relativePath);
    if (existsSync(file) && token.test(readRegularText(root, file))) {
      fail(`${relativePath} leaks deferred extension ${row.sqlName} into a public generated surface`);
    }
  }

  const publicFeatureFiles = [
    "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
    "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
    "src/runtimes/liboliphaunt/wasix/crates/assets/build.rs",
  ];
  for (const relativePath of publicFeatureFiles) {
    const text = readRegularText(root, path.join(root, relativePath));
    if (text.includes(`extension-${row.sqlName.replaceAll("_", "-")}`) || text.includes(row.product)) {
      fail(`${relativePath} exposes deferred extension ${row.sqlName} as a public WASIX package feature`);
    }
  }
}

export function declaredExtensionPublicationBlockers({ root = ROOT, activeProducts = undefined } = {}) {
  const externalRoot = path.join(root, "src/extensions/external");
  const candidates = new Map(
    extensionQualificationCandidates({ root }).map((candidate) => [candidate.extensionId, candidate]),
  );
  const active = activeProducts === undefined
    ? new Set(root === ROOT ? exactExtensionProducts(TOOL) : [])
    : new Set(activeProducts);
  const rows = [];

  for (const entry of readdirSync(externalRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) continue;
    const blockerFile = path.join(externalRoot, entry.name, "publication-blocker.toml");
    if (!existsSync(blockerFile)) continue;
    const blocker = readToml(root, blockerFile);
    const expectedKeys = ["extension_id", "product", "reason", "resolutions", "schema", "sql_name", "status"];
    const actualKeys = Object.keys(blocker).sort(compareText);
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      fail(`${rel(root, blockerFile)} fields must be exactly ${expectedKeys.join(",")}`);
    }
    const candidate = candidates.get(entry.name);
    if (candidate === undefined) fail(`${rel(root, blockerFile)} has no canonical qualification candidate`);
    if (
      blocker.schema !== SCHEMA
      || blocker.status !== "deferred"
      || blocker.extension_id !== entry.name
      || blocker.extension_id !== candidate.extensionId
      || blocker.sql_name !== candidate.sqlName
      || typeof blocker.product !== "string"
      || !SAFE_PRODUCT.test(blocker.product)
      || !blocker.product.startsWith("oliphaunt-extension-")
      || blocker.reason !== candidate.blocker
      || !Array.isArray(blocker.resolutions)
      || blocker.resolutions.length === 0
      || blocker.resolutions.some((resolution) => typeof resolution !== "string" || !SAFE_RESOLUTION.test(resolution))
      || !blocker.resolutions.includes(DEFER_RESOLUTION)
      || new Set(blocker.resolutions).size !== blocker.resolutions.length
      || JSON.stringify(blocker.resolutions) !== JSON.stringify([...blocker.resolutions].sort(compareText))
    ) {
      fail(`${rel(root, blockerFile)} is not a canonical deferred publication contract`);
    }
    const row = Object.freeze({
      file: rel(root, blockerFile),
      extensionId: blocker.extension_id,
      product: blocker.product,
      reason: blocker.reason,
      resolutions: Object.freeze([...blocker.resolutions]),
      sqlName: blocker.sql_name,
      status: blocker.status,
    });
    assertDeferredRepositoryBoundary(root, row, active);
    rows.push(row);
  }
  if (rows.length !== candidates.size) {
    const declared = new Set(rows.map((row) => row.extensionId));
    const missing = [...candidates.keys()].filter((id) => !declared.has(id)).sort(compareText);
    fail(`qualification candidates are missing publication blockers: ${missing.join(", ")}`);
  }
  return Object.freeze(rows);
}

export function activeBlockedExtensionPublications(options = {}) {
  const active = new Set(options.activeProducts ?? exactExtensionProducts(TOOL));
  return Object.freeze(
    declaredExtensionPublicationBlockers({ ...options, activeProducts: active })
      .filter((row) => active.has(row.product)),
  );
}

// Backward-compatible name: callers asking for blocked publications now get
// only blockers that still intersect the active publication graph.
export function blockedExtensionPublications(options = {}) {
  return activeBlockedExtensionPublications(options);
}

export function assertExtensionPublicationLegalClearance(options = {}) {
  const declared = declaredExtensionPublicationBlockers(options);
  const active = new Set(options.activeProducts ?? exactExtensionProducts(TOOL));
  const blocked = declared.filter((row) => active.has(row.product));
  if (blocked.length > 0) {
    const detail = blocked.map((row) =>
      `${row.product} (${row.sqlName}): ${row.reason} Resolutions: ${row.resolutions.join(", ")}.`,
    ).join("\n");
    fail(`publication is legally blocked:\n${detail}`);
  }
  return declared;
}

if (import.meta.main) {
  try {
    const declared = assertExtensionPublicationLegalClearance();
    console.log(`${TOOL}: validated ${declared.length} deferred blocker(s); 0 active blocked publications`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
