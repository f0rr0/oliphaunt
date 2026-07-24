#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releasePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";
import { requireSafeDirectoryChain } from "./release-directory-safety.mjs";

const TOOL = "source-only-sdk-package.mjs";
const SOURCE_NOTICE_OPTIONS = Object.freeze({ profile: "source-sdk" });
const SOURCE_LICENSE = releasePackageLicense().spdx;
const NOTICE_FILES = Object.freeze(["LICENSE", "THIRD_PARTY_NOTICES.md"]);

export const SOURCE_ONLY_NPM_PROFILES = Object.freeze({
  js: Object.freeze({
    name: "@oliphaunt/ts",
    scripts: Object.freeze({}),
  }),
  "react-native": Object.freeze({
    name: "@oliphaunt/react-native",
    scripts: Object.freeze({
      "package:verify-ios": "node ./tools/verify-ios-package.mjs --package-dir .",
    }),
  }),
});

function requireRegularFile(file, label) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    throw new Error(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  }
  return stat;
}

function readJson(file, label) {
  requireRegularFile(file, label);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`${label} must contain valid JSON: ${cause.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function checkedScripts(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} scripts contract must be an object`);
  }
  const scripts = {};
  for (const name of Object.keys(value).sort()) {
    const command = value[name];
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`${label} script ${JSON.stringify(name)} must be a non-empty string`);
    }
    scripts[name] = command;
  }
  return scripts;
}

function assertManifestContract(manifest, { name, scripts }, label) {
  if (manifest.name !== name) {
    throw new Error(`${label} must identify ${name}, got ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.license !== SOURCE_LICENSE) {
    throw new Error(`${label} must declare the source-only license ${SOURCE_LICENSE}, got ${JSON.stringify(manifest.license)}`);
  }
  const expectedScripts = checkedScripts(scripts, label);
  const actualScripts = manifest.scripts ?? {};
  if (
    !actualScripts
    || typeof actualScripts !== "object"
    || Array.isArray(actualScripts)
    || JSON.stringify(actualScripts) !== JSON.stringify(expectedScripts)
  ) {
    throw new Error(
      `${label} must contain only the publish-safe scripts ${JSON.stringify(expectedScripts)}, got ${JSON.stringify(actualScripts)}`,
    );
  }
  if (Object.hasOwn(manifest, "devDependencies")) {
    throw new Error(`${label} must not publish development-only dependencies`);
  }
}

function requireNoticeAllowlist(manifest, label) {
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${label} must declare an npm files allowlist`);
  }
  for (const member of NOTICE_FILES) {
    if (!manifest.files.includes(member)) {
      throw new Error(`${label} npm files allowlist must include ${member}`);
    }
  }
}

function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  chmodSync(file, 0o644);
}

export function prepareSourceOnlyNpmPackage(packageDir, contract) {
  // Validate the complete lexical path before reading or rewriting package.json.
  // Notice staging enforces the same boundary, but it runs after sanitation.
  const directory = requireSafeDirectoryChain(packageDir, {
    label: "source-only npm package directory",
  });
  const packageJsonFile = path.join(directory, "package.json");
  const manifest = readJson(packageJsonFile, "source-only npm package manifest");
  const expectedScripts = checkedScripts(contract.scripts, contract.name);
  if (manifest.name !== contract.name) {
    throw new Error(
      `source-only npm package manifest must identify ${contract.name}, got ${JSON.stringify(manifest.name)}`,
    );
  }
  if (manifest.license !== SOURCE_LICENSE) {
    throw new Error(
      `source-only npm package manifest must declare ${SOURCE_LICENSE}, got ${JSON.stringify(manifest.license)}`,
    );
  }
  requireNoticeAllowlist(manifest, "source-only npm package manifest");
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (manifest.scripts?.[name] !== command) {
      throw new Error(
        `source-only npm package manifest is missing publish-safe script ${name}=${JSON.stringify(command)}`,
      );
    }
  }
  if (Object.keys(expectedScripts).length === 0) {
    delete manifest.scripts;
  } else {
    manifest.scripts = expectedScripts;
  }
  delete manifest.devDependencies;
  writeManifest(packageJsonFile, manifest);
  stageReleaseNotices(directory, SOURCE_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(directory, SOURCE_NOTICE_OPTIONS);
  assertManifestContract(manifest, contract, "staged source-only npm package manifest");
  return packageJsonFile;
}

function archiveJson(entries, member, label) {
  const entry = entries.get(member);
  if (!entry?.isFile || entry.isSymbolicLink) {
    throw new Error(`${label} is missing regular member ${member}`);
  }
  if ((entry.mode & 0o777) !== 0o644) {
    throw new Error(`${label} member ${member} must have mode 0644`);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(entry.data()).toString("utf8"));
  } catch (cause) {
    throw new Error(`${label} member ${member} must contain valid JSON: ${cause.message}`);
  }
  return parsed;
}

export function assertSourceOnlyNpmArchive(archive, contract) {
  const file = path.resolve(archive);
  const label = path.basename(file);
  assertReleaseNoticesInArchive(file, {
    ...SOURCE_NOTICE_OPTIONS,
    prefix: "package",
    label,
  });
  const entries = readPortableArchiveEntries(file);
  const manifest = archiveJson(entries, "package/package.json", label);
  assertManifestContract(manifest, contract, `${label} package.json`);
  requireNoticeAllowlist(manifest, `${label} package.json`);
  return manifest;
}

export function assertSourceOnlyJsrDirectory(packageDir, { name = "@oliphaunt/ts" } = {}) {
  const directory = path.resolve(packageDir);
  assertReleaseNoticesInDirectory(directory, SOURCE_NOTICE_OPTIONS);
  const packageManifest = readJson(path.join(directory, "package.json"), "JSR source package.json");
  assertManifestContract(packageManifest, SOURCE_ONLY_NPM_PROFILES.js, "JSR source package.json");
  const jsrManifest = readJson(path.join(directory, "jsr.json"), "JSR manifest");
  if (jsrManifest.name !== name) {
    throw new Error(`JSR manifest must identify ${name}, got ${JSON.stringify(jsrManifest.name)}`);
  }
  if (jsrManifest.license !== SOURCE_LICENSE) {
    throw new Error(`JSR manifest must declare ${SOURCE_LICENSE}, got ${JSON.stringify(jsrManifest.license)}`);
  }
  if (!Array.isArray(jsrManifest.publish?.include)) {
    throw new Error("JSR manifest must declare a publish.include allowlist");
  }
  for (const member of NOTICE_FILES) {
    if (!jsrManifest.publish.include.includes(member)) {
      throw new Error(`JSR publish.include must contain ${member}`);
    }
  }
  return jsrManifest;
}

function usage() {
  return [
    "usage:",
    `  ${TOOL} prepare-npm <js|react-native> <package-directory>`,
    `  ${TOOL} check-npm-archive <js|react-native> <package.tgz>`,
    `  ${TOOL} check-jsr-directory <package-directory>`,
  ].join("\n");
}

function profile(name) {
  const selected = SOURCE_ONLY_NPM_PROFILES[name];
  if (!selected) {
    throw new Error(`unsupported source-only npm package profile ${JSON.stringify(name)}`);
  }
  return selected;
}

function main(argv) {
  const [command, first, second, ...extra] = argv;
  if (command === "prepare-npm" && first && second && extra.length === 0) {
    prepareSourceOnlyNpmPackage(second, profile(first));
  } else if (command === "check-npm-archive" && first && second && extra.length === 0) {
    assertSourceOnlyNpmArchive(second, profile(first));
  } else if (command === "check-jsr-directory" && first && second === undefined) {
    assertSourceOnlyJsrDirectory(first);
  } else {
    throw new Error(usage());
  }
  console.log(`${TOOL}: ${command} passed`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`${TOOL}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
