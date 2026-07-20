#!/usr/bin/env bun
import { readdir, stat } from "node:fs/promises";
import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { WINDOWS_VC_RUNTIME_DLLS } from "./windows-vc-runtime-closure.mjs";

const MACHO_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);
const WINDOWS_VC_RUNTIME_SET = new Set(WINDOWS_VC_RUNTIME_DLLS);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  console.error(`strip_native_release_binaries.mjs: ${message}`);
  process.exit(2);
}

async function readPrefix(file, size = 8) {
  try {
    return Buffer.from(await Bun.file(file).slice(0, size).arrayBuffer());
  } catch (error) {
    fail(`failed to read ${file}: ${error.message}`);
  }
}

async function classify(file) {
  const prefix = await readPrefix(file);
  if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return { path: file, kind: "elf", archive: false };
  }
  if (MACHO_MAGICS.has(prefix.subarray(0, 4).toString("hex"))) {
    return { path: file, kind: "macho", archive: false };
  }
  if (prefix.subarray(0, 2).toString("utf8") === "MZ") {
    return { path: file, kind: "pe", archive: false };
  }
  if (prefix.toString("utf8") === "!<arch>\n") {
    return { path: file, kind: "archive", archive: true };
  }
  return undefined;
}

async function* iterFiles(roots) {
  for (const root of roots) {
    let info;
    try {
      info = await stat(root);
    } catch {
      fail(`input path does not exist: ${root}`);
    }
    if (info.isFile()) {
      yield root;
      continue;
    }
    if (!info.isDirectory()) {
      fail(`input path does not exist: ${root}`);
    }
    yield* iterDirectory(root);
  }
}

async function* iterDirectory(root) {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    compareText(left.name, right.name),
  );
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile()) {
      yield entryPath;
    } else if (entry.isDirectory()) {
      yield* iterDirectory(entryPath);
    }
  }
}

function envTool(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findTool(...names) {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
      : [""];
  for (const name of names) {
    if (name.includes("/") || name.includes("\\")) {
      if (isExecutable(name)) {
        return name;
      }
      continue;
    }
    for (const directory of paths) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function darwinStripTool() {
  const override = envTool("OLIPHAUNT_MACHO_STRIP", "OLIPHAUNT_STRIP");
  if (override) {
    return override;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("xcrun", ["--find", "strip"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return findTool("strip");
}

function androidStripTool() {
  const override = envTool("OLIPHAUNT_ANDROID_STRIP", "OLIPHAUNT_ELF_STRIP", "OLIPHAUNT_STRIP");
  if (override) {
    return override;
  }
  const ndk = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT;
  if (!ndk) {
    return undefined;
  }
  const hosts = {
    linux: ["linux-x86_64"],
    darwin: ["darwin-arm64", "darwin-x86_64"],
    win32: ["windows-x86_64"],
  }[process.platform] ?? [];
  for (const host of hosts) {
    const candidate = path.join(
      ndk,
      "toolchains",
      "llvm",
      "prebuilt",
      host,
      "bin",
      process.platform === "win32" ? "llvm-strip.exe" : "llvm-strip",
    );
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function stripToolFor(native, target) {
  if (native.archive && path.extname(native.path).toLowerCase() === ".lib") {
    console.error(`skippedMsvcImportLibrary=${native.path}`);
    return undefined;
  }
  if (target?.startsWith("android-") && native.kind === "elf") {
    const tool = androidStripTool();
    if (!tool) {
      fail(`missing Android llvm-strip for ${native.path}; set ANDROID_NDK_HOME or OLIPHAUNT_ANDROID_STRIP`);
    }
    return {
      tool,
      flags: native.archive ? ["--strip-debug"] : ["--strip-unneeded"],
    };
  }
  if (native.kind === "macho") {
    const tool = darwinStripTool();
    if (!tool) {
      fail(`missing strip tool for Mach-O file ${native.path}`);
    }
    return { tool, flags: ["-S"] };
  }
  if (native.kind === "pe") {
    const tool = envTool("OLIPHAUNT_PE_STRIP", "OLIPHAUNT_STRIP") ?? findTool("llvm-strip", "strip");
    if (!tool) {
      console.error(`skippedPeNativeFile=${native.path}`);
      return undefined;
    }
    return { tool, flags: ["--strip-debug"] };
  }
  if (native.archive && process.platform === "darwin") {
    const tool = darwinStripTool();
    if (!tool) {
      fail(`missing strip tool for archive ${native.path}`);
    }
    return { tool, flags: ["-S"] };
  }
  const tool = envTool("OLIPHAUNT_ELF_STRIP", "OLIPHAUNT_STRIP") ?? findTool("llvm-strip", "strip");
  if (!tool) {
    fail(`missing strip tool for ${native.kind} file ${native.path}`);
  }
  return {
    tool,
    flags: native.archive ? ["--strip-debug"] : ["--strip-unneeded"],
  };
}

async function stripNative(native, target) {
  if (native.kind === "pe" && WINDOWS_VC_RUNTIME_SET.has(path.basename(native.path).toLowerCase())) {
    console.error(`preservedAppLocalVcRuntime=${native.path}`);
    return false;
  }
  const before = (await stat(native.path)).size;
  const command = stripToolFor(native, target);
  if (command === undefined) {
    return false;
  }
  const result = spawnSync(command.tool, [...command.flags, native.path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    fail(`${command.tool} failed for ${native.path}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    fail(`${command.tool} failed for ${native.path}: ${stderr || `exit ${result.status}`}`);
  }
  return (await stat(native.path)).size !== before;
}

function parseArgs(argv) {
  const args = {
    target: undefined,
    roots: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      args.target = argv[++index];
      if (!args.target) {
        fail("--target requires a value");
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: strip_native_release_binaries.mjs [--target <target>] <path> [path...]");
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    }
    args.roots.push(arg);
  }
  return args;
}

const { target, roots } = parseArgs(Bun.argv.slice(2));
if (roots.length === 0) {
  fail("usage: strip_native_release_binaries.mjs [--target <target>] <path> [path...]");
}

const nativeFiles = [];
for await (const file of iterFiles(roots)) {
  const native = await classify(file);
  if (native !== undefined) {
    nativeFiles.push(native);
  }
}

let changed = 0;
for (const native of nativeFiles) {
  if (await stripNative(native, target)) {
    changed += 1;
  }
}

console.log(`strippedNativeFiles=${changed}`);
console.log(`checkedNativeFiles=${nativeFiles.length}`);
