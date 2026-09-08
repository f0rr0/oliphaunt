import { readFileSync } from 'node:fs';
import path from 'node:path';

const [beforeFile, repo] = process.argv.slice(2);
if (!beforeFile || !repo)
  throw new Error('usage: check_release_pr_coverage.mts BASE_MANIFEST REPO');
function readObject(file: string) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file} must be a JSON object`);
  return value;
}
const before = readObject(beforeFile);
const after = readObject(path.join(repo, '.release-please-manifest.json'));
for (const manifest of [before, after]) {
  if (Object.values(manifest).some((value) => typeof value !== 'string'))
    throw new Error('release manifests must map package paths to version strings');
}
const { packages } = readObject(path.join(repo, 'release-please-config.json'));
const products = Object.entries(packages)
  .flatMap(([packagePath, config]) => {
    const version = after[packagePath];
    if (
      before[packagePath] === version ||
      (before[packagePath] === undefined && version === '0.0.0')
    )
      return [];
    if (
      !config ||
      typeof config !== 'object' ||
      !('component' in config) ||
      typeof config.component !== 'string' ||
      !config.component
    )
      throw new Error(`${packagePath} has no release component`);
    return [config.component];
  })
  .sort();
if (new Set(products).size !== products.length)
  throw new Error('release components must be unique');
console.log(JSON.stringify(products));
