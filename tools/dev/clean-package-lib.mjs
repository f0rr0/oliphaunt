#!/usr/bin/env node

import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(process.argv[2] ?? process.cwd());
const output = path.join(packageRoot, 'lib');

if (packageRoot === path.parse(packageRoot).root) {
  throw new Error(`refusing to clean a filesystem root: ${packageRoot}`);
}
if (path.dirname(output) !== packageRoot || path.basename(output) !== 'lib') {
  throw new Error(`refusing to clean unexpected TypeScript output path ${output}`);
}
const rootStat = await lstat(packageRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error(`package root must be a real directory: ${packageRoot}`);
}
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJsonStat = await lstat(packageJsonPath);
if (!packageJsonStat.isFile() || packageJsonStat.isSymbolicLink()) {
  throw new Error(`package root must contain a real package.json: ${packageRoot}`);
}
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (
  packageJson.private === true ||
  typeof packageJson.name !== 'string' ||
  packageJson.name.length === 0
) {
  throw new Error(`package root must identify a publishable package: ${packageRoot}`);
}
await rm(output, { force: true, recursive: true });
