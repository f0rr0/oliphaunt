#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filesystemTreeRows,
  logicalTreeSha256,
  validateNativeClusterSeedManifest,
} from "./native-cluster-seed-contract.mjs";

const TOOL = "stage-native-cluster-seed.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("usage: stage-native-cluster-seed.mjs --runtime DIR --embedded-modules DIR --destination DIR --profile standard|icu [--icu-data DIR]");
    }
    if (values.has(key)) fail(`repeated argument ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--runtime", "--embedded-modules", "--destination", "--profile", "--icu-data"]);
  for (const key of values.keys()) if (!allowed.has(key)) fail(`unknown argument ${key}`);
  const runtime = values.get("--runtime");
  const embeddedModules = values.get("--embedded-modules");
  const destination = values.get("--destination");
  const profile = values.get("--profile");
  const icuData = values.get("--icu-data");
  if (!runtime || !embeddedModules || !destination || !["standard", "icu"].includes(profile)) {
    fail("runtime, embedded-modules, destination, and profile=standard|icu are required");
  }
  if (profile === "icu" && !icuData) fail("profile=icu requires --icu-data DIR");
  if (profile === "standard" && icuData) fail("profile=standard must not receive --icu-data");
  return Object.freeze({
    runtime: path.resolve(runtime),
    embeddedModules: path.resolve(embeddedModules),
    destination: path.resolve(destination),
    profile,
    icuData: icuData === undefined ? undefined : path.resolve(icuData),
  });
}

function requireDirectory(directory, label) {
  if (!existsSync(directory)) fail(`${label} does not exist: ${directory}`);
}

export function stageNativeClusterSeed(argv) {
  const args = parseArgs(argv);
  requireDirectory(args.runtime, "native runtime");
  requireDirectory(args.embeddedModules, "embedded modules");
  if (args.icuData !== undefined) requireDirectory(args.icuData, "ICU data");
  if (args.destination === path.parse(args.destination).root) fail("destination must not be a filesystem root");

  const scratch = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-cluster-seed-"));
  try {
    const output = path.join(scratch, "resources");
    const commandArgs = [
      "run", "-p", "oliphaunt-native-packaging", "--bin", "oliphaunt-resources", "--locked", "--",
      "--output", output,
      "--force",
    ];
    if (args.profile === "icu") commandArgs.push("--runtime-feature", "icu");
    const env = {
      ...process.env,
      OLIPHAUNT_INSTALL_DIR: args.runtime,
      OLIPHAUNT_EMBEDDED_MODULE_DIR: args.embeddedModules,
    };
    delete env.ICU_DATA;
    delete env.OLIPHAUNT_INTERNAL_ICU_READY;
    delete env.OLIPHAUNT_ICU_DATA_DIR;
    if (args.icuData !== undefined) env.OLIPHAUNT_ICU_DATA_DIR = args.icuData;
    const result = spawnSync("cargo", commandArgs, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(`native cluster-seed producer failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    const source = path.join(output, "oliphaunt/cluster-seed");
    const manifestPath = path.join(source, "manifest.properties");
    const manifest = readFileSync(manifestPath);
    const expectedRole = `cluster-seed-${args.profile}`;
    if (!existsSync(path.join(source, "files/PG_VERSION"))
      || !existsSync(path.join(source, "files/global/pg_control"))
    ) {
      fail(`producer output does not satisfy ${expectedRole}`);
    }
    validateNativeClusterSeedManifest(manifest, args.profile, {
      icuDataTreeSha256: args.icuData === undefined
        ? undefined
        : logicalTreeSha256(filesystemTreeRows(args.icuData)),
      label: manifestPath,
    });
    rmSync(args.destination, { recursive: true, force: true });
    cpSync(source, args.destination, { recursive: true, errorOnExist: true });
    return Object.freeze({ destination: args.destination, profile: args.profile });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = stageNativeClusterSeed(process.argv.slice(2));
  console.log(`clusterSeed=${result.destination}`);
  console.log(`catalogProfile=${result.profile}`);
}
