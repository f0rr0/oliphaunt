import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '../..');

const PREFIX = 'SDK artifact staging';

export function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

export function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function requireFile(file) {
  if (!isFile(file)) {
    fail(`missing package-shape output: ${rel(file)}`);
  }
}

export function requireDir(file) {
  if (!isDirectory(file)) {
    fail(`missing package-shape output directory: ${rel(file)}`);
  }
}

export function copyDirContents(source, destination, { filter = () => true } = {}) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    cpSync(sourcePath, destinationPath, {
      recursive: true,
      filter,
    });
  }
}

export function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

export async function stageSdkArtifacts(product, stage) {
  const artifactRoot = path.join(ROOT, 'target/sdk-artifacts', product);
  const workRoot = path.join(ROOT, 'target/sdk-artifacts-work', product);
  for (const directory of [artifactRoot, workRoot]) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
  }
  await stage(artifactRoot, workRoot);
  writeSdkArtifactIndex(artifactRoot);
}

export function writeSdkArtifactIndex(artifactRoot) {
  const entries = readdirSync(artifactRoot)
    .sort()
    .map((name) => path.join(artifactRoot, name));
  if (!entries.length) throw new Error('No SDK artifacts were staged');
  const index = path.join(artifactRoot, 'artifacts.txt');
  writeFileSync(index, [...entries, index].sort().map(rel).join('\n') + '\n');
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('usage: staging.mts <artifact-root>');
  writeSdkArtifactIndex(path.resolve(process.argv[2]));
}
