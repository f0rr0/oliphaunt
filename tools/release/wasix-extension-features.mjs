#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const TOOL = "wasix-extension-features.mjs";
const DEFAULT_MANIFEST = "target/oliphaunt-wasix/assets/manifest.json";
const SQL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(`${TOOL}: ${message}`);
}

export function promotedExtensionFeatures(manifest) {
  invariant(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest), "asset manifest must be an object");
  invariant(Array.isArray(manifest.extensions), "asset manifest must contain an extensions array");

  const features = [];
  const sqlNames = new Set();
  for (const extension of manifest.extensions) {
    invariant(extension !== null && typeof extension === "object" && !Array.isArray(extension), "extension manifest rows must be objects");
    if (extension["smoke-status"]?.promoted !== true) continue;

    const sqlName = extension["sql-name"];
    invariant(typeof sqlName === "string" && SQL_NAME_RE.test(sqlName), "promoted extensions must have a portable sql-name");
    invariant(!sqlNames.has(sqlName), `asset manifest repeats promoted extension ${sqlName}`);
    sqlNames.add(sqlName);
    features.push(`extension-${sqlName.replaceAll("_", "-")}`);
  }

  invariant(features.length > 0, "full WASIX evidence requires at least one promoted extension");
  return features.sort();
}

export function fullEvidenceFeatures(manifest) {
  return ["extensions", "tools", ...promotedExtensionFeatures(manifest)].join(",");
}

function main(argv) {
  if (argv.length > 1 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(`usage: ${TOOL} [ASSET_MANIFEST]`);
    return;
  }
  const file = argv[0] ?? DEFAULT_MANIFEST;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  console.log(fullEvidenceFeatures(manifest));
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
