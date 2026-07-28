#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function releaseAssetFiles(assetDir) {
  const files = [];
  const visit = (directory, segments) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      // Bun's filesystem globbing defaults to dot=false. Keep hidden files
      // and hidden directory subtrees outside the candidate set before using
      // its pure matcher so this replacement does not broaden release inputs.
      if (entry.name.startsWith('.')) {
        continue;
      }
      const nextSegments = [...segments, entry.name];
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, nextSegments);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: nextSegments.join('/'),
        });
      }
    }
  };
  visit(assetDir, []);
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

export function matchingAssets(assetDir, patterns) {
  const assets = new Map();
  const files = releaseAssetFiles(assetDir);
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    const explicitRelativePrefix = pattern.startsWith('./');
    for (const file of files) {
      const matchPath = explicitRelativePrefix ? `./${file.relativePath}` : file.relativePath;
      if (glob.match(matchPath)) {
        assets.set(baseName(file.relativePath), file.absolutePath);
      }
    }
  }
  return [...assets.keys()].sort(compareText).map((name) => assets.get(name));
}

async function main(argv) {
  const args = parseArgs(argv);
  const outputPath = path.join(args.assetDir, args.output);
  const lines = [];
  const assets = matchingAssets(args.assetDir, args.patterns);
  if (assets.length === 0) {
    fail(`no release assets found in ${args.assetDir} matching ${args.patterns.join(', ')}`);
  }
  for (const asset of assets) {
    if (path.resolve(asset) === path.resolve(outputPath)) {
      continue;
    }
    lines.push(`${await sha256(asset)}  ./${path.basename(asset)}\n`);
  }
  await fs.writeFile(outputPath, lines.join(''));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
