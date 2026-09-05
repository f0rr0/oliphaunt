#!/usr/bin/env node

import { cpSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const JS_CORE_PACKAGE = "@oliphaunt/js-core";
export const JS_CORE_BUNDLE_FILES = Object.freeze([
  "README.md",
  "dist/commonjs/protocol.d.ts",
  "dist/commonjs/protocol.js",
  "dist/commonjs/query.d.ts",
  "dist/commonjs/query.js",
  "dist/module/package.json",
  "dist/module/protocol.d.ts",
  "dist/module/protocol.js",
  "dist/module/query.d.ts",
  "dist/module/query.js",
  "package.json",
]);

export function stageJsCoreBundle(packageDir, coreDir) {
  const packageRoot = requireDirectory(packageDir, "consumer package");
  const coreRoot = requireDirectory(coreDir, "shared JavaScript core package");
  const manifest = JSON.parse(readFileSync(path.join(coreRoot, "package.json"), "utf8"));
  if (
    manifest.name !== JS_CORE_PACKAGE
    || manifest.private !== true
    || manifest.version !== "0.0.0"
    || JSON.stringify(manifest.files) !== JSON.stringify(["dist/module", "dist/commonjs"])
  ) {
    throw new Error("shared JavaScript core must be the private, minimal 0.0.0 workspace package");
  }
  const destination = path.join(packageRoot, "node_modules", "@oliphaunt", "js-core");
  mkdirSync(destination, { recursive: true });
  for (const relative of JS_CORE_BUNDLE_FILES) {
    const source = path.join(coreRoot, relative);
    requireFile(source, `shared JavaScript core bundle member ${relative}`);
    const output = path.join(destination, relative);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(source, output, { errorOnExist: true, force: false });
  }
  return { destination, manifest };
}

export function assertJsCoreBundleInventory(paths, prefix = "node_modules/@oliphaunt/js-core/") {
  const actual = [...paths]
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .sort();
  const expected = [...JS_CORE_BUNDLE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`bundled ${JS_CORE_PACKAGE} inventory mismatch`);
  }
}

function requireDirectory(value, label) {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return resolved;
}

function requireFile(file, label) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real file: ${file}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [packageDir, coreDir, ...extra] = process.argv.slice(2);
  if (!packageDir || !coreDir || extra.length > 0) {
    throw new Error("usage: stage-package.mjs PACKAGE_DIR CORE_DIR");
  }
  stageJsCoreBundle(packageDir, coreDir);
}
