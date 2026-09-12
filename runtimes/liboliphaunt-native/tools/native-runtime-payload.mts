#!/usr/bin/env bun
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  verifyWindowsVcRuntimeClosure,
} from '../../../tools/packaging/windows-vc-runtime-closure.mts';

const TOOL = 'native-runtime-payload.mts';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const POLICY_PATH = join(
  ROOT,
  'runtimes/liboliphaunt-native/tools/native-runtime-payload-policy.json',
);
const POLICY = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));

export const NATIVE_RUNTIME_TOOL_STEMS = Object.freeze([...POLICY.nativeRuntimeToolStems]);
export const NATIVE_TOOLS_TOOL_STEMS = Object.freeze([...POLICY.nativeToolsToolStems]);
export const WINDOWS_VC_RUNTIME_DLLS = Object.freeze([...POLICY.windowsVcRuntimeDlls]);
export const NATIVE_PACKAGED_TOOL_STEMS = Object.freeze([
  ...NATIVE_RUNTIME_TOOL_STEMS,
  ...NATIVE_TOOLS_TOOL_STEMS,
]);
export const SNOWBALL_STOPWORD_LANGUAGES = Object.freeze([
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'hungarian',
  'italian',
  'nepali',
  'norwegian',
  'portuguese',
  'russian',
  'spanish',
  'swedish',
  'turkish',
]);

const DEV_RUNTIME_DIRS = Object.freeze([...POLICY.devRuntimeDirs]);
const DEV_RUNTIME_SUFFIXES = Object.freeze([...POLICY.devRuntimeSuffixes]);
const WINDOWS_DEV_RUNTIME_SUFFIXES = Object.freeze([...POLICY.windowsDevRuntimeSuffixes]);
function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function rel(path) {
  const resolved = resolve(String(path));
  const relativePath = relative(ROOT, resolved);
  if (!relativePath || relativePath.startsWith('..') || relativePath === resolved) {
    return resolved.split(sep).join('/');
  }
  return relativePath.split(sep).join('/');
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

export function isWindowsTarget(target, runtimeDir = null) {
  if (target && target.startsWith('windows-')) {
    return true;
  }
  if (!runtimeDir) {
    return false;
  }
  const binDir = join(runtimeDir, 'bin');
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

export function runtimeToolsForSet(target, runtimeDir = null, toolSet = 'packaged') {
  if (toolSet === 'runtime') {
    return requiredRuntimeTools(target, runtimeDir);
  }
  if (toolSet === 'tools') {
    return requiredToolsPackageTools(target, runtimeDir);
  }
  return packagedRuntimeTools(target, runtimeDir);
}

export function requiredRuntimeMemberPaths(target, prefix) {
  return requiredRuntimeTools(target).map((tool) => `${prefix.replace(/\/+$/, '')}/${tool}`);
}

export function requiredToolsMemberPaths(target, prefix) {
  return requiredToolsPackageTools(target).map((tool) => `${prefix.replace(/\/+$/, '')}/${tool}`);
}

export function requiredCoreRuntimePaths(target, runtimeDir = null) {
  const moduleSuffix = isWindowsTarget(target, runtimeDir)
    ? '.dll'
    : target?.startsWith('macos-')
      ? '.dylib'
      : '.so';
  return [
    `lib/postgresql/dict_snowball${moduleSuffix}`,
    `lib/postgresql/plpgsql${moduleSuffix}`,
    'share/postgresql/extension/plpgsql--1.0.sql',
    'share/postgresql/extension/plpgsql.control',
    'share/postgresql/snowball_create.sql',
    ...SNOWBALL_STOPWORD_LANGUAGES.map(
      (language) => `share/postgresql/tsearch_data/${language}.stop`,
    ),
  ];
}

function runtimeDirFor(root) {
  for (const candidate of [join(root, 'runtime'), join(root, 'oliphaunt', 'runtime', 'files')]) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  if (
    isDirectory(join(root, 'bin')) &&
    (isDirectory(join(root, 'share')) || isDirectory(join(root, 'lib')))
  ) {
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
  return relative(from, to).split(sep).join('/');
}

function isDevRuntimeFile(relativePath, { windows }) {
  const name = relativePath.split('/').pop().toLowerCase();
  if (DEV_RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return windows && WINDOWS_DEV_RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function pruneTopLevelModuleDevFiles(root, { windows }) {
  const moduleDir = join(root, 'lib', 'modules');
  if (!isDirectory(moduleDir)) {
    return;
  }
  for (const path of walk(moduleDir)) {
    const relativePath = posixRelative(moduleDir, path);
    if (isDevRuntimeFile(relativePath, { windows })) {
      removePath(path);
    }
  }
  pruneEmptyDirs(moduleDir);
}

export function pruneRuntimePayload(root, target = null, { toolSet = 'packaged' } = {}) {
  const runtimeDir = runtimeDirFor(root);
  if (!runtimeDir) {
    return;
  }

  const windows = isWindowsTarget(target, runtimeDir);
  const requiredTools = new Set(runtimeToolsForSet(target, runtimeDir, toolSet));
  const binDir = join(runtimeDir, 'bin');
  if (isDirectory(binDir)) {
    for (const name of readdirSync(binDir).sort()) {
      const path = join(binDir, name);
      if (windows) {
        if (name.toLowerCase().endsWith('.exe') && !requiredTools.has(name)) {
          removePath(path);
        }
      } else if (!requiredTools.has(name)) {
        removePath(path);
      }
    }
  }

  if (toolSet === 'tools' && isDirectory(runtimeDir)) {
    for (const name of readdirSync(runtimeDir).sort()) {
      if (name !== 'bin' && name !== 'lib') {
        removePath(join(runtimeDir, name));
      }
    }
  }

  for (const relativePath of DEV_RUNTIME_DIRS) {
    removePath(join(runtimeDir, ...relativePath.split('/')));
  }

  for (const path of walk(runtimeDir, { includeDirs: true }).sort().reverse()) {
    if (isDirectory(path) && path.endsWith('.dSYM')) {
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
  pruneTopLevelModuleDevFiles(root, { windows });
}

function validateTopLevelModuleDevFiles(root, { windows }) {
  const errors = [];
  const moduleDir = join(root, 'lib', 'modules');
  if (!isDirectory(moduleDir)) {
    return errors;
  }
  for (const path of walk(moduleDir)) {
    const relativePath = posixRelative(moduleDir, path);
    if (isDevRuntimeFile(relativePath, { windows })) {
      errors.push(`${rel(path)} is a development-only native module file`);
    }
  }
  return errors;
}

function validateRuntimeTree(root, target, requireRuntime, { toolSet = 'packaged' } = {}) {
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
  const binDir = join(runtimeDir, 'bin');
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
        if (name.toLowerCase().endsWith('.exe') && !requiredTools.has(name)) {
          errors.push(`${rel(path)} is an extra Windows runtime executable`);
        }
      } else if (!requiredTools.has(name)) {
        errors.push(`${rel(path)} is an extra runtime tool`);
      }
    }
  }

  if (requireRuntime && toolSet !== 'tools') {
    for (const relativePath of requiredCoreRuntimePaths(target, runtimeDir)) {
      if (!isFile(join(runtimeDir, ...relativePath.split('/')))) {
        errors.push(`${rel(runtimeDir)} is missing required core runtime file ${relativePath}`);
      }
    }
  }

  if (toolSet === 'tools' && isDirectory(runtimeDir)) {
    const allowed = new Set([
      ...[...requiredTools].map((tool) => `bin/${tool}`),
      ...(windows ? WINDOWS_VC_RUNTIME_DLLS.map((name) => `bin/${name}`) : []),
      ...(windows ? [`bin/${WINDOWS_VC_RUNTIME_RECEIPT}`] : []),
    ]);
    for (const path of walk(runtimeDir)) {
      const relativePath = posixRelative(runtimeDir, path);
      const dependencyLibrary = windows
        ? /^bin\/[^/]+\.dll$/iu.test(relativePath)
        : /^lib\/[^/]+(?:\.so(?:\.[0-9]+)*|\.dylib)$/u.test(relativePath);
      if (!allowed.has(relativePath) && !dependencyLibrary) {
        errors.push(`${rel(path)} is not part of the native tools payload`);
      }
    }
  }

  for (const relativePath of DEV_RUNTIME_DIRS) {
    const path = join(runtimeDir, ...relativePath.split('/'));
    if (exists(path)) {
      errors.push(`${rel(path)} is a development-only runtime path`);
    }
  }

  for (const path of walk(runtimeDir, { includeDirs: true })) {
    if (isDirectory(path) && path.endsWith('.dSYM')) {
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

export function validatePayload(
  root,
  target = null,
  { requireRuntime = true, toolSet = 'packaged' } = {},
) {
  const runtimeDir = runtimeDirFor(root);
  const windows = isWindowsTarget(target, runtimeDir);
  const errors = [
    ...validateRuntimeTree(root, target, requireRuntime, { toolSet }),
    ...validateTopLevelModuleDevFiles(root, { windows }),
  ];
  if (windows && runtimeDir !== null && isDirectory(join(runtimeDir, 'bin'))) {
    const searchRoots = [join(runtimeDir, 'bin')];
    if (isFile(join(root, 'bin', 'oliphaunt.dll'))) {
      searchRoots.push(join(root, 'bin'));
    }
    try {
      verifyWindowsVcRuntimeClosure({
        root,
        searchRoots,
        profile: toolSet === 'tools' ? undefined : 'provider',
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
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
  { requireRuntime = true, toolSet = 'packaged' } = {},
) {
  pruneRuntimePayload(root, target, { toolSet });
  validatePayload(root, target, { requireRuntime, toolSet });
}

function usage() {
  return `Usage: runtimes/liboliphaunt-native/tools/native-runtime-payload.mts <root> [options]

Prune and validate liboliphaunt native runtime payloads.
The product packaging scripts strip binaries after pruning.

Options:
  --target <target>           Release target id.
  --check                     Validate without mutating the payload.
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
    allowMissingRuntime: false,
    toolSet: 'packaged',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) {
        fail('--target requires a value');
      }
      continue;
    }
    if (arg === '--check') {
      args.check = true;
      continue;
    }
    if (arg === '--allow-missing-runtime') {
      args.allowMissingRuntime = true;
      continue;
    }
    if (arg === '--tool-set') {
      args.toolSet = argv[++index];
      if (!['packaged', 'runtime', 'tools'].includes(args.toolSet)) {
        fail('--tool-set must be one of: packaged, runtime, tools');
      }
      continue;
    }
    if (arg.startsWith('-')) {
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
    requireRuntime: !args.allowMissingRuntime,
    toolSet: args.toolSet,
  });
}

if (import.meta.main) {
  main();
}
