#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseProfilePackageLicense } from "../../../../tools/release/release-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE_ROOT = path.join(ROOT, "src/runtimes/node-direct");
const EXPECTED_LICENSE = releaseProfilePackageLicense("source-sdk").spdx;
const NOTICE_MEMBERS = Object.freeze(["LICENSE", "THIRD_PARTY_NOTICES.md"]);
const PLATFORM_PACKAGES = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "@oliphaunt/node-direct-darwin-arm64",
    target: "macos-arm64",
  }),
  "linux-arm64-gnu": Object.freeze({
    name: "@oliphaunt/node-direct-linux-arm64-gnu",
    target: "linux-arm64-gnu",
  }),
  "linux-x64-gnu": Object.freeze({
    name: "@oliphaunt/node-direct-linux-x64-gnu",
    target: "linux-x64-gnu",
  }),
  "win32-x64-msvc": Object.freeze({
    name: "@oliphaunt/node-direct-win32-x64-msvc",
    target: "windows-x64-msvc",
  }),
});

function readManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`${path.relative(ROOT, file)} must contain valid JSON: ${cause.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${path.relative(ROOT, file)} must contain a JSON object`);
  }
  return manifest;
}

function assertCarrierManifest(manifest, file, expectedName) {
  const label = path.relative(ROOT, file);
  if (manifest.name !== expectedName) {
    throw new Error(`${label} must identify ${expectedName}, got ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.license !== EXPECTED_LICENSE) {
    throw new Error(
      `${label} must declare the adapter-only license ${EXPECTED_LICENSE}, got ${JSON.stringify(manifest.license)}`,
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${label} must declare an npm files allowlist`);
  }
  if (
    manifest.files.some((member) => typeof member !== "string" || member.length === 0)
    || new Set(manifest.files).size !== manifest.files.length
  ) {
    throw new Error(`${label} npm files allowlist must contain unique non-empty strings`);
  }
  for (const member of NOTICE_MEMBERS) {
    if (!manifest.files.includes(member)) {
      throw new Error(`${label} npm files allowlist must include ${member}`);
    }
  }
  if (manifest.files.some((member) => typeof member === "string" && member.startsWith("THIRD_PARTY_LICENSES"))) {
    throw new Error(`${label} must not claim embedded runtime license components`);
  }
}

export function assertNodeDirectPackageMetadata() {
  const sourceFile = path.join(PACKAGE_ROOT, "package.json");
  assertCarrierManifest(readManifest(sourceFile), sourceFile, "@oliphaunt/node-direct");

  for (const [directory, expected] of Object.entries(PLATFORM_PACKAGES)) {
    const file = path.join(PACKAGE_ROOT, "packages", directory, "package.json");
    const manifest = readManifest(file);
    assertCarrierManifest(manifest, file, expected.name);
    if (manifest.oliphaunt?.target !== expected.target) {
      throw new Error(
        `${path.relative(ROOT, file)} must declare oliphaunt.target=${expected.target}, got ${JSON.stringify(manifest.oliphaunt?.target)}`,
      );
    }
  }
}

function main() {
  try {
    assertNodeDirectPackageMetadata();
  } catch (error) {
    console.error(`check-node-direct-package-metadata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log("oliphaunt-node-direct package metadata validated");
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main();
}
