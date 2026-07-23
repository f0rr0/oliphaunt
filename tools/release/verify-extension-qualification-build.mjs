#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { qualificationCandidateSqlNamesForTarget } from "./extension-qualification-candidates.mjs";

const TOOL = "verify-extension-qualification-build.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function readRegular(file, label) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return { bytes: readFileSync(file), stat };
}

function safeRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\")) {
    fail(`${label} must be a portable relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label} contains an unsafe path component`);
  }
  return parts.join("/");
}

export function verifyWasixQualificationBuild({ assetRoot, sqlNames, target = "wasix-portable" }) {
  if (!Array.isArray(sqlNames) || sqlNames.some((name) => typeof name !== "string" || !name)) {
    fail("sqlNames must be a string list");
  }
  const manifestFile = path.join(assetRoot, "manifest.json");
  const manifestBytes = readRegular(manifestFile, `${target} qualification manifest`).bytes;
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch (cause) {
    fail(`${target} qualification manifest is invalid JSON: ${cause.message}`);
  }
  if (!Array.isArray(manifest.extensions)) fail(`${target} qualification manifest must define extensions`);
  const rows = new Map();
  for (const row of manifest.extensions) {
    const sqlName = row?.["sql-name"];
    if (typeof sqlName !== "string" || rows.has(sqlName)) {
      fail(`${target} qualification manifest has an invalid or repeated extension sql-name`);
    }
    rows.set(sqlName, row);
  }
  for (const sqlName of sqlNames) {
    const row = rows.get(sqlName);
    if (row === undefined) fail(`${target} qualification manifest is missing deferred candidate ${sqlName}`);
    if (row.stable !== false || row["smoke-status"]?.promoted !== false) {
      fail(`${target} deferred candidate ${sqlName} must remain stable=false and promoted=false`);
    }
    const archive = safeRelative(row.archive, `${target} ${sqlName} archive`);
    const archiveFile = path.join(assetRoot, ...archive.split("/"));
    const { bytes, stat } = readRegular(archiveFile, `${target} ${sqlName} archive`);
    if (stat.size === 0) fail(`${target} ${sqlName} archive must not be empty`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!SHA256.test(row.sha256) || row.sha256 !== digest || row.size !== stat.size) {
      fail(`${target} ${sqlName} archive size or SHA-256 does not match its qualification manifest`);
    }
  }
  return Object.freeze({ target, sqlNames: Object.freeze([...sqlNames]), manifest: manifestFile });
}

function parseArgs(argv) {
  let family;
  let target;
  let assetRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--family") family = argv[++index];
    else if (arg === "--target") target = argv[++index];
    else if (arg === "--asset-root") assetRoot = argv[++index];
    else fail(`unknown argument ${arg}`);
  }
  if (family !== "wasix" || !target || !assetRoot) {
    fail("usage: verify-extension-qualification-build.mjs --family wasix --target TARGET --asset-root PATH");
  }
  return { family, target, assetRoot: path.resolve(ROOT, assetRoot) };
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const sqlNames = qualificationCandidateSqlNamesForTarget(options.target, { family: options.family });
    if (sqlNames.length === 0) {
      console.log(`${TOOL}: no deferred candidates target ${options.target}`);
    } else {
      const result = verifyWasixQualificationBuild({
        assetRoot: options.assetRoot,
        sqlNames,
        target: options.target,
      });
      console.log(`${TOOL}: qualified ${result.sqlNames.join(",")} for ${result.target}`);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
