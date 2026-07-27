#!/usr/bin/env bun
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  console.error(`merge-checksum-manifest.mjs: ${message}`);
  process.exit(1);
}

function parseManifest(path, text, entries) {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(stripped);
    if (match === null) {
      fail(`${path}: invalid checksum line ${lineNumber}: ${line}`);
    }
    const digest = match[1];
    const rawName = match[2].trim();
    const name = rawName.startsWith('./') ? rawName.slice(2) : rawName;
    if (name.length === 0 || name.includes('/')) {
      fail(`${path}: invalid checksum asset name on line ${lineNumber}: ${rawName}`);
    }
    const previous = entries.get(name);
    if (previous !== undefined && previous !== digest) {
      fail(`${path}: conflicting checksum for ${name}: ${previous} vs ${digest}`);
    }
    entries.set(name, digest);
  }
}

const [existing, incoming] = process.argv.slice(2);
if (existing === undefined || incoming === undefined) {
  fail('usage: merge-checksum-manifest.mjs <existing> <incoming>');
}

const entries = new Map();
parseManifest(existing, await readFile(existing, 'utf8'), entries);
parseManifest(incoming, await readFile(incoming, 'utf8'), entries);

const merged = [...entries]
  .sort(([left], [right]) => compareText(left, right))
  .map(([name, digest]) => `${digest}  ./${name}\n`)
  .join('');

const tempDir = mkdtempSync(join(dirname(existing), '.oliphaunt-checksums-'));
const tempPath = join(tempDir, 'checksums.sha256');
try {
  writeFileSync(tempPath, merged, { encoding: 'utf8' });
  renameSync(tempPath, existing);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
