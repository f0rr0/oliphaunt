#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  console.error(`write_checksum_manifest.mjs: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const patterns = [];
  let assetDir = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--asset-dir':
        assetDir = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--output':
        output = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--pattern':
        patterns.push(argv[index + 1] ?? '');
        index += 1;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!assetDir || !output || patterns.length === 0 || patterns.some((pattern) => pattern.length === 0)) {
    fail(
      'usage: tools/release/write_checksum_manifest.mjs --asset-dir <dir> --output <file> --pattern <glob> [--pattern <glob>...]',
    );
  }
  return {
    assetDir: path.resolve(assetDir),
    output,
    patterns,
  };
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function baseName(relativePath) {
  return relativePath.split(/[\\/]/u).pop();
}

async function matchingAssets(assetDir, patterns) {
  const assets = new Map();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const relativePath of glob.scan({ cwd: assetDir, onlyFiles: true })) {
      assets.set(baseName(relativePath), path.join(assetDir, relativePath));
    }
  }
  return [...assets.keys()].sort().map((name) => assets.get(name));
}

const args = parseArgs(Bun.argv.slice(2));
const outputPath = path.join(args.assetDir, args.output);
const lines = [];
for (const asset of await matchingAssets(args.assetDir, args.patterns)) {
  if (path.resolve(asset) === path.resolve(outputPath)) {
    continue;
  }
  lines.push(`${await sha256(asset)}  ${path.basename(asset)}\n`);
}
await fs.writeFile(outputPath, lines.join(''));
