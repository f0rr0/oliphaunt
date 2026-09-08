#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
const nextExportRoot = path.join(docsRoot, 'out');
const generatedStaticRoot = path.join(repoRoot, 'target', 'docs', 'static');
const buildRoot = path.join(repoRoot, 'target', 'docs', 'build');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(nextExportRoot)) {
  fail('Next static export is missing; run next build before publishing docs output');
}

fs.rmSync(buildRoot, { force: true, recursive: true });
fs.mkdirSync(path.dirname(buildRoot), { recursive: true });
fs.cpSync(nextExportRoot, buildRoot, { force: true, recursive: true });

if (fs.existsSync(generatedStaticRoot)) {
  fs.cpSync(generatedStaticRoot, buildRoot, { force: true, recursive: true });
}

console.log(`published docs static export to ${path.relative(repoRoot, buildRoot)}`);
