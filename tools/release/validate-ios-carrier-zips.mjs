#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPortableArchiveEntries } from "./portable-archive.mjs";

const PREFIX = "validate-ios-carrier-zips.mjs";
const XCFRAMEWORK_ROOT = /^[A-Za-z0-9][A-Za-z0-9._-]*[.]xcframework$/u;
// Match the shipped Apple carrier envelope. The shared verifier processes one
// expanded ZIP member at a time, so the logical aggregate bound does not become
// a same-sized in-memory allocation.
const IOS_ZIP_LIMITS = Object.freeze({
  format: "zip",
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 8192,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxExpandedBytes: 4 * 1024 * 1024 * 1024,
});

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function regularDirectory(directory, label) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${directory}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${directory}`);
  }
}

async function zipFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`carrier root contains a symbolic link: ${path.relative(root, file)}`);
      }
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".zip")) files.push(file);
        else if (entry.name.toLowerCase().endsWith(".zip")) {
          fail(`ZIP carrier names must use the canonical lowercase suffix: ${path.relative(root, file)}`);
        }
      } else {
        fail(`carrier root contains an unsupported filesystem entry: ${path.relative(root, file)}`);
      }
    }
  }
  files.sort((left, right) => compareText(path.relative(root, left), path.relative(root, right)));
  if (files.length === 0) fail(`found no ZIP carriers under ${root}`);
  return files;
}

function validateCarrierEntries(entries, archive) {
  const roots = new Set([...entries.keys()].map((name) => name.split("/", 1)[0]));
  if (roots.size !== 1) {
    fail(`${archive} must contain exactly one top-level XCFramework root; found ${[...roots].sort(compareText).join(",")}`);
  }
  const [root] = roots;
  if (!XCFRAMEWORK_ROOT.test(root) || root === "." || root === "..") {
    fail(`${archive} has unsafe or non-XCFramework top-level root ${JSON.stringify(root)}`);
  }
  if (entries.get(root)?.isDirectory !== true) {
    fail(`${archive} does not materialize ${root} as a directory`);
  }
  if (entries.get(`${root}/Info.plist`)?.isFile !== true) {
    fail(`${archive} XCFramework root lacks a regular Info.plist`);
  }
  return root;
}

export async function validateIosCarrierZipRoot(root) {
  const carrierRoot = path.resolve(root);
  await regularDirectory(carrierRoot, "carrier root");
  const archives = await zipFiles(carrierRoot);
  const validated = [];
  for (const archive of archives) {
    const entries = readPortableArchiveEntries(archive, IOS_ZIP_LIMITS);
    validated.push({
      archive,
      framework: validateCarrierEntries(entries, archive),
    });
  }
  return validated;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: validate-ios-carrier-zips.mjs --root DIRECTORY");
    return null;
  }
  if (argv.length !== 2 || argv[0] !== "--root" || argv[1].length === 0) {
    fail("usage: validate-ios-carrier-zips.mjs --root DIRECTORY");
  }
  return { root: argv[1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) return;
  const rows = await validateIosCarrierZipRoot(args.root);
  console.log(`${PREFIX}: validated ${rows.length} iOS XCFramework ZIP carrier(s) under ${path.resolve(args.root)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
