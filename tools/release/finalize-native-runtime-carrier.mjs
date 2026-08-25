#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bindNativeRuntimeResourceManifest,
  nativeRuntimeCarrierManifest,
  validateNativeRuntimeCarrier,
} from "./native-runtime-carrier-contract.mjs";

function fail(message) {
  throw new Error(`finalize-native-runtime-carrier.mjs: ${message}`);
}

function treeBytes(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) fail(`carrier tree must not contain symlinks: ${root}`);
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) fail(`carrier tree contains a special file: ${root}`);
  return readdirSync(root).reduce((total, name) => total + treeBytes(path.join(root, name)), 0);
}

function rewritePackageSizeReport(root) {
  const report = path.join(root, "package-size.tsv");
  const rows = readFileSync(report, "utf8").split(/\r?\n/u).filter(Boolean);
  if (rows.shift() !== "kind\tid\textensions\tfiles\tbytes") {
    fail(`${report} has an unsupported header`);
  }
  const retained = rows.filter((row) => !row.startsWith("package\t"));
  const runtime = treeBytes(path.join(root, "runtime/files"));
  const standard = treeBytes(path.join(root, "cluster-seed/files"));
  const icu = treeBytes(path.join(root, "cluster-seed-icu/files"));
  const staticRegistry = treeBytes(path.join(root, "static-registry"));
  const total = runtime + standard + icu + staticRegistry;
  writeFileSync(report, [
    "kind\tid\textensions\tfiles\tbytes",
    `package\ttotal\t-\t-\t${total}`,
    `package\truntime\t-\t-\t${runtime}`,
    `package\tcluster-seed\t-\t-\t${standard}`,
    `package\tcluster-seed-icu\t-\t-\t${icu}`,
    `package\tstatic-registry\t-\t-\t${staticRegistry}`,
    ...retained,
    "",
  ].join("\n"));
}

function materializeDesktopRuntimeManifest(runtimeSource, embeddedModules, target) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-runtime-manifest-"));
  try {
    const result = spawnSync("cargo", [
      "run", "-p", "oliphaunt-native-packaging", "--bin", "oliphaunt-resources", "--locked", "--",
      "--output", scratch,
      "--mode", "native-direct",
      "--force",
    ], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        OLIPHAUNT_INSTALL_DIR: runtimeSource,
        OLIPHAUNT_EMBEDDED_MODULE_DIR: embeddedModules,
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(`native-direct runtime manifest producer failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return bindNativeRuntimeResourceManifest(
      readFileSync(path.join(scratch, "oliphaunt/runtime/manifest.properties")),
      target,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function finalizeNativeRuntimeCarrier(
  root,
  target,
  icuData,
  { runtimeSource, embeddedModules } = {},
) {
  writeFileSync(path.join(root, "manifest.properties"), nativeRuntimeCarrierManifest(target));
  const runtimeManifest = path.join(root, "runtime/manifest.properties");
  if (existsSync(runtimeManifest)) {
    writeFileSync(
      runtimeManifest,
      bindNativeRuntimeResourceManifest(readFileSync(runtimeManifest), target),
    );
  } else if (runtimeSource !== undefined && embeddedModules !== undefined) {
    writeFileSync(
      runtimeManifest,
      materializeDesktopRuntimeManifest(runtimeSource, embeddedModules, target),
    );
  } else {
    fail(`${runtimeManifest} is missing`);
  }
  if (existsSync(path.join(root, "package-size.tsv"))) rewritePackageSizeReport(root);
  return validateNativeRuntimeCarrier(root, { icuData });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("usage: --root DIR --target TARGET --icu-data DIR [--runtime-source DIR --embedded-modules DIR]");
    }
    values.set(key, value);
  }
  const allowed = new Set(["--root", "--target", "--icu-data", "--runtime-source", "--embedded-modules"]);
  if ([...values.keys()].some((key) => !allowed.has(key))
    || !values.has("--root")
    || !values.has("--target")
    || !values.has("--icu-data")
    || values.has("--runtime-source") !== values.has("--embedded-modules")) {
    fail("usage: --root DIR --target TARGET --icu-data DIR [--runtime-source DIR --embedded-modules DIR]");
  }
  return {
    root: path.resolve(values.get("--root")),
    target: values.get("--target"),
    icuData: path.resolve(values.get("--icu-data")),
    runtimeSource: values.has("--runtime-source")
      ? path.resolve(values.get("--runtime-source"))
      : undefined,
    embeddedModules: values.has("--embedded-modules")
      ? path.resolve(values.get("--embedded-modules"))
      : undefined,
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = finalizeNativeRuntimeCarrier(args.root, args.target, args.icuData, args);
    console.log(`clusterSeedTarget=${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
