#!/usr/bin/env node

import { cpSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JS_CORE_PACKAGE = '@oliphaunt/js-core';
export const JS_CORE_BUNDLE_FILES = Object.freeze([
  'README.md',
  'dist/commonjs/package.json',
  'dist/commonjs/protocol.d.ts',
  'dist/commonjs/protocol.js',
  'dist/commonjs/query.d.ts',
  'dist/commonjs/query.js',
  'dist/module/package.json',
  'dist/module/protocol.d.ts',
  'dist/module/protocol.js',
  'dist/module/query.d.ts',
  'dist/module/query.js',
  'package.json',
]);

export function stageJsCoreBundle(packageDir, coreDir) {
  const packageRoot = requireDirectory(packageDir, 'consumer package');
  const coreRoot = requireDirectory(coreDir, 'shared JavaScript core package');
  const manifest = JSON.parse(readFileSync(path.join(coreRoot, 'package.json'), 'utf8'));
  if (
    manifest.name !== JS_CORE_PACKAGE ||
    manifest.private !== true ||
    manifest.version !== '0.0.0' ||
    JSON.stringify(manifest.files) !== JSON.stringify(['dist/module', 'dist/commonjs'])
  ) {
    throw new Error('shared JavaScript core must be the private, minimal 0.0.0 workspace package');
  }

  const destination = path.join(packageRoot, 'node_modules', '@oliphaunt', 'js-core');
  if (pathExists(destination)) {
    throw new Error(`refusing to overwrite staged JavaScript core bundle: ${destination}`);
  }
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

export function assertJsCoreBundleInventory(paths, prefix = 'node_modules/@oliphaunt/js-core/') {
  const actual = [...paths]
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .sort(compareText);
  const expected = [...JS_CORE_BUNDLE_FILES].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `bundled ${JS_CORE_PACKAGE} inventory mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
    );
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

function pathExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const [command, packageDir, coreDir, ...extra] = process.argv.slice(2);
  if (command !== 'stage' || !packageDir || !coreDir || extra.length > 0) {
    throw new Error('usage: js-core-package.mjs stage PACKAGE_DIR CORE_DIR');
  }
  stageJsCoreBundle(packageDir, coreDir);
}
