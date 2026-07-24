#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PREFIX = "build-ci-target.mjs";
const TARGETS = new Set(["android-arm64-v8a", "android-x86_64", "ios-xcframework"]);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function formatArg(arg) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function run(command, args = [], { env = {} } = {}) {
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${formatArg(value)}`);
  console.log(`\n==> ${[...envArgs, command, ...args].map(formatArg).join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    fail(`${PREFIX}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function stagePath(root, stageRoot, source) {
  const absoluteSource = path.resolve(source);
  const relative = path.relative(root, absoluteSource);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`refusing to stage path outside repository: ${source}`);
  }
  if (!existsSync(absoluteSource)) {
    fail(`missing CI target artifact input: ${absoluteSource}`);
  }
  const destination = path.join(stageRoot, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  run("rsync", ["-a", "--delete", `${absoluteSource}/`, `${destination}/`]);
}

function buildLinuxRuntimeAssets() {
  run("src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh", ["--runtime-only"]);
}

function buildMacosRuntimeAssets() {
  run("src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh", ["--runtime-only"], {
    env: { OLIPHAUNT_BUILD_EXTENSIONS: process.env.OLIPHAUNT_BUILD_EXTENSIONS ?? "0" },
  });
}

const root = path.resolve(import.meta.dir, "../../../../..");
process.chdir(root);

const target = process.argv[2] ?? "";
if (!TARGETS.has(target)) {
  fail(
    "usage: src/runtimes/liboliphaunt/native/tools/build-ci-target.mjs [android-arm64-v8a|android-x86_64|ios-xcframework]",
    2,
  );
}

const mobileExtensions =
  process.env.OLIPHAUNT_CI_MOBILE_EXTENSIONS ?? process.env.OLIPHAUNT_MOBILE_STATIC_EXTENSIONS ?? "";
if (mobileExtensions !== "") {
  fail(
    "base liboliphaunt CI target builds do not accept selected extensions; publish exact extension artifacts through the extension artifact lane",
    2,
  );
}

const stageRoot = path.join(root, "target/liboliphaunt-native-ci", target);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

run("bun", ["tools/policy/fetch-sources.mjs", "native-runtime"]);

if (target === "android-arm64-v8a") {
  run("src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh", [], {
    env: {
      OLIPHAUNT_ANDROID_ABI: "arm64-v8a",
      OLIPHAUNT_ANDROID_ARM64_ROOT: path.join(root, "target/liboliphaunt-pg18-android-arm64"),
    },
  });
  buildLinuxRuntimeAssets();
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-pg18-android-arm64/out"));
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-pg18-linux-x64-gnu/install"));
} else if (target === "android-x86_64") {
  run("src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh", [], {
    env: {
      OLIPHAUNT_ANDROID_ABI: "x86_64",
      OLIPHAUNT_ANDROID_X86_64_ROOT: path.join(root, "target/liboliphaunt-pg18-android-x86_64"),
    },
  });
  buildLinuxRuntimeAssets();
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-pg18-android-x86_64/out"));
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-pg18-linux-x64-gnu/install"));
} else if (target === "ios-xcframework") {
  run("src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh");
  buildMacosRuntimeAssets();
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-ios-xcframework/out"));
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-ios-simulator/out"));
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-ios-device/out"));
  stagePath(root, stageRoot, path.join(root, "target/liboliphaunt-pg18/install"));
}

console.log(`\nStaged liboliphaunt CI target artifact: ${stageRoot}`);
