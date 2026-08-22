#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED = [
  'node_modules',
  'lib',
  '.build',
  'android/.gradle',
  'android/.cxx',
  'android/build',
];

export function reactNativePackageInputFingerprint({ root, rnDir, examplePackage }) {
  const files = [
    ...walk(rnDir),
    path.join(root, 'src/extensions/generated/sdk/extensions.json'),
    path.join(root, 'src/extensions/generated/sdk/ios-static-dependencies.json'),
    path.join(root, 'tools/dev/clean-package-lib.mjs'),
    ...(examplePackage ? [examplePackage] : []),
  ].sort(compare);
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = slash(path.relative(root, file));
    const stat = lstatSync(file);
    hash.update(`${relative}\0${stat.mode & 0o111 ? 'x' : '-'}\0`);
    if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(file)}`);
    else hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walk(root) {
  const files = [];
  visit(root, '');
  return files;

  function visit(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (isExcluded(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute);
    }
  }
}

function isExcluded(relative) {
  return EXCLUDED.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
}

function slash(value) {
  return value.split(path.sep).join('/');
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('usage: react-native-package-inputs.mjs --root <root> --rn-dir <dir> [--example-package <file>]');
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCli(process.argv.slice(2));
    console.log(
      reactNativePackageInputFingerprint({
        root: path.resolve(args.root),
        rnDir: path.resolve(args['rn-dir']),
        examplePackage: args['example-package'] ? path.resolve(args['example-package']) : undefined,
      }),
    );
  } catch (error) {
    console.error(`react-native-package-inputs.mjs: ${error.message}`);
    process.exitCode = 1;
  }
}
