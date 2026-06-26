#!/usr/bin/env bun
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const TOOL = "optimize_native_runtime_payload.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = join(ROOT, "tools/release/native-runtime-payload-policy.json");
const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));

export const NATIVE_RUNTIME_TOOL_STEMS = Object.freeze([...POLICY.nativeRuntimeToolStems]);
export const NATIVE_TOOLS_TOOL_STEMS = Object.freeze([...POLICY.nativeToolsToolStems]);
export const NATIVE_PACKAGED_TOOL_STEMS = Object.freeze([
  ...NATIVE_RUNTIME_TOOL_STEMS,
  ...NATIVE_TOOLS_TOOL_STEMS,
]);

const DEV_RUNTIME_DIRS = Object.freeze([...POLICY.devRuntimeDirs]);
const DEV_RUNTIME_SUFFIXES = Object.freeze([...POLICY.devRuntimeSuffixes]);
const WINDOWS_DEV_RUNTIME_SUFFIXES = Object.freeze([...POLICY.windowsDevRuntimeSuffixes]);
const MACHO_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);
const ELF_DEBUG_SECTION = /\]\s+\.(debug_[^\s]+|symtab|strtab)\s/g;

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function rel(path) {
  const resolved = resolve(String(path));
  const relativePath = relative(ROOT, resolved);
  if (!relativePath || relativePath.startsWith("..") || relativePath === resolved) {
    return resolved.split(sep).join("/");
  }
  return relativePath.split(sep).join("/");
}

function exists(path) {
  return existsSync(path);
}

function isDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function readPrefix(path, size = 8) {
  const buffer = Buffer.alloc(size);
  let fd;
  try {
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    fail(`failed to read ${path}: ${error.message}`);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function classifyNativeFile(path) {
  const prefix = readPrefix(path);
  if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return { path, kind: "elf", archive: false };
  }
  if (MACHO_MAGICS.has(prefix.subarray(0, 4).toString("hex"))) {
    return { path, kind: "macho", archive: false };
  }
  if (prefix.subarray(0, 2).toString("ascii") === "MZ") {
    return { path, kind: "pe", archive: false };
  }
  if (prefix.subarray(0, 8).toString("ascii") === "!<arch>\n") {
    return { path, kind: "archive", archive: true };
  }
  return null;
}

export function isWindowsTarget(target, runtimeDir = null) {
  if (target && target.startsWith("windows-")) {
    return true;
  }
  if (!runtimeDir) {
    return false;
  }
  const binDir = join(runtimeDir, "bin");
  return NATIVE_PACKAGED_TOOL_STEMS.some((stem) => isFile(join(binDir, `${stem}.exe`)));
}

export function requiredRuntimeTools(target, runtimeDir = null) {
  if (isWindowsTarget(target, runtimeDir)) {
    return NATIVE_RUNTIME_TOOL_STEMS.map((stem) => `${stem}.exe`);
  }
  return [...NATIVE_RUNTIME_TOOL_STEMS];
}

export function requiredToolsPackageTools(target, runtimeDir = null) {
  if (isWindowsTarget(target, runtimeDir)) {
    return NATIVE_TOOLS_TOOL_STEMS.map((stem) => `${stem}.exe`);
  }
  return [...NATIVE_TOOLS_TOOL_STEMS];
}

export function packagedRuntimeTools(target, runtimeDir = null) {
  if (isWindowsTarget(target, runtimeDir)) {
    return NATIVE_PACKAGED_TOOL_STEMS.map((stem) => `${stem}.exe`);
  }
  return [...NATIVE_PACKAGED_TOOL_STEMS];
}

export function runtimeToolsForSet(target, runtimeDir = null, toolSet = "packaged") {
  if (toolSet === "runtime") {
    return requiredRuntimeTools(target, runtimeDir);
  }
  if (toolSet === "tools") {
    return requiredToolsPackageTools(target, runtimeDir);
  }
  return packagedRuntimeTools(target, runtimeDir);
}

export function requiredRuntimeMemberPaths(target, prefix) {
  return requiredRuntimeTools(target).map((tool) => `${prefix.replace(/\/+$/, "")}/${tool}`);
}

export function requiredToolsMemberPaths(target, prefix) {
  return requiredToolsPackageTools(target).map((tool) => `${prefix.replace(/\/+$/, "")}/${tool}`);
}

function runtimeDirFor(root) {
  for (const candidate of [
    join(root, "runtime"),
    join(root, "oliphaunt", "runtime", "files"),
  ]) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  if (isDirectory(join(root, "bin")) && (isDirectory(join(root, "share")) || isDirectory(join(root, "lib")))) {
    return root;
  }
  return null;
}

function removePath(path) {
  rmSync(path, { recursive: true, force: true });
}

function walk(root, { includeDirs = false } = {}) {
  if (!isDirectory(root)) {
    return [];
  }
  const results = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (includeDirs) {
          results.push(path);
        }
        visit(path);
      } else if (stat.isFile()) {
        results.push(path);
      }
    }
  };
  visit(root);
  return results.sort();
}

function pruneEmptyDirs(root) {
  for (const path of walk(root, { includeDirs: true }).filter(isDirectory).sort().reverse()) {
    try {
      rmdirSync(path);
    } catch {
      // Directory is not empty or disappeared while pruning.
    }
  }
}

function posixRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function isDevRuntimeFile(relativePath, { windows }) {
  const name = relativePath.split("/").pop().toLowerCase();
  if (DEV_RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return windows && WINDOWS_DEV_RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function pruneRuntimePayload(root, target = null, { toolSet = "packaged" } = {}) {
  const runtimeDir = runtimeDirFor(root);
  if (!runtimeDir) {
    return;
  }

  const windows = isWindowsTarget(target, runtimeDir);
  const requiredTools = new Set(runtimeToolsForSet(target, runtimeDir, toolSet));
  const binDir = join(runtimeDir, "bin");
  if (isDirectory(binDir)) {
    for (const name of readdirSync(binDir).sort()) {
      const path = join(binDir, name);
      if (windows) {
        if (name.toLowerCase().endsWith(".exe") && !requiredTools.has(name)) {
          removePath(path);
        }
      } else if (!requiredTools.has(name)) {
        removePath(path);
      }
    }
  }

  if (toolSet === "tools" && isDirectory(runtimeDir)) {
    for (const name of readdirSync(runtimeDir).sort()) {
      if (name !== "bin") {
        removePath(join(runtimeDir, name));
      }
    }
  }

  for (const relativePath of DEV_RUNTIME_DIRS) {
    removePath(join(runtimeDir, ...relativePath.split("/")));
  }

  for (const path of walk(runtimeDir, { includeDirs: true }).sort().reverse()) {
    if (isDirectory(path) && path.endsWith(".dSYM")) {
      removePath(path);
      continue;
    }
    if (!isFile(path)) {
      continue;
    }
    const relativePath = posixRelative(runtimeDir, path);
    if (isDevRuntimeFile(relativePath, { windows })) {
      removePath(path);
    }
  }

  pruneEmptyDirs(runtimeDir);
}

function which(command) {
  const pathEnv = process.env.PATH ?? "";
  const extensions = platform() === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(platform() === "win32" ? ";" : ":")) {
    if (!dir) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function stripSupportedForTarget(target) {
  if (!target) {
    return true;
  }
  if (target.startsWith("linux-") || target.startsWith("android-")) {
    return platform() === "linux";
  }
  if (target.startsWith("macos-") || target.startsWith("ios-")) {
    return platform() === "darwin";
  }
  if (target.startsWith("windows-")) {
    return Boolean(
      process.env.OLIPHAUNT_PE_STRIP ||
        process.env.OLIPHAUNT_STRIP ||
        which("llvm-strip") ||
        platform() === "win32",
    );
  }
  return true;
}

function stripPayload(root) {
  const result = spawnSync(process.execPath, ["tools/release/strip_native_release_binaries.mjs", root], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`failed to strip native payload under ${rel(root)}`);
  }
}

function fileOutput(path) {
  const fileTool = which("file");
  if (!fileTool) {
    return null;
  }
  const result = spawnSync(fileTool, [path], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

function elfDebugErrors(path) {
  const readelf = which("readelf");
  if (readelf) {
    const result = spawnSync(readelf, ["-S", path], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      return [`${rel(path)} could not be inspected with readelf: ${result.stderr.trim()}`];
    }
    const sections = new Set();
    for (const match of result.stdout.matchAll(ELF_DEBUG_SECTION)) {
      sections.add(match[1]);
    }
    return [...sections].sort().map((section) => `${rel(path)} contains unstripped ELF section .${section}`);
  }

  const output = fileOutput(path);
  if (output && (output.includes("not stripped") || output.includes("with debug_info"))) {
    return [`${rel(path)} appears to contain unstripped ELF debug/symbol data`];
  }
  return [];
}

function validateNativeFiles(root) {
  const errors = [];
  for (const path of walk(root)) {
    const native = classifyNativeFile(path);
    if (!native) {
      continue;
    }
    if (native.kind === "elf" && !native.archive) {
      errors.push(...elfDebugErrors(path));
    }
  }
  return errors;
}

function validateRuntimeTree(root, target, requireRuntime, { toolSet = "packaged" } = {}) {
  const errors = [];
  const runtimeDir = runtimeDirFor(root);
  if (!runtimeDir) {
    if (requireRuntime) {
      errors.push(`${rel(root)} is missing a runtime tree`);
    }
    return errors;
  }

  const windows = isWindowsTarget(target, runtimeDir);
  const requiredTools = new Set(runtimeToolsForSet(target, runtimeDir, toolSet));
  const binDir = join(runtimeDir, "bin");
  if (requireRuntime && !isDirectory(binDir)) {
    errors.push(`${rel(runtimeDir)} is missing bin`);
  }
  if (isDirectory(binDir)) {
    for (const tool of [...requiredTools].sort()) {
      const path = join(binDir, tool);
      if (!isFile(path)) {
        errors.push(`${rel(runtimeDir)} is missing required runtime tool bin/${tool}`);
        continue;
      }
      if (!windows) {
        try {
          accessSync(path, constants.X_OK);
        } catch {
          errors.push(`${rel(path)} must be executable`);
        }
      }
    }
    for (const name of readdirSync(binDir).sort()) {
      const path = join(binDir, name);
      if (windows) {
        if (name.toLowerCase().endsWith(".exe") && !requiredTools.has(name)) {
          errors.push(`${rel(path)} is an extra Windows runtime executable`);
        }
      } else if (!requiredTools.has(name)) {
        errors.push(`${rel(path)} is an extra runtime tool`);
      }
    }
  }

  if (toolSet === "tools" && isDirectory(runtimeDir)) {
    const allowed = new Set([...requiredTools].map((tool) => `bin/${tool}`));
    for (const path of walk(runtimeDir)) {
      const relativePath = posixRelative(runtimeDir, path);
      if (!allowed.has(relativePath)) {
        errors.push(`${rel(path)} is not part of the native tools payload`);
      }
    }
  }

  for (const relativePath of DEV_RUNTIME_DIRS) {
    const path = join(runtimeDir, ...relativePath.split("/"));
    if (exists(path)) {
      errors.push(`${rel(path)} is a development-only runtime path`);
    }
  }

  for (const path of walk(runtimeDir, { includeDirs: true })) {
    if (isDirectory(path) && path.endsWith(".dSYM")) {
      errors.push(`${rel(path)} is a development-only debug symbol bundle`);
      continue;
    }
    if (!isFile(path)) {
      continue;
    }
    const relativePath = posixRelative(runtimeDir, path);
    if (isDevRuntimeFile(relativePath, { windows })) {
      errors.push(`${rel(path)} is a development-only runtime file`);
    }
  }

  return errors;
}

export function validatePayload(root, target = null, { requireRuntime = true, toolSet = "packaged" } = {}) {
  const errors = [
    ...validateRuntimeTree(root, target, requireRuntime, { toolSet }),
    ...validateNativeFiles(root),
  ];
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    fail(`${rel(root)} is not an optimized native runtime payload`);
  }
}

export function optimizePayload(
  root,
  target = null,
  { strip = "auto", requireRuntime = true, toolSet = "packaged" } = {},
) {
  pruneRuntimePayload(root, target, { toolSet });
  const shouldStrip = strip === true || (strip === "auto" && stripSupportedForTarget(target));
  if (shouldStrip) {
    stripPayload(root);
  }
  validatePayload(root, target, { requireRuntime, toolSet });
}

function usage() {
  return `Usage: tools/release/optimize_native_runtime_payload.mjs <root> [options]

Prune, strip, and validate liboliphaunt native runtime payloads.

Options:
  --target <target>           Release target id.
  --check                     Validate without mutating the payload.
  --no-strip                  Prune but skip native binary stripping before validation.
  --allow-missing-runtime     Validate native files when the archive is library-only.
  --tool-set <set>            packaged, runtime, or tools. Default: packaged.
  --help                      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    root: null,
    target: null,
    check: false,
    noStrip: false,
    allowMissingRuntime: false,
    toolSet: "packaged",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--target") {
      args.target = argv[++index];
      if (!args.target) {
        fail("--target requires a value");
      }
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--no-strip") {
      args.noStrip = true;
      continue;
    }
    if (arg === "--allow-missing-runtime") {
      args.allowMissingRuntime = true;
      continue;
    }
    if (arg === "--tool-set") {
      args.toolSet = argv[++index];
      if (!["packaged", "runtime", "tools"].includes(args.toolSet)) {
        fail("--tool-set must be one of: packaged, runtime, tools");
      }
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    }
    if (args.root) {
      fail(`unexpected positional argument: ${arg}`);
    }
    args.root = arg;
  }
  if (!args.root) {
    console.error(usage());
    process.exit(2);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = resolve(args.root);
  if (!exists(root)) {
    fail(`payload root does not exist: ${root}`);
  }
  if (args.check) {
    validatePayload(root, args.target, {
      requireRuntime: !args.allowMissingRuntime,
      toolSet: args.toolSet,
    });
    return;
  }
  optimizePayload(root, args.target, {
    strip: args.noStrip ? false : "auto",
    requireRuntime: !args.allowMissingRuntime,
    toolSet: args.toolSet,
  });
}

if (import.meta.main) {
  main();
}
