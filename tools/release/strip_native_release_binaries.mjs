#!/usr/bin/env bun
import { readdir, stat } from "node:fs/promises";
import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const MACHO_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);

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
    left.name.localeCompare(right.name),
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

function stripToolFor(native) {
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
  if (native.archive && path.extname(native.path).toLowerCase() === ".lib") {
    const tool = envTool("OLIPHAUNT_PE_STRIP", "OLIPHAUNT_STRIP") ?? findTool("llvm-strip", "strip");
    if (!tool) {
      console.error(`skippedPeNativeFile=${native.path}`);
      return undefined;
    }
    return { tool, flags: ["--strip-debug"] };
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

async function stripNative(native) {
  const before = (await stat(native.path)).size;
  const command = stripToolFor(native);
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

const roots = Bun.argv.slice(2);
if (roots.length === 0) {
  fail("usage: strip_native_release_binaries.mjs <path> [path...]");
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
  if (await stripNative(native)) {
    changed += 1;
  }
}

console.log(`strippedNativeFiles=${changed}`);
console.log(`checkedNativeFiles=${nativeFiles.length}`);
