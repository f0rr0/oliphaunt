#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NATIVE_CLUSTER_SEED_TARGETS,
  bindNativeClusterSeedManifest,
  validateNativeClusterSeedDirectory,
} from "./native-cluster-seed-contract.mjs";

const TOOL = "stage-native-cluster-seed.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_SYSTEM_COLLATION_DISCOVERY_ENV =
  "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY";
const SKIP_ICU_COLLATION_DISCOVERY_ENV =
  "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("usage: stage-native-cluster-seed.mjs --runtime DIR --destination DIR --target TARGET --profile standard|icu [--icu-data DIR]");
    }
    if (values.has(key)) fail(`repeated argument ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--runtime", "--destination", "--target", "--profile", "--icu-data"]);
  for (const key of values.keys()) if (!allowed.has(key)) fail(`unknown argument ${key}`);
  const runtime = values.get("--runtime");
  const destination = values.get("--destination");
  const target = values.get("--target");
  const profile = values.get("--profile");
  const icuData = values.get("--icu-data");
  if (!runtime || !destination || !target || !["standard", "icu"].includes(profile)) {
    fail("runtime, destination, target, and profile=standard|icu are required");
  }
  if (profile === "icu" && !icuData) fail("profile=icu requires --icu-data DIR");
  if (profile === "standard" && icuData) fail("profile=standard must not receive --icu-data");
  return Object.freeze({
    runtime: path.resolve(runtime),
    destination: path.resolve(destination),
    target,
    profile,
    icuData: icuData === undefined ? undefined : path.resolve(icuData),
  });
}

function requireDirectory(directory, label) {
  if (!existsSync(directory)) fail(`${label} does not exist: ${directory}`);
}

export function nativeClusterSeedProducerArgs(output, profile) {
  const args = [
    "run", "-p", "oliphaunt-native-packaging", "--bin", "oliphaunt-resources", "--locked", "--",
    "--output", output,
    "--force",
    "--mode", "native-server",
  ];
  if (profile === "icu") args.push("--runtime-feature", "icu");
  return args;
}

export function nativeClusterSeedProducerEnvironment(target, profile) {
  if (!NATIVE_CLUSTER_SEED_TARGETS.includes(target)) {
    fail(`unsupported native cluster-seed target ${JSON.stringify(target)}`);
  }
  if (!["standard", "icu"].includes(profile)) {
    fail(`unsupported native cluster-seed profile ${JSON.stringify(profile)}`);
  }
  return Object.freeze({
    // Distributed seeds must not depend on the release runner's locale list.
    skipSystemCollationDiscovery: true,
    // The standard profile also omits optional ICU catalog rows.
    skipIcuCollationDiscovery: profile === "standard",
  });
}

export function stageNativeClusterSeed(argv) {
  const args = parseArgs(argv);
  requireDirectory(args.runtime, "native runtime");
  if (args.icuData !== undefined) requireDirectory(args.icuData, "ICU data");
  if (args.destination === path.parse(args.destination).root) fail("destination must not be a filesystem root");

  const scratch = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-cluster-seed-"));
  try {
    const output = path.join(scratch, "resources");
    const commandArgs = nativeClusterSeedProducerArgs(output, args.profile);
    const env = {
      ...process.env,
      OLIPHAUNT_INSTALL_DIR: args.runtime,
    };
    delete env.OLIPHAUNT_EMBEDDED_MODULE_DIR;
    delete env.ICU_DATA;
    delete env.OLIPHAUNT_INTERNAL_ICU_READY;
    delete env[SKIP_SYSTEM_COLLATION_DISCOVERY_ENV];
    delete env[SKIP_ICU_COLLATION_DISCOVERY_ENV];
    delete env.OLIPHAUNT_ICU_DATA_DIR;
    if (args.icuData !== undefined) env.OLIPHAUNT_ICU_DATA_DIR = args.icuData;
    const producerEnvironment = nativeClusterSeedProducerEnvironment(args.target, args.profile);
    if (producerEnvironment.skipSystemCollationDiscovery) {
      env[SKIP_SYSTEM_COLLATION_DISCOVERY_ENV] = "1";
    }
    if (producerEnvironment.skipIcuCollationDiscovery) {
      env[SKIP_ICU_COLLATION_DISCOVERY_ENV] = "1";
    }
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
    const manifest = bindNativeClusterSeedManifest(readFileSync(manifestPath), args.target, args.profile);
    writeFileSync(manifestPath, manifest);
    validateNativeClusterSeedDirectory(source, args.profile, {
      target: args.target,
      icuData: args.icuData,
    });
    rmSync(args.destination, { recursive: true, force: true });
    cpSync(source, args.destination, { recursive: true, errorOnExist: true });
    return Object.freeze({ destination: args.destination, profile: args.profile, target: args.target });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = stageNativeClusterSeed(process.argv.slice(2));
  console.log(`clusterSeed=${result.destination}`);
  console.log(`catalogProfile=${result.profile}`);
  console.log(`target=${result.target}`);
}
